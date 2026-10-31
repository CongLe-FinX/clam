export type BundleErrorCode = "too_large" | "invalid_archive" | "unsafe_path" | "io";

export class BundleError extends Error {
	readonly code: BundleErrorCode;
	constructor(code: BundleErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "BundleError";
		this.code = code;
	}
}

/** Map any thrown value from fs/zlib into a BundleError (BundleErrors pass through). */
export function toBundleError(error: unknown): BundleError {
	if (error instanceof BundleError) return error;
	const code = (error as { code?: unknown } | null)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (typeof code === "string" && code.startsWith("Z_")) {
		return new BundleError("invalid_archive", `corrupt archive: ${message}`, { cause: error });
	}
	return new BundleError("io", message, { cause: error });
}
