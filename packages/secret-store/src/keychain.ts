import { run } from "./exec.ts";
import { assertSafeName, type SecretStore, SecretStoreError } from "./types.ts";

const SECURITY = "/usr/bin/security";
const NOT_FOUND = 44;

/**
 * macOS Keychain through `/usr/bin/security`.
 *
 * Reads and deletes carry only the (non-secret) service/account in argv. Writes use
 * `security -i` so the password is delivered on stdin instead of `-w <password>` in argv.
 * Values are base64-encoded: this keeps them free of quoting/newline hazards in the
 * interactive command line and makes `find-generic-password -w` always print text.
 */
export function createKeychainStore(service: string): SecretStore {
	assertSafeName("service", service);
	return {
		backend: "macos-keychain",
		location: `macOS login keychain (service "${service}")`,
		async get(key) {
			assertSafeName("key", key);
			const res = await run(SECURITY, ["find-generic-password", "-a", key, "-s", service, "-w"]);
			if (res.code === NOT_FOUND) return null;
			if (res.code !== 0) throw new SecretStoreError(`Keychain read failed: ${firstLine(res.stderr)}`, "failed");
			return Buffer.from(res.stdout.trim(), "base64").toString("utf8");
		},
		async set(key, value) {
			assertSafeName("key", key);
			const encoded = Buffer.from(value, "utf8").toString("base64");
			const command = `add-generic-password -U -a "${key}" -s "${service}" -l "CL Agent Mesh" -w "${encoded}"\n`;
			const res = await run(SECURITY, ["-i"], { input: command });
			// In interactive mode `security` exits 0 even when a command fails; the failure is only printed.
			const combined = `${res.stdout}\n${res.stderr}`;
			if (res.code !== 0 || /returned \d+/.test(combined)) {
				throw new SecretStoreError(`Keychain write failed: ${firstLine(res.stderr || res.stdout)}`, "failed");
			}
		},
		async delete(key) {
			assertSafeName("key", key);
			const res = await run(SECURITY, ["delete-generic-password", "-a", key, "-s", service]);
			if (res.code !== 0 && res.code !== NOT_FOUND) {
				throw new SecretStoreError(`Keychain delete failed: ${firstLine(res.stderr)}`, "failed");
			}
		},
	};
}

function firstLine(text: string): string {
	return text.trim().split("\n")[0] ?? "unknown error";
}
