import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecretStore } from "../src/index.ts";

let dir: string;
const savedEnv = process.env.CLAM_SECRET_BACKEND;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "clam-secrets-pin-"));
	delete process.env.CLAM_SECRET_BACKEND;
});
afterEach(async () => {
	if (savedEnv === undefined) delete process.env.CLAM_SECRET_BACKEND;
	else process.env.CLAM_SECRET_BACKEND = savedEnv;
	await rm(dir, { recursive: true, force: true });
});

const pin = async (value: string) => {
	await mkdir(join(dir, "secrets"), { recursive: true, mode: 0o700 });
	await writeFile(join(dir, "secrets", "backend"), `${value}\n`, { mode: 0o600 });
};

describe("backend pinning (auto mode)", () => {
	it("keeps using the pinned encrypted file, so secrets stored earlier are still found", async () => {
		await pin("encrypted-file");
		const first = await createSecretStore({ dataDir: dir, service: "pin-test" });
		expect(first.backend).toBe("encrypted-file");
		await first.set("github.token.x", "gho_value");
		const again = await createSecretStore({ dataDir: dir, service: "pin-test" });
		expect(again.backend).toBe("encrypted-file");
		expect(await again.get("github.token.x")).toBe("gho_value");
	});

	it("refuses to start on another store when the pinned OS store is unusable, instead of hiding every secret", async () => {
		// libsecret is never usable on macOS / Windows, and on Linux only with secret-tool + a keyring.
		const unusable = process.platform === "darwin" || process.platform === "win32" ? "libsecret" : "macos-keychain";
		await pin(unusable);
		await expect(createSecretStore({ dataDir: dir, service: "pin-test", pinRetryDelaysMs: [1, 1] })).rejects.toThrow(
			new RegExp(`keeps its secrets in ${unusable}`),
		);
	});

	it("rejects an unrecognised pin instead of guessing", async () => {
		await pin("floppy-disk");
		await expect(createSecretStore({ dataDir: dir, service: "pin-test" })).rejects.toThrow(/Unrecognised secret store "floppy-disk"/);
	});

	it("a forced backend wins over the pin and does not rewrite it", async () => {
		await pin("libsecret");
		const store = await createSecretStore({ dataDir: dir, service: "pin-test", backend: "encrypted-file" });
		expect(store.backend).toBe("encrypted-file");
		const mode = (await stat(join(dir, "secrets", "backend"))).mode & 0o777;
		expect(mode).toBe(0o600);
	});
});
