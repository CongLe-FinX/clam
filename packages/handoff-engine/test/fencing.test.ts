import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadOrCreateIdentity } from "@clam/node-identity";
import {
	checkEpoch,
	checkHandoffEpochs,
	fencingMessage,
	makeFencingToken,
	parseFencingToken,
	verifyFencingToken,
} from "../src/index.ts";
import { SHA } from "./helpers.ts";

const dirs: string[] = [];
function identity() {
	const dir = mkdtempSync(join(tmpdir(), "clam-fence-"));
	dirs.push(dir);
	return loadOrCreateIdentity({ dataDir: dir });
}
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("fencing tokens", () => {
	const target = identity();
	const input = { taskId: "task_01", epoch: 1, handoffId: "hnd_01", manifestSha256: SHA };
	const token = makeFencingToken({ ...input, sign: (m) => target.sign(m) });
	const opts = { publicKey: target.publicKey, handoffId: "hnd_01", manifestSha256: SHA };

	it("has the shape <taskId>:<epoch>:<sig> and verifies with the target's key", () => {
		expect(token).toMatch(/^task_01:1:[A-Za-z0-9_-]{86}$/);
		expect(verifyFencingToken(token, opts)).toEqual({ ok: true, taskId: "task_01", epoch: 1 });
		expect(verifyFencingToken(token, { ...opts, taskId: "task_01", epoch: 1 }).ok).toBe(true);
	});

	it("accepts a raw-bytes signer (agent-network Signer style) and a base64url public key", () => {
		const t = makeFencingToken({ ...input, sign: (m) => Buffer.from(target.sign(m), "base64") });
		expect(t).toBe(token); // Ed25519 is deterministic
		const urlKey = Buffer.from(target.publicKey, "base64").toString("base64url");
		expect(verifyFencingToken(t, { ...opts, publicKey: urlKey }).ok).toBe(true);
	});

	it("rejects tampering with epoch, task, handoff, hash, signature and key", () => {
		const [taskId, epoch, sig] = token.split(":") as [string, string, string];
		expect(verifyFencingToken(`${taskId}:2:${sig}`, opts)).toEqual({ ok: false, reason: "bad_signature" });
		expect(verifyFencingToken(`task_02:${epoch}:${sig}`, opts)).toEqual({ ok: false, reason: "bad_signature" });
		expect(verifyFencingToken(token, { ...opts, handoffId: "hnd_02" })).toEqual({ ok: false, reason: "bad_signature" });
		expect(verifyFencingToken(token, { ...opts, manifestSha256: "b".repeat(64) })).toEqual({ ok: false, reason: "bad_signature" });
		const flipped = `${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`;
		expect(verifyFencingToken(`${taskId}:${epoch}:${flipped}`, opts).ok).toBe(false);
		expect(verifyFencingToken(token, { ...opts, publicKey: identity().publicKey })).toEqual({ ok: false, reason: "bad_signature" });
	});

	it("rejects malformed tokens and expectation mismatches", () => {
		for (const bad of ["", "nope", "a:b:c", "task_01:1:", "task_01:x:AAAAAAAAAAAAAAAAAAAA", ":1:AAAAAAAAAAAAAAAAAAAA"]) {
			expect(verifyFencingToken(bad, opts)).toEqual({ ok: false, reason: "malformed" });
		}
		expect(verifyFencingToken(token, { ...opts, epoch: 2 })).toEqual({ ok: false, reason: "mismatch" });
		expect(verifyFencingToken(token, { ...opts, taskId: "other" })).toEqual({ ok: false, reason: "mismatch" });
	});

	it("supports task ids containing ':' and refuses '|' in signed parts", () => {
		const t = makeFencingToken({ ...input, taskId: "ns:task:7", sign: (m) => target.sign(m) });
		expect(parseFencingToken(t)).toMatchObject({ taskId: "ns:task:7", epoch: 1 });
		expect(verifyFencingToken(t, opts).ok).toBe(true);
		expect(() => fencingMessage({ ...input, taskId: "a|b" })).toThrow();
		expect(() => fencingMessage({ ...input, epoch: -1 })).toThrow();
	});

	it("signs exactly taskId|epoch|handoffId|manifestSha256", () => {
		expect(fencingMessage(input)).toBe(`task_01|1|hnd_01|${SHA}`);
	});
});

describe("checkEpoch", () => {
	it("ok / stale / ahead", () => {
		expect(checkEpoch(3, 3)).toBe("ok");
		expect(checkEpoch(2, 3)).toBe("stale");
		expect(checkEpoch(4, 3)).toBe("ahead");
		expect(checkEpoch(0, 0)).toBe("ok");
	});

	it("handoff step-1 epoch check: increment by one against the known epoch", () => {
		expect(checkHandoffEpochs(0, 1, null)).toEqual({ ok: true });
		expect(checkHandoffEpochs(2, 3, 2)).toEqual({ ok: true });
		expect(checkHandoffEpochs(2, 4, 2)).toMatchObject({ ok: false, reason: "bad_increment" });
		expect(checkHandoffEpochs(1, 2, 2)).toMatchObject({ ok: false, reason: "stale_epoch", knownEpoch: 2 });
		expect(checkHandoffEpochs(3, 4, 2)).toMatchObject({ ok: false, reason: "epoch_ahead" });
	});
});
