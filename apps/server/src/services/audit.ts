import { nodeEvents } from "@clam/database";
import type { ClamDb } from "@clam/database";
import type { NodeIdentity } from "@clam/node-identity";
import type { FastifyBaseLogger } from "fastify";

export interface AuditContext {
	db: ClamDb;
	identity: NodeIdentity;
	log: FastifyBaseLogger;
}

/**
 * Append an entry to the node's audit/event log (`node_events`). Never throws: a failing log write must not break the action it records.
 * Machine tools (Terminal, Browser) record `<tool>.open` / `<tool>.close` with `via: "loopback" | "remote"`; access changes record `access.*`.
 */
export function recordAudit(ctx: AuditContext, type: string, payload: Record<string, unknown>, level: "info" | "warning" | "error" = "info"): void {
	try {
		ctx.db.insert(nodeEvents).values({ nodeId: ctx.identity.nodeId, type, level, payload }).run();
	} catch (error) {
		ctx.log.warn({ err: error, type }, "could not write an audit entry");
	}
	ctx.log.info({ audit: type, ...payload }, "audit");
}
