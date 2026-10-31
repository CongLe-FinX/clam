import { createReadStream } from "node:fs";
import { FORMAT, wire } from "@clam/agent-network";
import type { Capability } from "@clam/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../http/errors.ts";
import type { HandoffService } from "../handoff/service.ts";
import type { HandoffRow } from "../handoff/store.ts";
import { digestHeader } from "../shared/snapshots.ts";
import { runIdempotent, type IdempotencyStore } from "./idempotency.ts";
import type { BodySchema } from "./tasks-routes.ts";

/** The listener's authentication helpers, shared so the handoff endpoints are verified exactly like every other signed endpoint. */
export interface HandoffWireDeps {
	handoffs: HandoffService;
	/** The response store of the task engine (generic per `(peer, key)`). */
	idempotency: IdempotencyStore;
	requires(...needed: Capability[]): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
	bodyOf<T>(schema: BodySchema<T>, request: FastifyRequest): T;
}

interface IdParams {
	id: string;
}

/**
 * `/api/v1/handoffs*` (docs/agent-network-protocol.md §5.10–5.12 + the additive `state`, status and artifact calls). One capability,
 * `handoff.receive`, checked on the RECEIVING node against what it granted the caller, in both directions. A handoff is only
 * visible to the node on the other side of it: anything else answers 404. Mutating calls run under the response store
 * (`Idempotency-Key`) and are idempotent by handoff id on top of it.
 */
export function registerHandoffWireRoutes(api: FastifyInstance, deps: HandoffWireDeps): void {
	const { handoffs, requires, bodyOf } = deps;
	const pre = { preHandler: requires("handoff.receive") };
	const idempotency = { store: deps.idempotency, inFlight: new Set<string>() };
	const idempotent = (request: FastifyRequest, reply: FastifyReply, run: () => Promise<{ status: number; body: unknown }>): Promise<FastifyReply> => runIdempotent(idempotency, request, reply, run);
	const peerOf = (request: FastifyRequest): string => request.peer?.id as string;

	/** The caller's counterpart row; 404 for anything else (never reveal that another node's handoff exists). */
	function visible(request: FastifyRequest, id: string, role?: "source" | "target"): HandoffRow {
		const row = FORMAT.id.test(id) ? handoffs.store.find(id) : undefined;
		if (!row || row.peerId !== peerOf(request) || (role !== undefined && row.role !== role)) throw ApiError.notFound("Handoff");
		return row;
	}

	api.post("/handoffs", pre, (request, reply) =>
		idempotent(request, reply, async () => {
			const body = bodyOf(wire.HandoffOfferRequest, request);
			const { created } = await handoffs.target.receive(peerOf(request), body);
			return { status: created ? 201 : 200, body: { handoffId: body.handoffId, state: "received" } satisfies wire.HandoffOfferAccepted };
		}),
	);

	api.post<{ Params: IdParams }>("/handoffs/:id/accept", pre, (request, reply) =>
		idempotent(request, reply, async () => {
			const row = visible(request, request.params.id, "source");
			return { status: 200, body: handoffs.source.receiveAccept(peerOf(request), row.id, bodyOf(wire.HandoffAcceptRequest, request)) };
		}),
	);

	api.post<{ Params: IdParams }>("/handoffs/:id/ack", pre, (request, reply) =>
		idempotent(request, reply, async () => {
			const row = visible(request, request.params.id, "source");
			return { status: 200, body: await handoffs.source.receiveAck(peerOf(request), row.id, bodyOf(wire.HandoffAckRequest, request)) };
		}),
	);

	api.post<{ Params: IdParams }>("/handoffs/:id/state", pre, (request, reply) =>
		idempotent(request, reply, async () => {
			const row = visible(request, request.params.id);
			const body = bodyOf(wire.HandoffStateRequest, request);
			const accepted = row.role === "source" ? handoffs.source.receiveState(peerOf(request), row.id, body) : handoffs.target.receiveState(peerOf(request), row.id, body);
			return { status: 200, body: accepted };
		}),
	);

	api.get<{ Params: IdParams }>("/handoffs/:id", pre, async (request): Promise<wire.HandoffStatusResponse> => handoffs.statusOf(visible(request, request.params.id)));

	/** A file of the handoff the source holds (folder bundle, working-tree patch, opt-in transcript pack), streamed as stored; the target verifies size and sha-256 against the manifest. */
	api.get<{ Params: IdParams & { artifactId: string } }>("/handoffs/:id/artifacts/:artifactId", pre, async (request, reply) => {
		const row = visible(request, request.params.id, "source");
		const artifact = FORMAT.id.test(request.params.artifactId) ? handoffs.store.artifact(row.id, request.params.artifactId) : undefined;
		if (!artifact || (artifact.kind === "session-pack" && !row.includeTranscript)) throw ApiError.notFound("Artifact");
		return reply
			.header("Content-Type", "application/octet-stream")
			.header("Content-Length", artifact.size)
			.header("Content-Digest", digestHeader(artifact.sha256))
			.header("Content-Disposition", `attachment; filename="${artifact.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "artifact"}"`)
			.send(createReadStream(artifact.path));
	});
}
