import { i18nMsg } from "@clam/contracts";
import { IDEMPOTENCY_TTL_MS, evaluateIdempotency, requestHash } from "@clam/task-engine";
import { idempotencyRecords, type ClamDb } from "@clam/database";
import { and, eq, lte } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../http/errors.ts";

export type IdempotencyRow = typeof idempotencyRecords.$inferSelect;

/**
 * The receiver-side response store of docs/agent-network-protocol.md §6: `(peerId, Idempotency-Key)` → the first 2xx
 * answer, kept 24 h. Keyed by peer and key only — nothing here knows tasks — so every future mutating endpoint
 * (handoffs, context sync) goes through `runIdempotent` as well.
 */
export class IdempotencyStore {
	constructor(private readonly db: ClamDb) {}

	find(peerId: string, key: string, nowMs = Date.now()): IdempotencyRow | undefined {
		const row = this.db.select().from(idempotencyRecords).where(and(eq(idempotencyRecords.peerId, peerId), eq(idempotencyRecords.key, key))).get();
		return row && row.expiresAt > nowMs ? row : undefined;
	}

	save(r: { peerId: string; key: string; method: string; path: string; requestHash: string; status: number; responseBody: string; ttlMs: number }): void {
		const values = {
			peerId: r.peerId,
			key: r.key,
			method: r.method,
			path: r.path,
			requestHash: r.requestHash,
			status: r.status,
			responseBody: r.responseBody,
			createdAt: new Date().toISOString(),
			expiresAt: Date.now() + r.ttlMs,
		};
		this.db.insert(idempotencyRecords).values(values).onConflictDoUpdate({ target: [idempotencyRecords.peerId, idempotencyRecords.key], set: values }).run();
	}

	prune(nowMs = Date.now()): number {
		return this.db.delete(idempotencyRecords).where(lte(idempotencyRecords.expiresAt, nowMs)).run().changes;
	}
}

/** `(peerId, key)` pairs being executed right now: a retry that overlaps the first attempt must not run twice. */
export type InFlightKeys = Set<string>;

/**
 * Run a mutating endpoint under the response store. A known key with the same request replays the stored 2xx answer
 * (`Idempotent-Replay: true`, nothing re-executed); with a different request it is `409 idempotency_conflict`; an
 * overlapping attempt is `409 conflict` + `Retry-After`. Only 2xx answers are stored, so a failed attempt can be retried.
 * `request.peer` must be set (the endpoint is authenticated).
 */
export async function runIdempotent(
	deps: { store: IdempotencyStore; inFlight: InFlightKeys },
	request: FastifyRequest,
	reply: FastifyReply,
	run: () => Promise<{ status: number; body: unknown }>,
): Promise<FastifyReply> {
	const peerId = request.peer?.id as string;
	const key = request.headers["idempotency-key"];
	if (typeof key !== "string" || key === "") throw ApiError.badRequest(i18nMsg("Idempotency-Key is required"));
	const path = (request.raw.url ?? request.url).split("?")[0] as string;
	const hash = requestHash(request.method, path, request.rawBody);
	const existing = deps.store.find(peerId, key);
	const verdict = evaluateIdempotency(existing, hash);
	if (verdict === "conflict") throw new ApiError(409, "idempotency_conflict", i18nMsg("That Idempotency-Key was already used for a different request"));
	if (existing && verdict === "replay") {
		return reply.status(existing.status).header("Idempotent-Replay", "true").type("application/json").send(existing.responseBody);
	}
	const flight = `${peerId}\n${key}`;
	if (deps.inFlight.has(flight)) {
		reply.header("Retry-After", "1");
		throw ApiError.conflict(i18nMsg("A request with this Idempotency-Key is still being processed"));
	}
	deps.inFlight.add(flight);
	try {
		const { status, body } = await run();
		const text = JSON.stringify(body);
		deps.store.save({ peerId, key, method: request.method, path, requestHash: hash, status, responseBody: text, ttlMs: IDEMPOTENCY_TTL_MS });
		return reply.status(status).type("application/json").send(text);
	} finally {
		deps.inFlight.delete(flight);
	}
}
