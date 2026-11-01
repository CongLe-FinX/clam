import { rm } from "node:fs/promises";
import { type I18nMessage, i18nMsg } from "@clam/contracts";
import { projects, tasks } from "@clam/database";
import type { HandoffManifest } from "@clam/handoff-engine";
import { eq } from "drizzle-orm";
import { deleteManagedFolder } from "../services/project-folders.ts";
import { execState } from "../tasks/exec-state.ts";
import type { TaskEventRow, TaskRow } from "../tasks/store.ts";
import { type HandoffHub, HandoffStepError } from "./hub.ts";
import type { HandoffRow } from "./store.ts";

/**
 * How the task row of a handed-over task comes to exist on the target (all three freeze it with `execState.handoffId` until step 9):
 * - `new`: this node never knew the task; an `incoming` row is inserted;
 * - `home`: this node is the task's SENDER (the task "returns home"): its outgoing mirror row becomes the local executor row;
 * - `revive`: this node executed the task before and handed it off (`handed_off`, fenced); it takes it back at a higher epoch.
 */
export type PersistMode = "new" | "home" | "revive";

/** Columns of an existing task row that `home` / `revive` change, saved in `handoffs.meta.taskBackup` so a cleanup can put them back. */
const BACKED_UP = ["direction", "peerId", "status", "fenced", "projectId", "lastEventSeq", "finishedAt", "reason", "executorNodeId", "executorNodeName", "executorAgentId", "executorAgentName", "executorSessionId", "execState"] as const;
type BackedUpColumn = (typeof BACKED_UP)[number];
type TaskBackup = { mode: PersistMode; columns?: Pick<TaskRow, BackedUpColumn> };

export function taskBackupOf(row: Pick<HandoffRow, "meta">): TaskBackup | null {
	const value = row.meta.taskBackup;
	return typeof value === "object" && value !== null ? (value as TaskBackup) : null;
}

/** What the local task row for this task id says about the handoff: how it would be persisted, and the epoch this node knows (null for a task it never saw). */
export function classifyTask(hub: HandoffHub, manifest: HandoffManifest): { mode: PersistMode; knownEpoch: number | null; task: TaskRow | null } | { conflict: I18nMessage } {
	const task = hub.ctx.tasks.store.find(manifest.task.id) ?? null;
	if (!task) return { mode: "new", knownEpoch: null, task: null };
	const self = hub.ctx.identity.nodeId;
	if (task.direction === "outgoing") {
		if (manifest.task.sender?.nodeId !== self) return { conflict: i18nMsg("This node knows that task as one it delegated to another node, but it is not the task's sender in the manifest") };
		if (["succeeded", "failed", "cancelled", "rejected", "handed_off"].includes(task.status)) return { conflict: i18nMsg("The task is {status} on this node; a finished task cannot be handed back", { status: task.status }) };
		return { mode: "home", knownEpoch: task.epoch, task };
	}
	if (task.status === "handed_off" && task.fenced) return { mode: "revive", knownEpoch: Math.max(task.epoch, task.highestSeenEpoch), task };
	return { conflict: i18nMsg("This node already executes that task ({status}, epoch {epoch})", { status: task.status, epoch: task.epoch }) };
}

/**
 * Step 2 (task side). ONE transaction: the frozen local task row (insert / flip / revive) and the discussion thread of the manifest
 * (idempotent by message id). Re-entrant: a row already frozen by this handoff is left as it is.
 */
export function persistTaskRow(hub: HandoffHub, row: HandoffRow, manifest: HandoffManifest, project: { id: string }, agent: { id: string; name: string }): PersistMode {
	const tasksStore = hub.ctx.tasks.store;
	const self = hub.ctx.identity.nodeId;
	const selfName = hub.nodeName();
	const existing = tasksStore.find(manifest.task.id);
	if (existing && execState(existing).handoffId === row.id) {
		return taskBackupOf(row)?.mode ?? "new";
	}
	const classified = classifyTask(hub, manifest);
	if ("conflict" in classified) throw new HandoffStepError("manifest_invalid", classified.conflict, 2);
	const { mode } = classified;
	const sender = manifest.task.sender;
	if (!sender) throw new HandoffStepError("manifest_invalid", i18nMsg("The manifest names no sender for the task"), 2);

	hub.store.transaction(() => {
		const executor = { executorNodeId: self, executorNodeName: selfName, executorAgentId: agent.id, executorAgentName: agent.name };
		const lastEventSeq = Math.max(manifest.task.lastEventSeq, existing?.lastEventSeq ?? 0);
		if (mode === "new") {
			tasksStore.insert({
				id: manifest.task.id,
				direction: "incoming",
				peerId: sender.nodeId,
				workspaceId: manifest.workspaceId,
				projectId: project.id,
				title: manifest.task.title,
				description: manifest.task.description,
				status: "accepted",
				epoch: manifest.fromEpoch,
				highestSeenEpoch: manifest.fromEpoch,
				repoUrl: manifest.task.repo?.url ?? manifest.git?.repoUrl ?? null,
				repoBranch: manifest.task.repo?.branch ?? manifest.git?.baseBranch ?? null,
				repoCommit: manifest.task.repo?.commit ?? null,
				deliverAs: manifest.task.deliverAs,
				constraints: manifest.task.constraints,
				senderNodeId: sender.nodeId,
				senderNodeName: sender.nodeName,
				senderAgentId: sender.agentId,
				senderAgentName: sender.agentName,
				...executor,
				correlationId: manifest.task.taskCorrelationId ?? manifest.correlationId,
				lastEventSeq,
				execState: { handoffId: row.id },
			});
			hub.store.patchMeta(row.id, { taskBackup: { mode } satisfies TaskBackup });
		} else if (existing) {
			const columns = Object.fromEntries(BACKED_UP.map((c) => [c, existing[c]])) as Pick<TaskRow, BackedUpColumn>;
			hub.store.patchMeta(row.id, { taskBackup: { mode, columns } satisfies TaskBackup });
			if (mode === "home") {
				// The sender's still-pending calls to the previous executor can never be delivered (this node executes now): drop them.
				for (const item of tasksStore.outboxOfTask(existing.id)) {
					if (item.state !== "pending") continue;
					tasksStore.updateOutbox(item.id, { state: "cancelled", lastError: "The task returned to this node" });
					if (item.kind === "task.cancel") hub.store.patchMeta(row.id, { pendingCancel: true });
					if (item.kind === "task.message" && item.refId) tasksStore.setMessageDelivery(item.refId, "local");
				}
			}
			tasksStore.update(existing.id, {
				direction: "incoming",
				peerId: sender.nodeId,
				projectId: project.id,
				status: "accepted",
				fenced: false,
				finishedAt: null,
				reason: null,
				lastEventSeq,
				...executor,
				executorSessionId: null,
				execState: { handoffId: row.id },
			});
		}
		for (const m of manifest.task.thread) {
			tasksStore.insertMessage({
				id: m.id,
				taskId: manifest.task.id,
				authorKind: m.authorKind,
				authorNodeId: m.authorNodeId,
				authorNodeName: m.authorNodeName,
				authorAgentId: m.authorAgentId,
				authorAgentName: m.authorAgentName,
				kind: m.kind,
				text: m.text,
				createdAt: m.createdAt,
				delivery: "local",
				injectedSessionId: null,
			});
		}
	});
	hub.ctx.tasks.changed(manifest.task.id, { notifyPeer: false });
	return mode;
}

/**
 * Step 9 on the task row, idempotent: the epoch moves to `toEpoch`, the freeze marker goes, the executor columns point here, a `note`
 * ("Handed over from …") and the status `accepted → running` continue the timeline at `eventSeqBase + 1`, then the executor adopts the
 * task (spawn overrides, session map, tree). Returns the event seq the previous executor ended at, which the sender continues from.
 */
export function acquireTaskRow(hub: HandoffHub, row: HandoffRow, manifest: HandoffManifest, eventSeqBase: number): void {
	const tasksStore = hub.ctx.tasks.store;
	const task = tasksStore.get(manifest.task.id);
	const frozen = execState(task).handoffId === row.id;
	if (frozen) {
		const events: TaskEventRow[] = [];
		hub.store.transaction(() => {
			const { handoffId: _frozen, ...rest } = task.execState;
			tasksStore.update(task.id, {
				epoch: row.toEpoch,
				highestSeenEpoch: Math.max(task.highestSeenEpoch, row.toEpoch),
				fenced: false,
				lastEventSeq: Math.max(task.lastEventSeq, eventSeqBase),
				executorNodeId: hub.ctx.identity.nodeId,
				executorNodeName: hub.nodeName(),
				executorAgentId: row.targetAgentId,
				executorAgentName: row.targetAgentName,
				executorSessionId: row.targetSessionId,
				execState: rest,
			});
			events.push(
				tasksStore.appendEvent(task.id, {
					type: "note",
					summary: i18nMsg("Handed over from {source} (epoch {from} → {to}); continuing on {node}", { source: manifest.source.name, from: row.fromEpoch, to: row.toEpoch, node: hub.nodeName() }),
					payload: { handoffId: row.id, fromNodeId: manifest.source.nodeId, fromEpoch: row.fromEpoch, toEpoch: row.toEpoch },
				}),
			);
			if (task.status === "accepted") events.push(tasksStore.transition(task.id, "running", { from: ["accepted"] }).event);
		});
		hub.ctx.tasks.changed(task.id, { events, notifyPeer: true });
	}
	hub.ctx.tasks.executor.adoptHandedOver(task.id);
}

/**
 * Cleanup of the task side (docs §6.3): a task row this handoff inserted is deleted (with its artifacts), one it flipped or revived gets its
 * columns back. Only while the handoff still holds the freeze marker, i.e. before ownership was acquired.
 */
export async function discardTaskRow(hub: HandoffHub, row: HandoffRow): Promise<string | null> {
	const tasksStore = hub.ctx.tasks.store;
	const task = tasksStore.find(row.subjectId);
	if (!task || execState(task).handoffId !== row.id) return null;
	const backup = taskBackupOf(row);
	if (backup?.mode === "home" || backup?.mode === "revive") {
		if (backup.columns) tasksStore.update(task.id, backup.columns);
		hub.ctx.tasks.changed(task.id, { notifyPeer: false });
		return `Task ${backup.mode === "home" ? "is the sender's mirror again" : "stays handed off"}`;
	}
	hub.ctx.db.delete(tasks).where(eq(tasks.id, task.id)).run();
	await rm(hub.ctx.tasks.artifacts.taskDir(task.id), { recursive: true, force: true });
	hub.ctx.tasks.changed(task.id, { notifyPeer: false });
	return "Removed the frozen task record";
}

/** Cleanup of a managed project this handoff created for the restored files. */
export async function discardCreatedProject(hub: HandoffHub, row: HandoffRow): Promise<string | null> {
	const id = row.meta.createdProjectId;
	if (typeof id !== "string") return null;
	const project = hub.ctx.db.select().from(projects).where(eq(projects.id, id)).get();
	if (!project) return null;
	const inUse = hub.ctx.tasks.store.list({ projectId: id }).length > 0;
	if (inUse) return `Left project ${project.name}: a task refers to it`;
	hub.ctx.db.delete(projects).where(eq(projects.id, id)).run();
	await deleteManagedFolder(hub.ctx, project);
	return `Removed the folder created for the handoff`;
}
