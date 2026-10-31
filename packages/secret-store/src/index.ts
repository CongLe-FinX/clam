import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createEncryptedFileStore } from "./encrypted-file.ts";
import { run } from "./exec.ts";
import { createKeychainStore } from "./keychain.ts";
import { createLibsecretStore } from "./libsecret.ts";
import { type SecretBackend, type SecretStore, assertSafeName } from "./types.ts";

export { createEncryptedFileStore, isPrivate } from "./encrypted-file.ts";
export { createKeychainStore } from "./keychain.ts";
export { createLibsecretStore } from "./libsecret.ts";
export { type SecretBackend, type SecretStore, SecretStoreError } from "./types.ts";

type SelectableBackend = Exclude<SecretBackend, "windows-credential">;

export interface CreateSecretStoreOptions {
	dataDir: string;
	/**
	 * Namespace for every key. Default "cl-agent-mesh". OS stores are machine-wide, so a process that shares the
	 * machine with other nodes must pass a per-node namespace (the server uses `cl-agent-mesh.<nodeId>`).
	 */
	service?: string;
	/**
	 * Force a backend instead of auto-selecting. A forced OS backend that is unusable rejects.
	 * Also settable via env `CLAM_SECRET_BACKEND`.
	 */
	backend?: "auto" | SelectableBackend;
	/** Waits between probes of a pinned OS backend before giving up. Default 1 s, 2 s, 4 s. */
	pinRetryDelaysMs?: readonly number[];
}

const DEFAULT_SERVICE = "cl-agent-mesh";
const PIN_FILE = "backend";
const SELECTABLE: readonly SelectableBackend[] = ["macos-keychain", "libsecret", "encrypted-file"];
const DEFAULT_PIN_RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * Auto mode picks the best available store (macOS Keychain, Linux Secret Service, else an encrypted file) the
 * FIRST time and pins that choice in `<dataDir>/secrets/backend`. Later starts use the pinned backend only: secrets
 * live in exactly one place, so silently falling back to another store would make every stored secret look missing.
 * A pinned OS store that stays unusable after a few probes rejects with an explanation instead.
 * `store.backend` / `store.location` always reflect what is actually in use.
 */
export async function createSecretStore(opts: CreateSecretStoreOptions): Promise<SecretStore> {
	const service = opts.service ?? DEFAULT_SERVICE;
	assertSafeName("service", service);
	const requested = opts.backend ?? (process.env.CLAM_SECRET_BACKEND as CreateSecretStoreOptions["backend"] | undefined) ?? "auto";
	if (requested !== "auto") return openBackend(requested, opts.dataDir, service);

	const pinned = await readPin(opts.dataDir);
	if (pinned) return openPinned(pinned, opts.dataDir, service, opts.pinRetryDelaysMs ?? DEFAULT_PIN_RETRY_DELAYS_MS);

	const chosen = await autoSelect(opts.dataDir, service);
	await writePin(opts.dataDir, chosen.backend as SelectableBackend);
	return chosen;
}

async function autoSelect(dataDir: string, service: string): Promise<SecretStore> {
	if (process.platform === "darwin") {
		const store = createKeychainStore(service);
		if (await probe(store)) return store;
	}
	if (process.platform === "linux" && (await hasSecretTool())) {
		const store = createLibsecretStore(service);
		if (await probe(store)) return store;
	}
	return createEncryptedFileStore({ dataDir, service });
}

async function openBackend(backend: SelectableBackend, dataDir: string, service: string): Promise<SecretStore> {
	if (backend === "encrypted-file") return createEncryptedFileStore({ dataDir, service });
	const store = await usableOsStore(backend, service);
	if (!store) throw unavailable(backend === "macos-keychain" ? "macOS Keychain" : "Secret Service (secret-tool)");
	return store;
}

async function openPinned(backend: SelectableBackend, dataDir: string, service: string, delays: readonly number[]): Promise<SecretStore> {
	if (backend === "encrypted-file") return createEncryptedFileStore({ dataDir, service });
	for (let attempt = 0; ; attempt++) {
		const store = await usableOsStore(backend, service);
		if (store) return store;
		const delay = delays[attempt];
		if (delay === undefined) break;
		await sleep(delay);
	}
	throw new Error(
		`This node keeps its secrets in ${backend}, which is not usable right now (locked or unavailable). ` +
			`Unlock it and restart. Starting with another store would hide every stored secret; to move this node to ` +
			`another store on purpose, set CLAM_SECRET_BACKEND and re-enter its secrets (GitHub accounts, tunnel token).`,
	);
}

async function usableOsStore(backend: "macos-keychain" | "libsecret", service: string): Promise<SecretStore | null> {
	if (backend === "macos-keychain") {
		if (process.platform !== "darwin") return null;
		const store = createKeychainStore(service);
		return (await probe(store)) ? store : null;
	}
	if (process.platform !== "linux" || !(await hasSecretTool())) return null;
	const store = createLibsecretStore(service);
	return (await probe(store)) ? store : null;
}

async function readPin(dataDir: string): Promise<SelectableBackend | null> {
	let text: string;
	try {
		text = (await readFile(join(dataDir, "secrets", PIN_FILE), "utf8")).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	if (!(SELECTABLE as readonly string[]).includes(text)) {
		throw new Error(`Unrecognised secret store "${text}" in ${join(dataDir, "secrets", PIN_FILE)}; expected one of ${SELECTABLE.join(", ")}`);
	}
	return text as SelectableBackend;
}

async function writePin(dataDir: string, backend: SelectableBackend): Promise<void> {
	const dir = join(dataDir, "secrets");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	const file = join(dir, PIN_FILE);
	await writeFile(file, `${backend}\n`, { mode: 0o600 });
	await chmod(file, 0o600);
}

function unavailable(what: string): Error {
	return new Error(`${what} is not available on this machine`);
}

async function hasSecretTool(): Promise<boolean> {
	const res = await run("secret-tool", ["--version"], { timeoutMs: 5000 });
	return !res.spawnFailed;
}

async function probe(store: SecretStore): Promise<boolean> {
	// Unique per call: processes probing the same OS store at once must not read each other's probe value.
	const key = `__probe__.${process.pid}.${randomUUID()}`;
	const value = `probe-${Date.now()}`;
	try {
		await store.set(key, value);
		const ok = (await store.get(key)) === value;
		await store.delete(key);
		return ok;
	} catch {
		await store.delete(key).catch(() => {});
		return false;
	}
}
