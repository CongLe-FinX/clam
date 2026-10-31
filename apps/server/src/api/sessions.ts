import {
	CreateSessionBody,
	PromptBody,
	SetModelBody,
	SetThinkingBody,
	UiResponseBody,
	UpdateSessionBody,
	routes,
} from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";

const ListQuery = z.object({
	projectId: z.string().min(1).optional(),
	archived: z
		.enum(["true", "false", "1", "0"])
		.optional()
		.transform((v) => v === "true" || v === "1"),
});
const MessagesQuery = z.object({
	cursor: z.string().min(1).max(2048).optional(),
	limit: z.coerce.number().int().min(1).max(256).optional(),
});
const IdParams = z.object({ id: z.string().min(1) });
const SessionIdParams = z.object({ sessionId: z.string().min(1) });

/** Sessions (CRUD, transcript, prompt/abort/model/thinking/ui-response) and the runtime process routes. */
export default async function sessionRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const sessions = ctx.sessions;
	sessions.start();
	app.addHook("onClose", async () => {
		sessions.dispose();
		await sessions.drainUsage();
	});

	app.get(routes.sessions, async (req) => sessions.list(ListQuery.parse(req.query)));

	app.post(routes.sessions, async (req, reply) => {
		const session = sessions.create(CreateSessionBody.parse(req.body));
		return reply.status(201).send(session);
	});

	app.get(routes.session(":id"), async (req) => sessions.toSession(sessions.get(IdParams.parse(req.params).id)));

	app.patch(routes.session(":id"), async (req) => {
		const { id } = IdParams.parse(req.params);
		return sessions.update(id, UpdateSessionBody.parse(req.body));
	});

	app.delete(routes.session(":id"), async (req, reply) => {
		await sessions.remove(IdParams.parse(req.params).id);
		return reply.status(204).send();
	});

	app.get(routes.sessionMessages(":id"), async (req) => {
		const { id } = IdParams.parse(req.params);
		return sessions.messages(id, MessagesQuery.parse(req.query));
	});

	app.get(routes.sessionState(":id"), async (req) => sessions.state(IdParams.parse(req.params).id));

	app.post(routes.sessionPrompt(":id"), async (req, reply) => {
		const { id } = IdParams.parse(req.params);
		const body = PromptBody.parse(req.body);
		const accepted = await sessions.prompt(id, body);
		return reply.status(202).send({ promptId: accepted.promptId, clientId: body.clientId });
	});

	app.post(routes.sessionAbort(":id"), async (req, reply) => {
		await sessions.abort(IdParams.parse(req.params).id);
		return reply.status(204).send();
	});

	app.post(routes.sessionModel(":id"), async (req) => {
		const { id } = IdParams.parse(req.params);
		return sessions.setModel(id, SetModelBody.parse(req.body));
	});

	app.post(routes.sessionThinking(":id"), async (req) => {
		const { id } = IdParams.parse(req.params);
		return sessions.setThinking(id, SetThinkingBody.parse(req.body));
	});

	app.post(routes.sessionUiResponse(":id"), async (req, reply) => {
		const { id } = IdParams.parse(req.params);
		await sessions.respondToUi(id, UiResponseBody.parse(req.body));
		return reply.status(204).send();
	});

	// Unanswered approvals/questions, so a reconnecting client can render them.
	app.get(routes.sessionUiRequests(":id"), async (req) => sessions.pendingUiRequests(IdParams.parse(req.params).id));

	// ---- runtime processes

	app.get(routes.runtime, async () => ctx.runtime.list());

	app.post(routes.runtimeStop(":sessionId"), async (req, reply) => {
		const { sessionId } = SessionIdParams.parse(req.params);
		sessions.get(sessionId);
		await ctx.runtime.stop(sessionId);
		return reply.status(204).send();
	});

	app.post(routes.runtimeRestart(":sessionId"), async (req) => sessions.restart(SessionIdParams.parse(req.params).sessionId));
}
