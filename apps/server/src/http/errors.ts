import { type I18nMessage, type I18nText, i18nMsg } from "@clam/contracts";

/**
 * Throw from any route handler; the global error handler serializes it as `ApiErrorBody`.
 * Zod validation failures are mapped to 400 `invalid_request` by the same handler.
 */
export class ApiError extends Error {
	/** Structured twin of `message` (see `I18nText`); undefined for messages that are not translated. */
	readonly i18n: I18nText | undefined;

	/** `message` is either plain English text or an `i18nMsg(...)`, whose structured twin travels in the error envelope. */
	constructor(
		readonly status: number,
		readonly code: string,
		message: string | I18nMessage,
		readonly details?: unknown,
	) {
		super(typeof message === "string" ? message : message.text);
		this.name = "ApiError";
		this.i18n = typeof message === "string" ? undefined : message.i18n;
	}

	static badRequest(message: string | I18nMessage, details?: unknown) {
		return new ApiError(400, "invalid_request", message, details);
	}
	static notFound(what: string) {
		return new ApiError(404, "not_found", i18nMsg("{what} not found", { what }));
	}
	static conflict(message: string | I18nMessage, details?: unknown) {
		return new ApiError(409, "conflict", message, details);
	}
	static unavailable(message: string | I18nMessage, details?: unknown) {
		return new ApiError(503, "unavailable", message, details);
	}
	static upstream(message: string | I18nMessage, details?: unknown) {
		return new ApiError(502, "upstream_error", message, details);
	}
}
