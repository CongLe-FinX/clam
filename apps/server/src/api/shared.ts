import {
	AddParticipantBody,
	ApplyFilesBody,
	CheckpointBody,
	DecideSharedInviteBody,
	PostSharedMessageBody,
	SaveAttachmentBody,
	TakeoverBody,
	TransferBody,
	routes,
	type Checkpoint,
	type FileEntry,
	type SharedAttachment,
	type SharedInvite,
	type SharedMessage,
	type SharedMessagesPage,
	type SharedSession,
	type SharedSessionDetail,
} from "@clam/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { ATTACHMENT_MAX_BYTES } from "@clam/contracts";
import type { RoutePluginOptions } from "../context.ts";
import { rawBodyScope } from "../http/raw-body.ts";
import { MESSAGES_PAGE_MAX } from "../shared/store.ts";

const IdParams = z.object({ id: z.string().min(1).max(128) });
const SessionIdParams = z.object({ sessionId: z.string().min(1).max(128) });
const ParticipantParams = IdParams.extend({ nodeId: z.string().min(1).max(128) });
const AttachmentParams = IdParams.extend({ attachmentId: z.string().min(1).max(128) });
const UploadQuery = z.object({ name: z.string().min(1).max(255) });
const DetailQuery = z.object({ messageLimit: z.coerce.number().int().min(1).max(1000).optional() });
const MessagesQuery = z.object({ before: z.string().min(1).max(1024).optional(), limit: z.coerce.number().int().min(1).max(MESSAGES_PAGE_MAX).optional() });
const DownloadQuery = z.object({ download: z.enum(["1", "0", "true", "false"]).optional() });

/** Shared sessions (local UI side of M5): list/detail, participants, the shared thread, checkpoints, takeover, transfer, leave, invitations. */
export default async function sharedRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const shared = ctx.shared;

	app.get(routes.sharedSessions, async (): Promise<SharedSession[]> => shared.list());
	// `/shared/invites` is a static segment: it wins over `/shared/:id`.
	app.get(routes.sharedInvites, async (): Promise<SharedInvite[]> => shared.invites());
	app.post(routes.sharedInviteDecide(":id"), async (req): Promise<SharedInvite> => shared.sharing.decide(IdParams.parse(req.params).id, DecideSharedInviteBody.parse(req.body)));

	// `messageLimit` returns only the newest N messages and a cursor for the older ones; without it the whole log, as ever.
	app.get(routes.sharedSession(":id"), async (req): Promise<SharedSessionDetail> => shared.detail(IdParams.parse(req.params).id, { messageLimit: DetailQuery.parse(req.query).messageLimit }));
	app.get(routes.sharedMessages(":id"), async (req): Promise<SharedMessagesPage> => shared.messages(IdParams.parse(req.params).id, MessagesQuery.parse(req.query)));

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
		const message: SharedMessage = await shared.discussion.post(id, { text: body.text, kind: body.kind, to: body.to, attachmentIds: body.attachmentIds, author: { kind: "human", agentId: null, agentName: null } });
		return reply.status(201).send(message);
	});
	// Files in the group chat. The upload takes the raw request body (its own scope: no JSON parser, streamed to disk, never buffered).
	await app.register(async (upload) => {
		rawBodyScope(upload);
		upload.post(routes.sharedAttachmentUpload(":id"), { bodyLimit: ATTACHMENT_MAX_BYTES }, async (req, reply): Promise<FastifyReply> => {
			const { id } = IdParams.parse(req.params);
			const attachment: SharedAttachment = await shared.attachments.upload(id, { name: UploadQuery.parse(req.query).name, mimeType: req.headers["content-type"], body: req.body, contentLength: req.headers["content-length"] });
			return reply.status(201).send(attachment);
		});
	});
	app.get(routes.sharedAttachment(":id", ":attachmentId"), { config: { compress: false } }, async (req, reply) => {
		const { id, attachmentId } = AttachmentParams.parse(req.params);
		const query = DownloadQuery.parse(req.query);
		return shared.attachments.serve(req, reply, id, attachmentId, query.download === "1" || query.download === "true");
	});
	app.post(routes.sharedAttachmentSave(":id", ":attachmentId"), async (req, reply): Promise<FastifyReply> => {
		const { id, attachmentId } = AttachmentParams.parse(req.params);
		const entry: FileEntry = await shared.attachments.save(id, attachmentId, SaveAttachmentBody.parse(req.body));
		return reply.status(201).send(entry);
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
	// Files mode: the former driver's work after its last checkpoint, kept as a bundle; look at it and apply it to a local project (never overwrites a locally changed file unless listed).
	app.get(routes.sharedRescuePreview(":id"), async (req) => shared.files.rescuePreview(IdParams.parse(req.params).id, z.object({ projectId: z.string().min(1) }).parse(req.query).projectId));
	app.post(routes.sharedRescueApply(":id"), async (req) => shared.files.rescueApply(IdParams.parse(req.params).id, ApplyFilesBody.parse(req.body)));
	app.post(routes.sharedLeave(":id"), async (req): Promise<SharedSession> => shared.sharing.leave(IdParams.parse(req.params).id));
}
