import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeName, type SecretStore, SecretStoreError } from "./types.ts";

const MASTER_KEY_FILE = "master.key";
const STORE_FILE = "secrets.enc.json";

interface Entry {
	iv: string;
	tag: string;
	ct: string;
}
interface StoreFile {
	v: 1;
	entries: Record<string, Entry>;
}

/**
 * AES-256-GCM encrypted JSON file under `<dataDir>/secrets/`.
 * - `master.key`: 32 random bytes, mode 0600, directory 0700.
 * - every entry has its own random 96-bit IV; the GCM AAD binds the ciphertext to
 *   (service, key), so entries cannot be swapped or renamed undetected.
 * This protects against casual disclosure (backups, screen shares, other local users);
 * it does not protect against an attacker who can read the whole directory, which is
 * why it is only the fallback when no OS credential store is available.
 */
export function createEncryptedFileStore(opts: { dataDir: string; service: string }): SecretStore {
	assertSafeName("service", opts.service);
	const dir = join(opts.dataDir, "secrets");
	const keyPath = join(dir, MASTER_KEY_FILE);
	const storePath = join(dir, STORE_FILE);
	let masterKey: Buffer | null = null;
	let queue: Promise<unknown> = Promise.resolve();

	/** Serializes every operation: read-modify-write of the file must not interleave. */
	const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = queue.then(fn, fn);
		queue = next.catch(() => {});
		return next;
	};

	async function ensureDir(): Promise<void> {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmod(dir, 0o700).catch(() => {});
	}

	async function loadKey(create: boolean): Promise<Buffer | null> {
		if (masterKey) return masterKey;
		try {
			const key = await readFile(keyPath);
			if (key.length !== 32) throw new SecretStoreError(`Master key at ${keyPath} is corrupted`, "corrupted");
			masterKey = key;
			return key;
		} catch (err) {
			if (err instanceof SecretStoreError) throw err;
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw wrapIo(err);
		}
		if (!create) return null;
		await ensureDir();
		const key = randomBytes(32);
		try {
			await writeFile(keyPath, key, { mode: 0o600, flag: "wx" });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") return loadKey(false);
			throw wrapIo(err);
		}
		masterKey = key;
		return key;
	}

	async function readStore(): Promise<StoreFile | null> {
		let raw: string;
		try {
			raw = await readFile(storePath, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw wrapIo(err);
		}
		try {
			const parsed = JSON.parse(raw) as StoreFile;
			if (parsed?.v !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) throw new Error("shape");
			return parsed;
		} catch {
			throw new SecretStoreError(`Secret file ${storePath} is corrupted`, "corrupted");
		}
	}

	async function writeStore(file: StoreFile): Promise<void> {
		await ensureDir();
		const tmp = `${storePath}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
		await rename(tmp, storePath);
	}

	const aad = (key: string) => Buffer.from(`${opts.service}\u0000${key}`, "utf8");

	return {
		backend: "encrypted-file",
		location: storePath,
		get: (key) =>
			exclusive(async () => {
				assertSafeName("key", key);
				const file = await readStore();
				const entry = file?.entries[key];
				if (!entry) return null;
				const master = await loadKey(false);
				if (!master) throw new SecretStoreError(`Master key ${keyPath} is missing; stored secrets cannot be decrypted`, "corrupted");
				try {
					const decipher = createDecipheriv("aes-256-gcm", master, Buffer.from(entry.iv, "base64"));
					decipher.setAAD(aad(key));
					decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
					return Buffer.concat([decipher.update(Buffer.from(entry.ct, "base64")), decipher.final()]).toString("utf8");
				} catch {
					throw new SecretStoreError(`Secret "${key}" failed authentication (file tampered or master key changed)`, "corrupted");
				}
			}),
		set: (key, value) =>
			exclusive(async () => {
				assertSafeName("key", key);
				const master = await loadKey(true);
				if (!master) throw new SecretStoreError("Master key unavailable", "failed");
				const file = (await readStore()) ?? { v: 1 as const, entries: {} };
				const iv = randomBytes(12);
				const cipher = createCipheriv("aes-256-gcm", master, iv);
				cipher.setAAD(aad(key));
				const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
				file.entries[key] = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
				await writeStore(file);
			}),
		delete: (key) =>
			exclusive(async () => {
				assertSafeName("key", key);
				const file = await readStore();
				if (!file || !(key in file.entries)) return;
				delete file.entries[key];
				await writeStore(file);
			}),
	};
}

/** Used by tests and diagnostics: true when the file is not group/world accessible (POSIX). */
export async function isPrivate(path: string): Promise<boolean> {
	const mode = (await stat(path)).mode & 0o777;
	return (mode & 0o077) === 0;
}

function wrapIo(err: unknown): SecretStoreError {
	return new SecretStoreError(`Secret file I/O failed: ${err instanceof Error ? err.message : String(err)}`, "failed");
}
