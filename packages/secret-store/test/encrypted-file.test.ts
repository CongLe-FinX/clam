import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEncryptedFileStore, createSecretStore, isPrivate } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "clam-secrets-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const make = () => createEncryptedFileStore({ dataDir: dir, service: "test-svc" });

describe("encrypted-file backend", () => {
	it("round-trips, overwrites and deletes", async () => {
		const s = make();
		expect(s.backend).toBe("encrypted-file");
		expect(await s.get("a")).toBeNull();
		await s.set("a", "gho_secret value ✓ \"quoted\"\nnewline");
		expect(await s.get("a")).toBe("gho_secret value ✓ \"quoted\"\nnewline");
		await s.set("a", "second");
		expect(await s.get("a")).toBe("second");
		await s.delete("a");
		expect(await s.get("a")).toBeNull();
		await s.delete("a"); // idempotent
	});

	it("persists across instances and never stores plaintext", async () => {
		await make().set("k", "plaintext-token-123");
		expect(await make().get("k")).toBe("plaintext-token-123");
		const raw = await readFile(join(dir, "secrets", "secrets.enc.json"), "utf8");
		expect(raw).not.toContain("plaintext-token-123");
	});

	it("uses private permissions", async () => {
		await make().set("k", "v");
		expect(await isPrivate(join(dir, "secrets"))).toBe(true);
		expect(await isPrivate(join(dir, "secrets", "master.key"))).toBe(true);
		expect(await isPrivate(join(dir, "secrets", "secrets.enc.json"))).toBe(true);
		expect((await stat(join(dir, "secrets", "master.key"))).size).toBe(32);
	});

	it("detects ciphertext tampering", async () => {
		await make().set("k", "v-original");
		const path = join(dir, "secrets", "secrets.enc.json");
		const file = JSON.parse(await readFile(path, "utf8"));
		const ct = Buffer.from(file.entries.k.ct, "base64");
		ct[0] = (ct[0] ?? 0) ^ 0xff;
		file.entries.k.ct = ct.toString("base64");
		await writeFile(path, JSON.stringify(file));
		await expect(make().get("k")).rejects.toMatchObject({ code: "corrupted" });
	});

	it("binds ciphertext to its key name (entry swap is detected)", async () => {
		const s = make();
		await s.set("a", "aaa");
		await s.set("b", "bbb");
		const path = join(dir, "secrets", "secrets.enc.json");
		const file = JSON.parse(await readFile(path, "utf8"));
		file.entries.b = file.entries.a;
		await writeFile(path, JSON.stringify(file));
		await expect(make().get("b")).rejects.toMatchObject({ code: "corrupted" });
	});

	it("rejects a replaced master key and a garbage store file", async () => {
		await make().set("k", "v");
		await writeFile(join(dir, "secrets", "master.key"), Buffer.alloc(32, 7));
		await expect(make().get("k")).rejects.toMatchObject({ code: "corrupted" });
		await writeFile(join(dir, "secrets", "secrets.enc.json"), "not json");
		await expect(make().get("k")).rejects.toMatchObject({ code: "corrupted" });
	});

	it("serializes concurrent writes", async () => {
		const s = make();
		await Promise.all(Array.from({ length: 25 }, (_, i) => s.set(`k${i}`, `v${i}`)));
		for (let i = 0; i < 25; i++) expect(await s.get(`k${i}`)).toBe(`v${i}`);
	});

	it("rejects unsafe key names", async () => {
		await expect(make().set('a"b', "v")).rejects.toThrow(/Invalid secret key/);
	});

	it("createSecretStore honours a forced encrypted-file backend", async () => {
		const s = await createSecretStore({ dataDir: dir, backend: "encrypted-file" });
		expect(s.backend).toBe("encrypted-file");
		expect(s.location).toContain(dir);
	});
});
