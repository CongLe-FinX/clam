import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { TurnOutputFile } from "@clam/contracts";
import { agentSessions } from "./schema.ts";

/**
 * Files an agent turn produced in its project folder (migration `0010_turn_outputs`). One row per turn that produced some
 * (agent_start → agent_end), so a reload or another device shows the same "files from this turn" strip. `files` is the
 * capped list (`TurnOutputFile`); `truncated` says more changed than it lists. The strip belongs under the turn's last
 * assistant message (`anchor_message_id` / `anchor_timestamp`).
 */
export const turnOutputs = sqliteTable(
	"turn_outputs",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => agentSessions.id, { onDelete: "cascade" }),
		projectId: text("project_id").notNull(),
		anchorMessageId: text("anchor_message_id"),
		anchorTimestamp: integer("anchor_timestamp"),
		/** Epoch ms of the turn's start and end. */
		startedAt: integer("started_at").notNull(),
		endedAt: integer("ended_at").notNull(),
		files: text("files", { mode: "json" }).$type<TurnOutputFile[]>().notNull(),
		truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
		createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
	},
	(t) => [index("turn_outputs_session_idx").on(t.sessionId, t.endedAt)],
);
