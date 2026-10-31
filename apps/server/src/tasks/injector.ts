import type { TaskStatus } from "@clam/contracts";
import { buildMessageInjection, buildStatusNote, isTerminalStatus, type MessageKind } from "@clam/task-engine";
import { KeyedLock, errorText } from "../network/util.ts";
import type { InjectorApi, TaskHub } from "./hub.ts";
import { injectIntoSession } from "./session-injection.ts";
import type { TaskMessageRow, TaskRow } from "./store.ts";

/** The finished statuses the delegating agent is told about (a task `handed_off` stays the executor's business). */
const NOTIFIED_STATUSES: readonly TaskStatus[] = ["succeeded", "failed", "cancelled", "rejected"];

/**
 * Puts task messages and final status notes into the agent session of this node (the executing session on the
 * executor, the delegating one on the sender). Injection is per-session FIFO, idempotent (`injectedSessionId`,
 * prompt `clientId`) and retried when the session cannot take the prompt (runtime failed to start, node booting).
 */
export class TaskInjector implements InjectorApi {
	private readonly chains = new KeyedLock();
	/** Failed injections awaiting their retry, by message id (`note:<taskId>` for status notes). */
	private readonly retries = new Map<string, NodeJS.Timeout>();
	private readonly failures = new Map<string, number>();
	private stopped = false;

	constructor(private readonly hub: TaskHub) {}

	start(): void {
		this.stopped = false;
	}

	stop(): void {
		this.stopped = true;
		for (const timer of this.retries.values()) clearTimeout(timer);
		this.retries.clear();
	}

	async injectMessage(task: TaskRow, message: TaskMessageRow): Promise<boolean> {
		const sessionId = this.sessionOf(task);
		if (!sessionId) return false;
		return this.chains.run(sessionId, () => this.deliverMessage(task.id, message.id, sessionId)).catch(() => false);
	}

	async injectStatusNote(task: TaskRow): Promise<boolean> {
		if (task.direction !== "outgoing" || !task.senderSessionId) return false;
		const sessionId = task.senderSessionId;
		return this.chains.run(sessionId, () => this.deliverNote(task.id, sessionId)).catch(() => false);
	}

	async retryPending(): Promise<void> {
		try {
			this.failures.clear();
			for (const message of this.hub.store.uninjectedMessages()) {
				const task = this.hub.store.find(message.taskId);
				if (task && this.sessionOf(task) && !isTerminalStatus(task.status as TaskStatus)) await this.injectMessage(task, message);
			}
			for (const task of this.hub.store.list({ direction: "outgoing", statuses: [...NOTIFIED_STATUSES] })) {
				if (task.senderSessionId && task.notifiedStatus !== task.status) await this.injectStatusNote(task);
			}
		} catch (error) {
			this.hub.log.warn({ err: errorText(error) }, "re-injecting pending task messages failed");
		}
	}

	private sessionOf(task: TaskRow): string | null {
		return task.direction === "outgoing" ? task.senderSessionId : task.executorSessionId;
	}

	/** Runs inside the session's chain, so it re-reads the rows: an earlier link may already have done the work. */
	private async deliverMessage(taskId: string, messageId: string, sessionId: string): Promise<boolean> {
		const task = this.hub.store.find(taskId);
		const message = this.hub.store.message(messageId);
		if (!task || !message || this.sessionOf(task) !== sessionId) return false;
		if (message.injectedSessionId) return true;
		if (isTerminalStatus(task.status as TaskStatus)) return false;
		if (message.authorNodeId === this.hub.store.nodeId && message.authorKind === "agent") return false;
		try {
			this.hub.ctx.sessions.get(sessionId);
		} catch {
			return false;
		}
		try {
			const text = buildMessageInjection({
				taskId,
				title: task.title,
				author: { kind: message.authorKind as "human" | "agent" | "system", agentName: message.authorAgentName, nodeName: message.authorNodeName },
				kind: message.kind as MessageKind,
				text: message.text,
				role: this.hub.roleOf(task),
			});
			await injectIntoSession(this.hub.ctx, { sessionId, clientId: `mesh_msg_${messageId}`, text, kind: message.kind as MessageKind });
		} catch (error) {
			this.hub.log.warn({ err: errorText(error), taskId, messageId, sessionId }, "could not inject a task message into the session");
			this.scheduleRetry(messageId, () => this.retryMessage(messageId));
			return false;
		}
		this.failures.delete(messageId);
		this.hub.store.markInjected(messageId, sessionId);
		const fresh = this.hub.store.message(messageId) as TaskMessageRow;
		this.hub.changed(taskId, { messages: [fresh], notifyPeer: false });
		const current = this.hub.store.find(taskId);
		if (current && current.direction === "incoming") {
			try {
				await this.hub.executor.messageInjected(current, fresh);
			} catch (error) {
				this.hub.log.warn({ err: errorText(error), taskId, messageId }, "the executor could not process an injected message");
			}
		}
		return true;
	}

	private async deliverNote(taskId: string, sessionId: string): Promise<boolean> {
		const task = this.hub.store.find(taskId);
		if (!task || task.direction !== "outgoing" || task.senderSessionId !== sessionId) return false;
		const status = task.status as TaskStatus;
		if (!NOTIFIED_STATUSES.includes(status) || task.notifiedStatus === status) return false;
		try {
			this.hub.ctx.sessions.get(sessionId);
		} catch {
			return false;
		}
		try {
			const result = task.result;
			const text = buildStatusNote({
				taskId,
				title: task.title,
				status,
				summary: result?.summary,
				reason: task.reason,
				branch: result?.branch,
				commit: result?.commit,
				pushed: result?.pushed,
				compareUrl: result?.compareUrl,
				autoCompleted: result?.autoCompleted,
				artifacts: result?.artifacts,
			});
			await injectIntoSession(this.hub.ctx, { sessionId, clientId: `mesh_note_${taskId}_${status}`, text, kind: "note" });
		} catch (error) {
			this.hub.log.warn({ err: errorText(error), taskId, sessionId }, "could not inject the task status note into the session");
			this.scheduleRetry(`note:${taskId}`, () => this.retryNote(taskId));
			return false;
		}
		this.failures.delete(`note:${taskId}`);
		this.hub.store.update(taskId, { notifiedStatus: status });
		return true;
	}

	/** At most `injectRetries` retries per key and boot; `retryPending` starts over. */
	private scheduleRetry(key: string, retry: () => Promise<void>): void {
		const failed = (this.failures.get(key) ?? 0) + 1;
		this.failures.set(key, failed);
		if (this.stopped || failed > this.hub.timings.injectRetries || this.retries.has(key)) return;
		const timer = setTimeout(() => {
			this.retries.delete(key);
			void retry();
		}, this.hub.timings.injectRetryMs);
		timer.unref();
		this.retries.set(key, timer);
	}

	private async retryMessage(messageId: string): Promise<void> {
		const message = this.hub.store.message(messageId);
		const task = message && this.hub.store.find(message.taskId);
		if (message && task) await this.injectMessage(task, message);
	}

	private async retryNote(taskId: string): Promise<void> {
		const task = this.hub.store.find(taskId);
		if (task) await this.injectStatusNote(task);
	}
}
