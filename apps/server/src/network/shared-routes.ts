import { createReadStream } from "node:fs";
import { wire, FORMAT } from "@clam/agent-network";
import type { Capability } from "@clam/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../http/errors.ts";
import { digestHeader } from "../shared/snapshots.ts";
import type { SharedService } from "../shared/service.ts";
import { runIdempotent, type IdempotencyStore } from "./idempotency.ts";
import type { BodySchema } from "./tasks-routes.ts";

/** The listener's authentication helpers, shared so the shared-session endpoints are verified exactly like every other signed endpoint. */
export interface SharedWireDeps {
	shared: SharedService;
	/** The response store of the task engine (generic per `(peer, key)`). */
	idempotency: IdempotencyStore;
	requires(...needed: Capability[]): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
	bodyOf<T>(schema: BodySchema<T>, request: FastifyRequest): T;
}

interface IdParams {
	id: string;
}

const SEQ = /^[1-9][0-9]{0,8}$/;

function sharedId(params: IdParams): string {
	if (!FORMAT.id.test(params.id)) throw ApiError.notFound("Shared session");
	return params.id;
}

function seqOf(value: string): number {
	if (!SEQ.test(value)) throw ApiError.badRequest("seq must be a positive integer");
	return Number(value);
}

/**
 * `/api/v1/shared*` (docs/agent-network-protocol.md §5.9). Every handler runs after `authenticate` with the capability
 * `sessions.share`, so `request.peer` is the verified peer. A shared session is only visible to its participants: anything
 * else answers 404. Mutating calls run under the response store (`Idempotency-Key`); mirror frames are idempotent by
 * `(streamId, seq)` instead, because storing every 500 ms batch would only fill the store.
 */
export function registerSharedWireRoutes(api: FastifyInstance, deps: SharedWireDeps): void {
	const { shared, requires, bodyOf } = deps;
	const pre = { preHandler: requires("sessions.share") };
	const idempotency = { store: deps.idempotency, inFlight: new Set<string>() };
	const idempotent = (request: FastifyRequest, reply: FastifyReply, run: () => Promise<{ status: number; body: unknown }>): Promise<FastifyReply> => runIdempotent(idempotency, request, reply, run);
	const peerOf = (request: FastifyRequest): string => request.peer?.id as string;

	api.post("/shared/invites", pre, (request, reply) =>
		idempotent(request, reply, async () => {
			const body = bodyOf(wire.SharedInviteRequest, request);
			const result = await shared.sharing.receiveInvite(peerOf(request), body);
			return { status: !result.created ? 200 : result.state === "accepted" ? 201 : 202, body: { inviteId: result.inviteId, state: result.state } satisfies wire.SharedInviteAccepted };
		}),
	);

	api.post<{ Params: IdParams }>("/shared/:id/decision", pre, (request, reply) =>
		idempotent(request, reply, async () => {
			await shared.sharing.receiveDecision(peerOf(request), sharedId(request.params), bodyOf(wire.SharedDecisionRequest, request));
			return { status: 200, body: { ok: true } satisfies wire.OkResponse };
		}),
	);

	api.post<{ Params: IdParams }>("/shared/:id/messages", pre, (request, reply) =>
		idempotent(request, reply, async () => {
			const body = bodyOf(wire.SharedMessageRequest, request);
			return { status: 202, body: await shared.discussion.receive(peerOf(request), sharedId(request.params), body) };
		}),
	);

	/** A read carried in a POST body (the cursor): naturally idempotent, so no response store (a replayed page would be stale; the signed `Idempotency-Key` header is still required of every POST). */
	api.post<{ Params: IdParams }>("/shared/:id/messages/sync", pre, async (request): Promise<wire.SharedMessagesSyncResponse> => shared.discussion.serveSync(peerOf(request), sharedId(request.params), bodyOf(wire.SharedMessagesSyncRequest, request)));

	api.post<{ Params: IdParams }>("/shared/:id/mirror", pre, async (request): Promise<wire.SharedMirrorAccepted> => shared.mirror.receive(peerOf(request), sharedId(request.params), bodyOf(wire.SharedMirrorRequest, request)));

	api.post<{ Params: IdParams }>("/shared/:id/checkpoints", pre, (request, reply) =>
		idempotent(request, reply, async () => {
			shared.checkpoints.receiveNotice(peerOf(request), sharedId(request.params), bodyOf(wire.SharedCheckpointNotice, request));
			return { status: 202, body: { ok: true } satisfies wire.OkResponse };
		}),
	);

	api.post<{ Params: IdParams & { seq: string } }>("/shared/:id/checkpoints/:seq/ack", pre, (request, reply) =>
		idempotent(request, reply, async () => {
			shared.checkpoints.receiveAck(peerOf(request), sharedId(request.params), seqOf(request.params.seq), bodyOf(wire.SharedCheckpointAck, request));
			return { status: 200, body: { ok: true } satisfies wire.OkResponse };
		}),
	);

	/** The snapshot of a checkpoint, streamed as stored; the receiver verifies size and sha-256 against the checkpoint notice while writing. */
	api.get<{ Params: IdParams & { seq: string } }>("/shared/:id/snapshots/:seq", pre, async (request, reply) => {
		const id = sharedId(request.params);
		const participant = shared.store.participant(id, peerOf(request));
		if (!participant || participant.state !== "active") throw ApiError.notFound("Snapshot");
		const file = shared.checkpoints.snapshotFile(id, seqOf(request.params.seq));
		return reply
			.header("Content-Type", "application/octet-stream")
			.header("Content-Length", file.size)
			.header("Content-Digest", digestHeader(file.sha256))
			.header("Content-Disposition", 'attachment; filename="session-snapshot.tar"')
			.send(createReadStream(file.path));
	});

	api.post<{ Params: IdParams }>("/shared/:id/driver", pre, (request, reply) =>
		idempotent(request, reply, async () => {
			await shared.epochs.receiveDriver(peerOf(request), sharedId(request.params), bodyOf(wire.SharedDriverNotice, request));
			return { status: 200, body: { ok: true } satisfies wire.OkResponse };
		}),
	);

	api.post<{ Params: IdParams }>("/shared/:id/membership", pre, (request, reply) =>
		idempotent(request, reply, async () => {
			await shared.sharing.receiveMembership(peerOf(request), sharedId(request.params), bodyOf(wire.SharedMembershipRequest, request));
			return { status: 200, body: { ok: true } satisfies wire.OkResponse };
		}),
	);

	api.post<{ Params: IdParams }>("/shared/:id/transfer", pre, (request, reply) =>
		idempotent(request, reply, async () => ({ status: 202, body: await shared.epochs.receiveTransfer(peerOf(request), sharedId(request.params), bodyOf(wire.SharedTransferRequest, request)) })),
	);

	api.get<{ Params: IdParams }>("/shared/:id", pre, async (request): Promise<wire.SharedStateResponse> => shared.epochs.stateFor(peerOf(request), sharedId(request.params)));
}
