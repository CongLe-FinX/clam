import { rm } from "node:fs/promises";
import path from "node:path";
import { agentSessions } from "@clam/database";
import { inArray } from "drizzle-orm";
import type { ServerContext } from "../context.ts";

function isInside(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Stop the runtimes of every session under the given projects, delete their session directories (only
 * those strictly inside `<dataDir>/sessions/`) and return the session ids. Database rows are NOT
 * removed here: callers delete the owning workspace/project and FK cascades remove the sessions.
 * Call `publishSessionRemovals` after the rows are gone.
 */
export async function teardownProjectSessions(ctx: ServerContext, projectIds: string[]): Promise<string[]> {
	if (projectIds.length === 0) return [];
	const rows = ctx.db
		.select({ id: agentSessions.id, sessionDir: agentSessions.sessionDir })
		.from(agentSessions)
		.where(inArray(agentSessions.projectId, projectIds))
		.all();
	const sessionsRoot = path.resolve(ctx.config.dataDir, "sessions");
	for (const row of rows) {
		try {
			await ctx.runtime.stop(row.id);
		} catch (err) {
			ctx.log.warn({ err, sessionId: row.id }, "failed to stop runtime while deleting");
		}
		const dir = path.resolve(row.sessionDir);
		if (isInside(sessionsRoot, dir)) {
			await rm(dir, { recursive: true, force: true });
		} else {
			ctx.log.warn({ sessionId: row.id, sessionDir: row.sessionDir }, "session dir outside data dir; left in place");
		}
	}
	return rows.map((r) => r.id);
}

export function publishSessionRemovals(ctx: ServerContext, sessionIds: string[]): void {
	for (const sessionId of sessionIds) ctx.bus.publish("sessions", { type: "remove", sessionId });
}
