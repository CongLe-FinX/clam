import { agents, node } from "@clam/database";
import type { ClamDb } from "@clam/database";
import type { NodeIdentity } from "@clam/node-identity";
import { eq } from "drizzle-orm";
import { newId } from "./ids.ts";

/** Ensure this node's row exists and mirrors its identity and configured name. */
export function ensureNodeRow(db: ClamDb, identity: NodeIdentity, nodeName: string): void {
	const now = new Date().toISOString();
	db.insert(node)
		.values({ id: identity.nodeId, name: nodeName, publicKey: identity.publicKey, fingerprint: identity.fingerprint, status: "online", createdAt: now, updatedAt: now })
		.onConflictDoUpdate({ target: node.id, set: { name: nodeName, publicKey: identity.publicKey, fingerprint: identity.fingerprint, status: "online", updatedAt: now } })
		.run();
}

/** First boot: register this node's default OMP agent. Returns true when it was created. */
export function ensureDefaultAgent(db: ClamDb, nodeId: string): boolean {
	const existing = db.select({ id: agents.id }).from(agents).where(eq(agents.nodeId, nodeId)).get();
	if (existing) return false;
	db.insert(agents)
		.values({ id: newId("agt"), nodeId, name: "OMP Agent", role: "General", runtime: "omp", capabilities: ["code", "shell", "files"] })
		.run();
	return true;
}
