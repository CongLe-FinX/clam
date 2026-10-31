export type SecretBackend = "macos-keychain" | "libsecret" | "windows-credential" | "encrypted-file";

export interface SecretStore {
	readonly backend: SecretBackend;
	/** Human-readable place where secrets live (keychain name, or file path). */
	readonly location: string;
	get(key: string): Promise<string | null>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

export class SecretStoreError extends Error {
	constructor(
		message: string,
		readonly code: "unavailable" | "corrupted" | "failed",
	) {
		super(message);
		this.name = "SecretStoreError";
	}
}

const SAFE_NAME = /^[A-Za-z0-9._:@/-]{1,200}$/;

/** Keys and service names are restricted so they can be passed to OS tools without quoting hazards. */
export function assertSafeName(kind: "key" | "service", value: string): void {
	if (!SAFE_NAME.test(value)) {
		throw new SecretStoreError(`Invalid secret ${kind}: ${JSON.stringify(value)}`, "failed");
	}
}
