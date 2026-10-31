export type UsageErrorCode = "omp_missing" | "omp_failed" | "omp_timeout" | "bad_output";

/** Raised when OMP's CLI cannot produce a usable JSON payload. */
export class UsageError extends Error {
	constructor(
		readonly code: UsageErrorCode,
		message: string,
	) {
		super(message);
		this.name = "UsageError";
	}
}
