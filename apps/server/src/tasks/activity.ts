import { i18nMsg, plainMsg, type ActivityItem } from "@clam/contracts";
import { nodeEvents, taskEvents, taskMessages, tasks } from "@clam/database";
import { and, desc, eq, inArray, like, lt } from "drizzle-orm";
import type { ServerContext } from "../context.ts";

export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 200;
const EXCERPT = 120;

export interface ActivityQuery {
	workspaceId?: string;
	limit?: number;
	/** ISO timestamp: only items strictly older. */
	before?: string;
}

/** The feed of the activity page: task status changes/results, discussion messages and peer changes, newest first. */
export function listActivity(ctx: Pick<ServerContext, "db" | "identity">, query: ActivityQuery = {}): ActivityItem[] {
	const limit = Math.min(Math.max(query.limit ?? ACTIVITY_DEFAULT_LIMIT, 1), ACTIVITY_MAX_LIMIT);
	const { db } = ctx;
	const { workspaceId, before } = query;

	// Each source is cut at `limit` (newest first): the merged top `limit` can never need more from any one of them.
	const events = db
		.select({
			taskId: taskEvents.taskId,
			seq: taskEvents.seq,
			summary: taskEvents.summary,
			i18n: taskEvents.i18n,
			at: taskEvents.createdAt,
			title: tasks.title,
			workspaceId: tasks.workspaceId,
			nodeName: tasks.executorNodeName,
		})
		.from(taskEvents)
		.innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
		.where(and(inArray(taskEvents.type, ["status", "result"]), before ? lt(taskEvents.createdAt, before) : undefined, workspaceId ? eq(tasks.workspaceId, workspaceId) : undefined))
		.orderBy(desc(taskEvents.createdAt), desc(taskEvents.seq))
		.limit(limit)
		.all()
		.map((e): ActivityItem => ({ id: `task:${e.taskId}:${e.seq}`, at: e.at, kind: "task", taskId: e.taskId, workspaceId: e.workspaceId, nodeName: e.nodeName, summary: `${e.title}: ${e.summary}`, ...(e.i18n && { subject: e.title, i18n: e.i18n }) }));

	const messages = db
		.select({
			id: taskMessages.id,
			taskId: taskMessages.taskId,
			text: taskMessages.text,
			at: taskMessages.createdAt,
			authorKind: taskMessages.authorKind,
			authorNodeName: taskMessages.authorNodeName,
			authorAgentName: taskMessages.authorAgentName,
			workspaceId: tasks.workspaceId,
		})
		.from(taskMessages)
		.innerJoin(tasks, eq(tasks.id, taskMessages.taskId))
		.where(and(before ? lt(taskMessages.createdAt, before) : undefined, workspaceId ? eq(tasks.workspaceId, workspaceId) : undefined))
		.orderBy(desc(taskMessages.createdAt), desc(taskMessages.id))
		.limit(limit)
		.all()
		.map((m): ActivityItem => {
			const author = m.authorKind === "agent" && m.authorAgentName ? `${m.authorAgentName}@${m.authorNodeName}` : m.authorNodeName;
			const text = m.text.replace(/\s+/g, " ").trim();
			return { id: `message:${m.id}`, at: m.at, kind: "message", taskId: m.taskId, workspaceId: m.workspaceId, nodeName: m.authorNodeName, summary: `${author}: ${text.length > EXCERPT ? `${text.slice(0, EXCERPT - 1)}…` : text}` };
		});

	// Peer changes belong to no workspace: they are left out when the feed is filtered by one.
	const peers = workspaceId
		? []
		: db
				.select()
				.from(nodeEvents)
				.where(and(like(nodeEvents.type, "peer.%"), before ? lt(nodeEvents.createdAt, before) : undefined))
				.orderBy(desc(nodeEvents.createdAt), desc(nodeEvents.id))
				.limit(limit)
				.all()
				.map((e): ActivityItem => {
					const name = typeof e.payload?.peerName === "string" ? e.payload.peerName : "a peer";
					const what = e.type.slice("peer.".length);
					const say = what === "added" ? i18nMsg("Peer {name} added", { name }) : what === "revoked" ? i18nMsg("Peer {name} revoked", { name }) : plainMsg(`Peer ${name} ${what}`);
					return { id: `node:${e.id}`, at: e.createdAt, kind: "peer", taskId: null, workspaceId: null, nodeName: name, summary: say.text, ...(say.i18n && { i18n: say.i18n }) };
				});

	return [...events, ...messages, ...peers].sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1)).slice(0, limit);
}

/**
 * Record peers being paired or revoked as feed entries (`node_events` rows `peer.added` / `peer.revoked`). Returns the
 * unsubscribe function.
 */
export function recordPeerActivity(ctx: Pick<ServerContext, "db" | "identity" | "network">): () => void {
	return ctx.network.peers.onChange((change) => {
		if (change.type !== "added" && change.type !== "revoked") return;
		const peerName = ctx.network.peers.row(change.peerId)?.name ?? change.peerId;
		const payload = change.type === "revoked" ? { peerId: change.peerId, peerName, by: change.by } : { peerId: change.peerId, peerName };
		ctx.db.insert(nodeEvents).values({ nodeId: ctx.identity.nodeId, type: `peer.${change.type}`, payload }).run();
	});
}
