import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprintOfPublicKey, loadOrCreateIdentity, verifySignature } from "../src/index.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "clam-id-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("node identity", () => {
	it("creates an Ed25519 keypair on first boot with a 0600 private key and reuses it afterwards", () => {
		const first = loadOrCreateIdentity({ dataDir: dir });
		expect(first.created).toBe(true);
		if (process.platform !== "win32") {
			expect(statSync(join(dir, "identity", "ed25519.key")).mode & 0o777).toBe(0o600);
			expect(statSync(join(dir, "identity")).mode & 0o777).toBe(0o700);
		}
		const second = loadOrCreateIdentity({ dataDir: dir });
		expect(second.created).toBe(false);
		expect(second.fingerprint).toBe(first.fingerprint);
		expect(second.nodeId).toBe(first.nodeId);
		expect(second.publicKey).toBe(first.publicKey);
	});

	it("derives fingerprint = sha256(raw public key) hex and the node id from it", () => {
		const id = loadOrCreateIdentity({ dataDir: dir });
		const raw = Buffer.from(id.publicKey, "base64");
		expect(raw.length).toBe(32);
		expect(id.fingerprint).toBe(createHash("sha256").update(raw).digest("hex"));
		expect(id.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(id.nodeId).toBe(`node_${id.fingerprint.slice(0, 16)}`);
		expect(fingerprintOfPublicKey(id.publicKey)).toBe(id.fingerprint);
	});

	it("signs and verifies; rejects tampering, wrong keys and malformed input", () => {
		const id = loadOrCreateIdentity({ dataDir: dir });
		const other = loadOrCreateIdentity({ dataDir: join(dir, "other") });
		const signature = id.sign("hello mesh");
		expect(verifySignature({ publicKey: id.publicKey, message: "hello mesh", signature })).toBe(true);
		expect(verifySignature({ publicKey: id.publicKey, message: new TextEncoder().encode("hello mesh"), signature })).toBe(true);
		expect(verifySignature({ publicKey: id.publicKey, message: "hello mesh!", signature })).toBe(false);
		expect(verifySignature({ publicKey: other.publicKey, message: "hello mesh", signature })).toBe(false);
		expect(verifySignature({ publicKey: "not-a-key", message: "x", signature })).toBe(false);
		expect(verifySignature({ publicKey: id.publicKey, message: "x", signature: "AAAA" })).toBe(false);
	});

	it("tightens a loose private key mode on load", () => {
		if (process.platform === "win32") return;
		const id = loadOrCreateIdentity({ dataDir: dir });
		const keyPath = join(id.identityDir, "ed25519.key");
		writeFileSync(keyPath, readFileSync(keyPath), { mode: 0o644 });
		loadOrCreateIdentity({ dataDir: dir });
		expect(statSync(keyPath).mode & 0o777).toBe(0o600);
	});
});
