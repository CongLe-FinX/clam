import {
	CompactBody,
	CreateSessionBody,
	PromptBody,
	SetModelBody,
	SetThinkingBody,
	SteerSubagentBody,
	SubagentMessagesQuery,
	UiResponseBody,
	UpdateSessionBody,
	LOCAL_API_PREFIX,
	routes,
	type SessionOutputsPage,
} from "@clam/contracts";
import { projects } from "@clam/database";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { assertPromptImages } from "../services/prompt-images.ts";
import { createChatProject, deleteManagedFolder } from "../services/project-folders.ts";

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
/** `DELETE /sessions/:id?keepFiles=1`: a chat's own folder survives (becomes a normal project) instead of being deleted with it. */
const DeleteQuery = z.object({
	keepFiles: z
		.enum(["true", "false", "1", "0"])
		.optional()
		.transform((v) => v === "true" || v === "1"),
});
const ImageParams = z.object({ id: z.string().min(1), messageId: z.string().min(1), index: z.coerce.number().int().min(0).max(1000) });
const SessionIdParams = z.object({ sessionId: z.string().min(1) });
const SubagentParams = z.object({ id: z.string().min(1), subagentId: z.string().min(1) });

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
		const body = CreateSessionBody.parse(req.body);
		if (body.projectId !== undefined) return reply.status(201).send(sessions.create({ ...body, projectId: body.projectId }));
		// A plain chat: no project was picked, so the node gives the conversation a working folder of its own (no repository, no git).
		const folder = createChatProject(ctx, { workspaceId: body.workspaceId, title: body.title });
		try {
			return reply.status(201).send(sessions.create({ ...body, projectId: folder.id }));
		} catch (error) {
			ctx.db.delete(projects).where(eq(projects.id, folder.id)).run();
			await deleteManagedFolder(ctx, folder);
			throw error;
		}
	});

	app.get(routes.session(":id"), async (req) => sessions.toSession(sessions.get(IdParams.parse(req.params).id)));

	app.patch(routes.session(":id"), async (req) => {
		const { id } = IdParams.parse(req.params);
		return sessions.update(id, UpdateSessionBody.parse(req.body));
	});

	app.delete(routes.session(":id"), async (req, reply) => {
		const { keepFiles } = DeleteQuery.parse(req.query);
		await sessions.remove(IdParams.parse(req.params).id, { keepFiles });
		return reply.status(204).send();
	});

	// Pictures (screenshots the agent took, images you attached) go out as URLs, not base64: they are most of a page's bytes and the
	// browser loads them only when they scroll into view.
	app.get(routes.sessionMessages(":id"), async (req) => {
		const { id } = IdParams.parse(req.params);
		const page = await sessions.messages(id, MessagesQuery.parse(req.query));
		return {
			...page,
			messages: page.messages.map((m) =>
				m.content.some((b) => b.type === "image" && b.data)
					? {
							...m,
							content: m.content.map((b, i) =>
								b.type === "image" && b.data ? { type: "image" as const, mimeType: b.mimeType, data: "", url: `${LOCAL_API_PREFIX}${routes.sessionMessageImage(encodeURIComponent(id), encodeURIComponent(m.id), i)}` } : b,
							),
						}
					: m,
			),
		};
	});

	app.get(routes.sessionMessageImage(":id", ":messageId", ":index"), { config: { compress: false } }, async (req, reply) => {
		const { id, messageId, index } = ImageParams.parse(req.params);
		// Walk the conversation back from the newest page (held in memory by the runtime or the mirror) until the message turns up.
		let cursor: string | undefined;
		for (;;) {
			const page = await sessions.messages(id, { limit: 256, ...(cursor && { cursor }) });
			const message = page.messages.find((m) => m.id === messageId);
			if (message) {
				const block = message.content[index];
				if (block?.type !== "image" || !block.data) throw ApiError.notFound("Image");
				// A message's content never changes once it is in the history: the bytes can be cached for good.
				return reply.header("Content-Type", block.mimeType).header("Cache-Control", "private, max-age=31536000, immutable").header("X-Content-Type-Options", "nosniff").send(Buffer.from(block.data, "base64"));
			}
			if (!page.nextCursor) throw ApiError.notFound("Image");
			cursor = page.nextCursor;
		}
	});

	// The files each turn produced. Mirrors have no folder of their own (their driver node holds the files), so they have none.
	app.get(routes.sessionOutputs(":id"), async (req): Promise<SessionOutputsPage> => {
		const row = sessions.get(IdParams.parse(req.params).id);
		return { outputs: row.kind === "mirror" ? [] : ctx.turnOutputs.list(row.id) };
	});

	app.get(routes.sessionState(":id"), async (req) => sessions.state(IdParams.parse(req.params).id));

	app.post(routes.sessionPrompt(":id"), async (req, reply) => {
		const { id } = IdParams.parse(req.params);
		const body = PromptBody.parse(req.body);
		assertPromptImages(body.images);
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

	app.post(routes.sessionCompact(":id"), async (req) => {
		const { id } = IdParams.parse(req.params);
		return sessions.compact(id, CompactBody.parse(req.body ?? {}));
	});

	app.post(routes.sessionUiResponse(":id"), async (req, reply) => {
		const { id } = IdParams.parse(req.params);
		await sessions.respondToUi(id, UiResponseBody.parse(req.body));
		return reply.status(204).send();
	});

	// Unanswered approvals/questions, so a reconnecting client can render them.
	app.get(routes.sessionUiRequests(":id"), async (req) => sessions.pendingUiRequests(IdParams.parse(req.params).id));

	// ---- subagents (spawned by the agent's `task` tool)

	app.get(routes.sessionSubagents(":id"), async (req) => sessions.subagents(IdParams.parse(req.params).id));

	app.get(routes.sessionSubagentMessages(":id", ":subagentId"), async (req) => {
		const { id, subagentId } = SubagentParams.parse(req.params);
		return sessions.subagentMessages(id, subagentId, SubagentMessagesQuery.parse(req.query).fromByte ?? 0);
	});

	app.post(routes.sessionSubagentCancel(":id", ":subagentId"), async (req) => {
		const { id, subagentId } = SubagentParams.parse(req.params);
		return sessions.cancelSubagent(id, subagentId);
	});

	app.post(routes.sessionSubagentSteer(":id", ":subagentId"), async (req, reply) => {
		const { id, subagentId } = SubagentParams.parse(req.params);
		await sessions.steerSubagent(id, subagentId, SteerSubagentBody.parse(req.body).message);
		return reply.status(204).send();
	});

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
