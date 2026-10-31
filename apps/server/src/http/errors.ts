/**
 * Throw from any route handler; the global error handler serializes it as `ApiErrorBody`.
 * Zod validation failures are mapped to 400 `invalid_request` by the same handler.
 */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "ApiError";
	}

	static badRequest(message: string, details?: unknown) {
		return new ApiError(400, "invalid_request", message, details);
	}
	static notFound(what: string) {
		return new ApiError(404, "not_found", `${what} not found`);
	}
	static conflict(message: string, details?: unknown) {
		return new ApiError(409, "conflict", message, details);
	}
	static unavailable(message: string, details?: unknown) {
		return new ApiError(503, "unavailable", message, details);
	}
	static upstream(message: string, details?: unknown) {
		return new ApiError(502, "upstream_error", message, details);
	}
}
