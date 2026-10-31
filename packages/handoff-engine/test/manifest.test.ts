import { describe, expect, it } from "vitest";
import {
	assertSecretFree,
	canonicalJson,
	HandoffManifest,
	manifestSha256,
	scanManifestForSecrets,
	SecretDetectedError,
	sealManifest,
	verifyReceivedManifest,
} from "../src/index.ts";
import { COMMIT, manifestInput, SHA } from "./helpers.ts";

const GH_TOKEN = "ghp_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb3d";

describe("canonical JSON + hash", () => {
	it("sorts keys at every depth, no whitespace, omits undefined", () => {
		expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null }, u: undefined })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
	});

	it("hash is stable across key order and changes with content", () => {
		const a = { x: 1, y: { p: "q", r: [1, 2] } };
		const b = { y: { r: [1, 2], p: "q" }, x: 1 };
		expect(manifestSha256(a)).toBe(manifestSha256(b));
		expect(manifestSha256(a)).toMatch(/^[0-9a-f]{64}$/);
		expect(manifestSha256({ ...a, x: 2 })).not.toBe(manifestSha256(a));
		expect(manifestSha256([1, 2])).not.toBe(manifestSha256([2, 1]));
	});

	it("rejects non-finite numbers", () => {
		expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
	});

	it("sealed manifest hash is independent of the input key order", () => {
		const input = manifestInput();
		const reversed = Object.fromEntries(Object.entries(input).reverse());
		const a = sealManifest(input);
		const b = sealManifest(reversed);
		expect(a.ok && b.ok).toBe(true);
		if (a.ok && b.ok) expect(a.sha256).toBe(b.sha256);
	});
});

describe("manifest schema", () => {
	it("accepts files / none / git variants", () => {
		expect(sealManifest(manifestInput()).ok).toBe(true);
		expect(sealManifest(manifestInput({ vcs: "none", files: null })).ok).toBe(true);
		const git = {
			vcs: "git",
			files: null,
			git: { repoUrl: "https://github.com/acme/app.git", branch: "clam/alpha/t1", commit: COMMIT, baseBranch: "main", pushed: true },
		};
		expect(sealManifest(manifestInput(git)).ok).toBe(true);
	});

	it("an empty research folder yields a valid manifest with an empty environment", () => {
		const env = { os: null, arch: null, runtimes: [], packageManager: null, requiredEnvVars: [], setupCommands: [], checkCommand: null };
		const r = sealManifest(manifestInput({ vcs: "none", files: null, environment: env, requiredFiles: [], contexts: [] }));
		expect(r.ok).toBe(true);
	});

	it.each([
		["vcs=git without git", { vcs: "git", files: null }],
		["vcs=files without bundle", { files: null }],
		["vcs=none with a bundle", { vcs: "none" }],
		["toEpoch != fromEpoch+1", { toEpoch: 5 }],
		["same source and target node", { target: { nodeId: "node_a", name: "alpha", fingerprint: "x", agentId: null } }],
		["absolute required file", { requiredFiles: ["/etc/passwd"] }],
		["traversal required file", { requiredFiles: ["../secret"] }],
		["bad env var name", { environment: { ...manifestInput().environment, requiredEnvVars: ["TOKEN=abc"] } }],
		["setup command with URL credentials", { environment: { ...manifestInput().environment, setupCommands: ["git clone https://bob:hunter22hunter@example.com/r.git"] } }],
		["unpushed git without patch", { vcs: "git", files: null, git: { repoUrl: "https://x.test/r.git", branch: "b", commit: COMMIT, baseBranch: "main", pushed: false } }],
		["repo url with credentials", { vcs: "git", files: null, git: { repoUrl: "https://bob:pw@x.test/r.git", branch: "b", commit: COMMIT, baseBranch: "main", pushed: true } }],
		["bad sha256", { files: { artifactId: "a", sha256: "nope", size: 1, fileCount: 1 } }],
	])("rejects %s", (_name, overrides) => {
		expect(HandoffManifest.safeParse(manifestInput(overrides)).success).toBe(false);
	});

	it("accepts an unpushed git commit when a patch artifact is present", () => {
		const git = {
			repoUrl: "git@github.com:acme/app.git",
			branch: "b",
			commit: COMMIT,
			baseBranch: "main",
			pushed: false,
			patchArtifact: { artifactId: "art_p", sha256: SHA, size: 10, baseCommit: COMMIT, files: ["src/a.ts"] },
		};
		expect(sealManifest(manifestInput({ vcs: "git", files: null, git })).ok).toBe(true);
	});
});

describe("secret scan", () => {
	it("blocks a manifest whose summary contains a token, without echoing it", () => {
		const input = manifestInput({ conversationSummary: { text: `use ${GH_TOKEN} to push`, generatedBy: "clam", scanned: true } });
		const r = sealManifest(input);
		expect(r.ok).toBe(false);
		if (!r.ok && r.code === "secret_detected") {
			expect(r.findings[0]).toMatchObject({ rule: "github-token", path: "$.conversationSummary.text", line: 1 });
			expect(JSON.stringify(r.findings)).not.toContain(GH_TOKEN);
		} else throw new Error("expected secret_detected");
	});

	it("finds secrets in nested strings, arrays and setup commands", () => {
		const env = { ...manifestInput().environment, setupCommands: ["export AWS=AKIAIOSFODNN7EXAMPLE"] };
		const findings = scanManifestForSecrets({ a: { b: [{ c: "-----BEGIN RSA PRIVATE KEY-----" }] }, environment: env });
		expect(findings.map((f) => f.rule).sort()).toEqual(["aws-access-key-id", "private-key-block"]);
		expect(findings.map((f) => f.path)).toContain("$.environment.setupCommands[0]");
	});

	it("detects api_key assignments and slack tokens", () => {
		expect(scanManifestForSecrets({ t: 'api_key = "9f8e7d6c5b4a39281716"' }).length).toBeGreaterThan(0);
		expect(scanManifestForSecrets({ t: "xoxb-1234567890-abcdefghij" }).map((f) => f.rule)).toContain("slack-token");
	});

	it("assertSecretFree throws SecretDetectedError and passes clean manifests", () => {
		expect(() => assertSecretFree({ s: GH_TOKEN })).toThrow(SecretDetectedError);
		const sealed = sealManifest(manifestInput());
		expect(sealed.ok).toBe(true);
		expect(() => assertSecretFree(manifestInput())).not.toThrow();
	});

	it("does not flag hashes, commits, fingerprints or ids", () => {
		expect(scanManifestForSecrets(manifestInput())).toEqual([]);
	});
});

describe("verifyReceivedManifest", () => {
	const now = Date.parse("2026-01-01T10:05:00.000Z");
	const sealed = sealManifest(manifestInput());
	if (!sealed.ok) throw new Error("fixture");
	const raw = JSON.parse(sealed.canonical) as unknown;

	it("accepts the sealed document", () => {
		const r = verifyReceivedManifest(raw, { expectedSha256: sealed.sha256, selfNodeId: "node_b", now });
		expect(r.ok).toBe(true);
	});

	it("rejects hash mismatch, wrong target, expiry and bad schema", () => {
		expect(verifyReceivedManifest(raw, { expectedSha256: SHA, selfNodeId: "node_b", now })).toMatchObject({ ok: false, code: "hash_mismatch" });
		expect(verifyReceivedManifest(raw, { expectedSha256: sealed.sha256, selfNodeId: "node_c", now })).toMatchObject({ ok: false, code: "wrong_target" });
		expect(verifyReceivedManifest(raw, { expectedSha256: sealed.sha256, selfNodeId: "node_b", now: now + 3_600_000 })).toMatchObject({ ok: false, code: "expired" });
		expect(verifyReceivedManifest({ nope: 1 }, { expectedSha256: sealed.sha256, selfNodeId: "node_b", now })).toMatchObject({ ok: false, code: "manifest_invalid" });
	});

	it("rejects a tampered document even with a recomputed schema-valid shape", () => {
		const tampered = { ...(raw as Record<string, unknown>), workspaceId: "ws_evil" };
		expect(verifyReceivedManifest(tampered, { expectedSha256: sealed.sha256, selfNodeId: "node_b", now })).toMatchObject({ ok: false, code: "hash_mismatch" });
	});

	it("rejects a received manifest that carries a secret (hash valid)", () => {
		const bad = JSON.parse(canonicalJson({ ...(raw as Record<string, unknown>), conversationSummary: { text: GH_TOKEN, generatedBy: "clam", scanned: true } })) as unknown;
		expect(verifyReceivedManifest(bad, { expectedSha256: manifestSha256(bad), selfNodeId: "node_b", now })).toMatchObject({ ok: false, code: "secret_detected" });
	});
});

describe("what the new executor needs to continue a delegated task (M7 additions)", () => {
	it("defaults the delegation fields so older documents still parse", () => {
		const sealed = sealManifest(manifestInput());
		expect(sealed.ok).toBe(true);
		if (!sealed.ok) return;
		expect(sealed.manifest.task).toMatchObject({ sender: null, constraints: {}, taskCorrelationId: null, lastEventSeq: 0, repo: null, thread: [] });
		expect(sealed.manifest.files?.base).toBeNull();
	});

	it("carries the sender, constraints, timeline seal, thread and the base manifest, and hashes them", () => {
		const input = manifestInput();
		const task = {
			...(input.task as object),
			sender: { nodeId: "node_s", nodeName: "sender", agentId: "agent_s", agentName: "Sender Agent" },
			constraints: { maxCostUsd: 2 },
			taskCorrelationId: "cor_task",
			lastEventSeq: 7,
			repo: { url: "https://github.com/acme/demo", branch: "main", commit: null },
			thread: [{ id: "msg_1", authorKind: "human", authorNodeId: "node_s", authorNodeName: "sender", kind: "instruction", text: "please add tests", createdAt: "2026-01-01T09:00:00.000Z" }],
		};
		const files = { artifactId: "art_files", sha256: SHA, size: 1234, fileCount: 3, base: { artifactId: "art_base", sha256: SHA, size: 99 } };
		const first = sealManifest({ ...input, task, files });
		const second = sealManifest({ ...input, task: { ...task, lastEventSeq: 8 }, files });
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.manifest.task.thread[0]).toMatchObject({ id: "msg_1", authorAgentId: null });
		expect(first.manifest.files?.base?.artifactId).toBe("art_base");
		expect(first.sha256).not.toBe(second.sha256);
	});

	it("a secret in the discussion thread blocks the handoff", () => {
		const input = manifestInput();
		const task = { ...(input.task as object), thread: [{ id: "msg_1", authorKind: "human", authorNodeId: "node_s", authorNodeName: "sender", kind: "note", text: "key: ghp_abcdefghijklmnopqrstuvwxyz0123456789", createdAt: "2026-01-01T09:00:00.000Z" }] };
		const sealed = sealManifest({ ...input, task });
		expect(sealed.ok).toBe(false);
		if (!sealed.ok) expect(sealed.code).toBe("secret_detected");
	});
});
