import {
	AddParticipantBody,
	CheckpointBody,
	DecideSharedInviteBody,
	PostSharedMessageBody,
	TakeoverBody,
	TransferBody,
	routes,
	type Checkpoint,
	type SharedInvite,
	type SharedMessage,
	type SharedSession,
	type SharedSessionDetail,
} from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";

const IdParams = z.object({ id: z.string().min(1).max(128) });
const SessionIdParams = z.object({ sessionId: z.string().min(1).max(128) });
const ParticipantParams = IdParams.extend({ nodeId: z.string().min(1).max(128) });

/** Shared sessions (local UI side of M5): list/detail, participants, the shared thread, checkpoints, takeover, transfer, leave, invitations. */
export default async function sharedRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const shared = ctx.shared;

	app.get(routes.sharedSessions, async (): Promise<SharedSession[]> => shared.list());
	// `/shared/invites` is a static segment: it wins over `/shared/:id`.
	app.get(routes.sharedInvites, async (): Promise<SharedInvite[]> => shared.invites());
	app.post(routes.sharedInviteDecide(":id"), async (req): Promise<SharedInvite> => shared.sharing.decide(IdParams.parse(req.params).id, DecideSharedInviteBody.parse(req.body)));

	app.get(routes.sharedSession(":id"), async (req): Promise<SharedSessionDetail> => shared.detail(IdParams.parse(req.params).id));

	app.post(routes.sessionParticipants(":sessionId"), async (req, reply) => {
		const { sessionId } = SessionIdParams.parse(req.params);
		const session: SharedSession = await shared.sharing.addParticipant(sessionId, AddParticipantBody.parse(req.body));
		return reply.status(201).send(session);
	});
	app.delete(routes.sharedParticipant(":id", ":nodeId"), async (req): Promise<SharedSession> => {
		const { id, nodeId } = ParticipantParams.parse(req.params);
		return shared.sharing.removeParticipant(id, nodeId);
	});

	app.post(routes.sharedMessages(":id"), async (req, reply) => {
		const { id } = IdParams.parse(req.params);
		const body = PostSharedMessageBody.parse(req.body);
		// A person at this node typing in the group chat: never an agent, so the loop budget resets. Works whether or not the lead's node is online.
		const message: SharedMessage = await shared.discussion.post(id, { text: body.text, kind: body.kind, to: body.to, author: { kind: "human", agentId: null, agentName: null } });
		return reply.status(201).send(message);
	});
	app.post(routes.sharedRead(":id"), async (req, reply) => {
		shared.discussion.markRead(IdParams.parse(req.params).id);
		return reply.status(204).send();
	});

	app.post(routes.sharedCheckpoint(":id"), async (req): Promise<Checkpoint> => {
		const { id } = IdParams.parse(req.params);
		return shared.checkpoints.checkpoint(id, { note: CheckpointBody.parse(req.body ?? {}).note, manual: true });
	});
	app.post(routes.sharedTakeover(":id"), async (req): Promise<SharedSession> => shared.epochs.takeover(IdParams.parse(req.params).id, TakeoverBody.parse(req.body ?? {})));
	app.post(routes.sharedTransfer(":id"), async (req, reply) => {
		const started: SharedSession = await shared.transfers.begin(IdParams.parse(req.params).id, TransferBody.parse(req.body));
		return reply.status(202).send(started);
	});
	app.delete(routes.sharedTransfer(":id"), async (req): Promise<SharedSession> => shared.transfers.cancel(IdParams.parse(req.params).id));
	app.post(routes.sessionHandover(":sessionId"), async (req, reply) => {
		const started: SharedSession = await shared.transfers.handover(SessionIdParams.parse(req.params).sessionId, TransferBody.parse(req.body));
		return reply.status(202).send(started);
	});
	app.post(routes.sharedLeave(":id"), async (req): Promise<SharedSession> => shared.sharing.leave(IdParams.parse(req.params).id));
}
