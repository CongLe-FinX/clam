import { run } from "./exec.ts";
import { assertSafeName, type SecretStore, SecretStoreError } from "./types.ts";

/**
 * Linux Secret Service (GNOME Keyring, KWallet) via `secret-tool`.
 * `secret-tool store` reads the secret from stdin, so it never appears in argv.
 */
export function createLibsecretStore(service: string): SecretStore {
	assertSafeName("service", service);
	return {
		backend: "libsecret",
		location: `Secret Service keyring (service "${service}")`,
		async get(key) {
			assertSafeName("key", key);
			const res = await run("secret-tool", ["lookup", "service", service, "account", key]);
			if (res.code === 0 && res.stdout.length > 0) return res.stdout;
			// `lookup` exits 1 with empty output when no item matches.
			if (res.code === 1 && res.stderr.trim() === "") return null;
			if (res.code === 0) return null;
			throw new SecretStoreError(`Secret Service read failed: ${res.stderr.trim()}`, "failed");
		},
		async set(key, value) {
			assertSafeName("key", key);
			const res = await run(
				"secret-tool",
				["store", "--label=CL Agent Mesh", "service", service, "account", key],
				{ input: value },
			);
			if (res.code !== 0) throw new SecretStoreError(`Secret Service write failed: ${res.stderr.trim()}`, "failed");
		},
		async delete(key) {
			assertSafeName("key", key);
			const res = await run("secret-tool", ["clear", "service", service, "account", key]);
			if (res.code !== 0 && res.stderr.trim() !== "") {
				throw new SecretStoreError(`Secret Service delete failed: ${res.stderr.trim()}`, "failed");
			}
		},
	};
}
