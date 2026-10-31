import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type GitEngine, initClmesh, scanForSecrets } from "../src/index.ts";
import { newEngine, sh, tmpRoot } from "./helpers.ts";

const rules = (text: string, path = "notes.md") => scanForSecrets(text, path).map((f) => f.rule);

describe("scanForSecrets", () => {
	const positives: Array<[string, string, string]> = [
		["github-token", "const t = 'ghp_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb3d';", "ghp_Ab3d"],
		["github-token", "GITHUB=gho_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb3d", "gho_Ab3d"],
		["github-fine-grained-token", "github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJ", "github_pat_"],
		["aws-access-key-id", "key = AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
		["aws-secret-access-key", 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"', "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
		["private-key-block", "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----"],
		["private-key-block", "-----BEGIN OPENSSH PRIVATE KEY-----", "OPENSSH"],
		["slack-token", "SLACK=xoxb-123456789012-abcdefghijklmnop", "xoxb-1234567890"],
		["slack-webhook", "https://hooks.slack.com/services/T01234567/B01234567/abcdefghijklmnopqrstuvwx", "abcdefghijklmnopqrstuvwx"],
		["stripe-key", "STRIPE=sk_live_4eC39HqLyjWDarjtT1zdp7dc", "4eC39HqLyjWDarjtT1zdp7dc"],
		["anthropic-api-key", "ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
		["openai-api-key", "OPENAI=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd"],
		["google-api-key", "AIzaSyA1234567890abcdefghijklmnopqrstuv", "A1234567890abcdefghijklmnopqrstuv"],
		["npm-token", "//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijklmnopqrstuvwxyz0123456789"],
		["generic-secret-assignment", 'password = "hunter2hunter2"', "hunter2hunter2"],
		["generic-secret-assignment", '{ "client_secret": "s3cr3t-value-123" }', "s3cr3t-value-123"],
		["generic-secret-assignment", "API_KEY: abcd1234efgh5678", "abcd1234efgh5678"],
		["url-credentials", "git clone https://alice:p4ssw0rd9@example.com/x.git", "p4ssw0rd9"],
		["bearer-token", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", "abcdefghijklmnopqrstuvwxyz012345"],
		["high-entropy-string", "blob: Zk3pQ9xV7mB2nR8tY5wL1cH6jD4sG0aF9eU3iO7kP2q", "Zk3pQ9xV7mB2nR8tY5wL1cH6jD4sG0aF9eU3iO7kP2q"],
	];
	for (const [rule, line, secret] of positives) {
		it(`detects ${rule}: ${line.slice(0, 40)}…`, () => {
			const hits = scanForSecrets(`line one\n${line}\n`, "config.txt");
			expect(hits.map((h) => h.rule)).toContain(rule);
			expect(hits.find((h) => h.rule === rule)?.line).toBe(2);
			for (const h of hits) {
				// The excerpt must never contain the secret value itself.
				expect(h.excerpt).not.toContain(secret.length > 12 ? secret : "\u0000never");
				expect(h.excerpt).toContain("[redacted");
			}
		});
	}

	const negatives: Array<[string, string]> = [
		["git sha", "commit 0123456789abcdef0123456789abcdef01234567"],
		["sha256 digest", '{ "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }'],
		["uuid", "id: 123e4567-e89b-12d3-a456-426614174000"],
		["camelCase identifier", "const thisIsAVeryLongDescriptiveIdentifierNameForTheThing = 1;"],
		["file path", "see packages/git-engine/src/engine/internal/helpers/long-name-file.ts for details"],
		["env placeholder", "password = process.env.DB_PASSWORD"],
		["template placeholder", 'token: "${GITHUB_TOKEN}"'],
		["type annotation", "token: string;"],
		["example", "password = <your-password-here>"],
		["max_tokens", '"max_tokens": 4096000000'],
		["function call", "const secret = getSecretFromVault(name);"],
		["kebab slug", "slug: this-is-a-fairly-long-kebab-case-slug-for-a-document-title"],
		["prose", "Never commit a password or a token; use the secret store instead."],
		["url without credentials", "https://github.com/octo/hello.git"],
		["short hash", "short sha abcdef1"],
	];
	for (const [name, line] of negatives) {
		it(`does not flag ${name}`, () => expect(scanForSecrets(line, "doc.md")).toEqual([]));
	}

	it("reports 1-based lines, handles CRLF, and skips entropy checks for lockfiles", () => {
		const hits = scanForSecrets("a\r\nb\r\nghp_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb3d\r\n", "x.txt");
		expect(hits).toHaveLength(1);
		expect(hits[0]?.line).toBe(3);
		const lock = 'resolved "https://registry/x.tgz" integrity "Zk3pQ9xV7mB2nR8tY5wL1cH6jD4sG0aF9eU3iO7kP2q"';
		expect(rules(lock, "package-lock.json")).toEqual([]);
		expect(rules(lock, "other.txt")).toContain("high-entropy-string");
	});
});

describe("initClmesh", () => {
	let engine: GitEngine;
	beforeAll(async () => {
		engine = await newEngine(tmpRoot());
	});
	const ids = { workspaceId: "ws_1", projectId: "prj_1", projectName: "Demo Project" };

	it("writes README.md and config.json with sorted keys, never commits, then skips existing files", async () => {
		const dir = tmpRoot();
		sh(dir, "init", "-q", "-b", "main");
		const first = await initClmesh(engine, dir, ids);
		expect(first).toEqual({ written: [".clmesh/README.md", ".clmesh/config.json"], skipped: [] });
		expect(readFileSync(join(dir, ".clmesh/config.json"), "utf8")).toBe('{\n  "projectId": "prj_1",\n  "schema": 1,\n  "version": 1,\n  "workspaceId": "ws_1"\n}\n');
		expect(readFileSync(join(dir, ".clmesh/README.md"), "utf8")).toContain("Demo Project");
		expect(() => sh(dir, "rev-parse", "--verify", "-q", "HEAD")).toThrow(); // nothing was committed
		expect((await engine.status(dir)).files.map((f) => f.path).sort()).toEqual([".clmesh/README.md", ".clmesh/config.json"]);

		writeFileSync(join(dir, ".clmesh/config.json"), '{"edited":true}\n');
		const second = await initClmesh(engine, dir, ids);
		expect(second).toEqual({ written: [], skipped: [".clmesh/README.md", ".clmesh/config.json"] });
		expect(readFileSync(join(dir, ".clmesh/config.json"), "utf8")).toBe('{"edited":true}\n');
	});

	it("refuses (secret_detected) when generated content would contain a secret and writes nothing", async () => {
		const dir = tmpRoot();
		sh(dir, "init", "-q", "-b", "main");
		await expect(initClmesh(engine, dir, { ...ids, projectName: "ghp_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb3d" })).rejects.toMatchObject({ code: "secret_detected" });
		expect(existsSync(join(dir, ".clmesh"))).toBe(false);
		await expect(initClmesh(engine, dir, { ...ids, workspaceId: "AKIAIOSFODNN7EXAMPLE" })).rejects.toMatchObject({ code: "secret_detected" });
		expect(existsSync(join(dir, ".clmesh"))).toBe(false);
	});

	it("requires a repository root and a plain .clmesh directory", async () => {
		const notRepo = tmpRoot();
		await expect(initClmesh(engine, notRepo, ids)).rejects.toMatchObject({ code: "not_a_repo" });
		const dir = tmpRoot();
		sh(dir, "init", "-q", "-b", "main");
		const elsewhere = tmpRoot();
		symlinkSync(elsewhere, join(dir, ".clmesh"));
		await expect(initClmesh(engine, dir, ids)).rejects.toMatchObject({ code: "failed" });
		expect(existsSync(join(elsewhere, "config.json"))).toBe(false);
	});
});
