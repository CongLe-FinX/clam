import { type ApiErrorBody, i18nMsg } from "@clam/contracts";
import { AgentRuntimeError } from "@clam/agent-runtime";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { ApiError } from "./errors.ts";

const RUNTIME_STATUS: Record<AgentRuntimeError["code"], number> = {
	not_installed: 503,
	start_failed: 502,
	capacity: 503,
	not_ready: 503,
	timeout: 504,
	process_exited: 502,
	rejected: 409,
	protocol: 502,
	unknown_session: 404,
	invalid_state: 409,
	invalid_argument: 400,
	session_locked: 409,
	invalid_archive: 422,
};

/** The one 404 every unknown route answers with (also used where a gate hides a whole surface behind the same answer). */
export function sendNotFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
	const say = i18nMsg("Route {method} {path} not found", { method: request.method, path: request.url.split("?")[0] ?? "" });
	return reply.status(404).send({ error: { code: "not_found", message: say.text, i18n: say.i18n } } satisfies ApiErrorBody);
}

/** Map any thrown value to the `ApiErrorBody` envelope used by every non-2xx JSON response. */
export function installErrorHandler(app: FastifyInstance): void {
	app.setErrorHandler((error, request, reply) => {
		let status = 500;
		let body: ApiErrorBody;
		if (error instanceof ApiError) {
			status = error.status;
			body = { error: { code: error.code, message: error.message, details: error.details, ...(error.i18n && { i18n: error.i18n }) } };
		} else if (error instanceof ZodError) {
			status = 400;
			body = {
				error: {
					code: "invalid_request",
					message: error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; "),
					details: error.issues,
				},
			};
		} else if (error instanceof AgentRuntimeError) {
			status = RUNTIME_STATUS[error.code];
			body = { error: { code: `runtime_${error.code}`, message: error.message, details: error.details } };
		} else if (typeof (error as { statusCode?: unknown }).statusCode === "number") {
			// Fastify's own errors (malformed JSON, payload too large, unsupported media type, ...).
			const e = error as { statusCode: number; code?: string; message: string };
			status = e.statusCode;
			body = { error: { code: status === 404 ? "not_found" : (e.code ?? "invalid_request").toLowerCase(), message: e.message } };
		} else {
			request.log.error({ err: error }, "unhandled error");
			const say = i18nMsg("Internal server error");
			body = { error: { code: "internal_error", message: say.text, i18n: say.i18n } };
		}
		if (status >= 500 && !(error instanceof ApiError)) request.log.warn({ err: error, status }, "request failed");
		return reply.status(status).send(body);
	});
	app.setNotFoundHandler((request, reply) => sendNotFound(request, reply));
}
