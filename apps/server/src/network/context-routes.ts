import { ContextMembershipRequest, ContextSyncRequest } from "@clam/context-engine";
import type { Capability } from "@clam/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ContextService } from "../context/service.ts";
import { runIdempotent, type IdempotencyStore } from "./idempotency.ts";
import type { BodySchema } from "./tasks-routes.ts";

/** The listener's authentication helpers, shared so the context endpoints are verified exactly like every other signed endpoint. */
export interface ContextWireDeps {
	contexts: ContextService;
	/** The response store of the task engine (generic per `(peer, key)`). */
	idempotency: IdempotencyStore;
	requires(...needed: Capability[]): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
	bodyOf<T>(schema: BodySchema<T>, request: FastifyRequest): T;
}

/**
 * `/api/v1/context/*` (docs/agent-network-protocol.md §5.9). Both endpoints run after `authenticate` with the capability
 * `context.sync`, so `request.peer` is the verified peer; workspace membership is enforced by the handlers from this node's own
 * `workspace_members`. Both mutate, so both run under the response store (`Idempotency-Key`).
 */
export function registerContextWireRoutes(api: FastifyInstance, deps: ContextWireDeps): void {
	const { contexts, requires, bodyOf } = deps;
	const pre = { preHandler: requires("context.sync") };
	const idempotency = { store: deps.idempotency, inFlight: new Set<string>() };
	const peerOf = (request: FastifyRequest): string => request.peer?.id as string;

	api.post("/context/sync", pre, (request, reply) =>
		runIdempotent(idempotency, request, reply, async () => ({ status: 200, body: contexts.sync.receive(peerOf(request), bodyOf(ContextSyncRequest, request)) })),
	);

	api.post("/context/membership", pre, (request, reply) =>
		runIdempotent(idempotency, request, reply, async () => ({ status: 200, body: contexts.members.receive(peerOf(request), bodyOf(ContextMembershipRequest, request)) })),
	);
}
