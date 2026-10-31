import type { HandoffEnvironment, HandoffFailureCode, HandoffRole, HandoffState, SetupDecisionBody } from "@clam/contracts";
import { detectEnvironment, type SetupReport } from "@clam/handoff-engine";
import type { z } from "zod";
import { ApiError } from "../http/errors.ts";
import { errorText } from "../network/util.ts";
import { FaultInjected } from "./fault.ts";
import { HandoffStepError, type HandoffHub, type SessionKindApi } from "./hub.ts";
import { isTerminalState, newHandoffId, type HandoffRow, type HandoffSetupRow } from "./store.ts";

type BeforeInput = Parameters<SessionKindApi["beforeContinuation"]>[0];
type SourceInput = Parameters<SessionKindApi["recordSource"]>[0];

/** The target side walks the engine's states in this order (docs/handoff-protocol.md §3). */
const TARGET_ORDER: readonly HandoffState[] = ["received", "accepted", "persisted", "files_restored", "context_restored", "deps_ready", "validated", "session_created", "acked", "owner", "resumed", "completed"];
const position = (state: string): number => TARGET_ORDER.indexOf(state as HandoffState);

/** What a `kind: session` row keeps in `handoffs.meta.session` (never leaves the node). */
interface SessionMeta {
	dir: string;
	reason: "takeover" | "transfer";
	headCommit: string | null;
	/** The note that opens the continued conversation, and whether it went out (a restart finishes it exactly once, by `clientId`). */
	continuation: { text: string; clientId: string; sentAt: string | null } | null;
	/** `true` once the timeline said that commands wait for the user. */
	waitingNoted: boolean;
}

interface Waiter {
	promise: Promise<SetupReport>;
	resolve(report: SetupReport): void;
}

const emptyReport = (): SetupReport => ({ ran: [], skipped: [] });

/** A simulated crash (`CLAM_FAULT`) is never swallowed. */
function rethrowFault(error: unknown): void {
	if (error instanceof FaultInjected) throw error;
}

/**
 * The "Environment setup on this node" part of a continuation note, or null when there is nothing to tell. Same wording as the
 * task resume prompt (`buildResumePrompt`), so an agent reads the same thing for both kinds of hand-over.
 */
export function setupSection(report: SetupReport): string | null {
	const lines: string[] = [];
	for (const r of report.ran) {
		const outcome = r.timedOut ? "timed out" : r.exitCode === 0 ? "succeeded" : `exited with ${r.exitCode ?? "no exit code"}`;
		lines.push(`- Ran \`${r.command}\`: ${outcome}`);
	}
	for (const s of report.skipped) lines.push(`- Skipped \`${s.command}\`: ${s.reason}`);
	for (const issue of report.runtimeIssues ?? []) lines.push(`- Runtime issue: ${issue}`);
	if (report.validation) lines.push(`- Validation: ${report.validation}`);
	if (lines.length === 0) return null;
	return ["## Environment setup on this node", ...lines].join("\n");
}

/** `text` followed by the setup section of `report` (unchanged when there is nothing to report). */
export function withSetupSection(text: string, report: SetupReport): string {
	const section = setupSection(report);
	return section ? `${text}\n\n${section}` : text;
}

/**
 * M5 hand-over / takeover as `kind: session` handoffs (the Handoff Center shows them like task handoffs), plus dependency setup
 * (steps 5–6) before the continuation prompt of the new driver.
 *
 * TARGET row (the node that continues): its files (steps 2–3), snapshot (4) and local session (7) exist before `beforeContinuation`
 * is called, so those steps are recorded as done; steps 5–6 really run here (`hub.setup`, node policy `ask|auto|skip`), the rest records
 * the ownership the shared epoch already carries. SOURCE row (the node that lost the driver role): a short recorded walk.
 * Neither row ever talks to the peer: every transition is `notify: false`, and the peer has no row with that id.
 */
export class SessionKindService implements SessionKindApi {
	private readonly waiters = new Map<string, Waiter>();
	private readonly work = new Set<Promise<void>>();
	private stopped = false;

	constructor(private readonly hub: HandoffHub) {}

	private get store() {
		return this.hub.store;
	}

	private track(job: Promise<void>): void {
		const tracked = job.catch((error: unknown) => this.hub.log.error({ err: errorText(error) }, "session handoff work failed")).finally(() => this.work.delete(tracked));
		this.work.add(tracked);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		// A continuation that still waits is dropped on purpose: the next boot finishes it from the persisted row.
		this.waiters.clear();
		await Promise.allSettled([...this.work]);
	}

	// ------------------------------------------------------------------ target

	beforeContinuation(input: BeforeInput): Promise<SetupReport> {
		let row: HandoffRow;
		try {
			row = this.openTarget(input);
		} catch (error) {
			rethrowFault(error);
			this.hub.log.warn({ err: errorText(error), sharedId: input.sharedSessionId }, "could not record the shared hand-over as a handoff");
			return Promise.resolve(emptyReport());
		}
		// A row that is already finished (a repeated call) just answers with what it recorded.
		if (row.state === "failed" || row.state === "cancelled" || position(row.state) >= position("owner")) return Promise.resolve(this.reportOf(row));
		let waiter = this.waiters.get(row.id);
		if (!waiter) {
			const { promise, resolve } = Promise.withResolvers<SetupReport>();
			waiter = { promise, resolve };
			this.waiters.set(row.id, waiter);
			this.track(this.drive(row.id));
		}
		return waiter.promise;
	}

	/** Insert the target row once per `(shared session, epoch)`; walking its states is `drive`'s job. */
	private openTarget(input: BeforeInput): HandoffRow {
		const existing = this.find(input.sharedSessionId, input.toEpoch, "target");
		if (existing) return existing;
		const self = this.hub.ctx.identity.nodeId;
		const meta: SessionMeta = {
			dir: input.dir,
			reason: input.reason,
			headCommit: input.headCommit ?? null,
			continuation: input.continuation ? { ...input.continuation, sentAt: null } : null,
			waitingNoted: false,
		};
		const row = this.store.transaction(() => {
			const inserted = this.store.insert({
				id: newHandoffId(),
				kind: "session",
				role: "target",
				state: "received",
				peerId: input.fromNodeId,
				subjectId: input.sharedSessionId,
				title: input.title,
				workspaceId: input.workspaceId,
				projectId: input.projectId,
				sourceNodeId: input.fromNodeId,
				sourceNodeName: input.fromNodeName,
				sourceAgentName: input.fromAgentName ?? null,
				targetNodeId: self,
				targetNodeName: this.hub.nodeName(),
				targetAgentName: input.agentName,
				targetSessionId: input.sessionId,
				fromEpoch: input.toEpoch - 1,
				toEpoch: input.toEpoch,
				vcs: input.vcs,
				correlationId: `shared:${input.sharedSessionId}:${input.toEpoch}`,
				meta: { session: meta },
			});
			this.store.initTargetSteps(inserted.id);
			this.store.setStep(inserted.id, 1, "done", input.reason === "transfer" ? `${input.fromNodeName} handed the shared session over` : `${input.fromNodeName} did not hand over; continuing from its last checkpoint`);
			return inserted;
		});
		this.hub.note(row.id, input.reason === "transfer" ? `${input.fromNodeName} handed the shared session "${input.title}" over to this node (epoch ${input.toEpoch - 1} → ${input.toEpoch}).` : `This node continues the shared session "${input.title}" from ${input.fromNodeName}'s last checkpoint (epoch ${input.toEpoch - 1} → ${input.toEpoch}).`);
		return row;
	}

	private find(sharedSessionId: string, toEpoch: number, role: HandoffRole): HandoffRow | undefined {
		return this.store.bySubject(sharedSessionId, role).find((r) => r.kind === "session" && r.toEpoch === toEpoch);
	}

	private metaOf(row: HandoffRow): SessionMeta {
		const stored = row.meta.session as Partial<SessionMeta> | undefined;
		return { dir: stored?.dir ?? "", reason: stored?.reason ?? "takeover", headCommit: stored?.headCommit ?? null, continuation: stored?.continuation ?? null, waitingNoted: stored?.waitingNoted ?? false };
	}

	private patchSession(id: string, patch: Partial<SessionMeta>): HandoffRow {
		const row = this.store.get(id);
		return this.store.patchMeta(id, { session: { ...this.metaOf(row), ...patch } });
	}

	private reportOf(row: HandoffRow): SetupReport {
		return (row.meta.setupReport as SetupReport | undefined) ?? emptyReport();
	}

	/** Move the target row forward to `to` (no-op when it is already there or beyond), recording the step it completes. */
	private move(id: string, to: HandoffState, summary: string, step?: { n: number; state: "done" | "skipped"; detail: string }): HandoffRow {
		const row = this.store.get(id);
		if (row.state === "failed" || position(row.state) >= position(to)) return row;
		if (step) this.hub.setStep(id, step.n, step.state, step.detail);
		return this.hub.advance(id, to, { summary, notify: false });
	}

	/** Steps 2–4: what `performTakeover` did before it called us. */
	private restore(id: string): void {
		const row = this.store.get(id);
		const meta = this.metaOf(row);
		const epoch = row.toEpoch;
		this.move(id, "accepted", `Taking the driver role of "${row.title}" (epoch ${epoch})`);
		this.move(id, "persisted", "The checkpoint snapshot of the shared session is held on this node", { n: 2, state: "done", detail: "Checkpoint snapshot received from the former driver" });
		this.move(id, "files_restored", row.vcs === "files" ? "The working folder was restored from the checkpoint bundle" : "The working tree was aligned with the shared branch", {
			n: 3,
			state: "done",
			detail: row.vcs === "files" ? `Folder restored from the checkpoint bundle into ${meta.dir}` : `Working tree in ${meta.dir} aligned with the shared branch`,
		});
		this.move(id, "context_restored", "The session snapshot was unpacked into a new local session", { n: 4, state: "done", detail: "Session snapshot unpacked and bound to a new local session" });
	}

	/** Drive a target row forward (first run, approval, boot): restore, setup + validation, ownership; then release the continuation. */
	private drive(id: string): Promise<void> {
		return this.hub.lock.run(id, async () => {
			if (this.stopped) return;
			try {
				const row = this.store.get(id);
				if (row.state === "completed") return;
				if (row.state !== "failed" && row.state !== "cancelled") {
					if (position(row.state) < position("validated")) {
						this.restore(id);
						if ((await this.runSetup(id)) === "waiting") return;
					}
					this.finish(id);
				}
			} catch (error) {
				rethrowFault(error);
				// Whatever went wrong in the bookkeeping, the continuation prompt must not stay blocked: it goes out with the problem as a warning.
				this.hub.log.warn({ err: errorText(error), handoffId: id }, "shared hand-over setup failed unexpectedly");
				const detail = errorText(error, 300);
				const report: SetupReport = { ...this.reportOf(this.store.get(id)), runtimeIssues: [`Dependency setup could not be completed: ${detail}`] };
				this.store.patchMeta(id, { setupReport: report });
			}
			await this.release(id);
		});
	}

	/** Steps 5–6 with the node policy. `waiting` = commands wait for approval; `failed` = the row is failed and the continuation released. */
	private async runSetup(id: string): Promise<"ready" | "waiting" | "failed"> {
		const row = this.store.get(id);
		const meta = this.metaOf(row);
		this.hub.setStep(id, 5, "running", "Checking the project's dependencies");
		let step = 5;
		try {
			const environment: HandoffEnvironment = await detectEnvironment(meta.dir);
			this.store.update(id, { environment });
			const outcome = await this.hub.setup.setupAndValidate(id, { dir: meta.dir, environment, requiredFiles: [], gitCommit: row.vcs === "git" ? meta.headCommit : null, checkCommand: null });
			if (outcome.status === "waiting") {
				const waitingOn = outcome.pending.length;
				if (!meta.waitingNoted) {
					this.patchSession(id, { waitingNoted: true });
					this.hub.note(id, `Waiting for you to approve ${waitingOn} setup command${waitingOn === 1 ? "" : "s"} before the agent continues`);
				}
				this.hub.changed(id);
				return "waiting";
			}
			this.hub.setStep(id, 5, "done", "Dependencies set up");
			this.store.patchMeta(id, { setupReport: outcome.report });
			return "ready";
		} catch (error) {
			rethrowFault(error);
			const code = error instanceof HandoffStepError ? error.code : "deps_failed";
			if (error instanceof HandoffStepError && error.step !== null) step = error.step;
			this.fail(id, code, step, errorText(error, 500));
			return "failed";
		}
	}

	/** Setup done: record steps 5–9 (the shared epoch itself was already announced to the group by this node). */
	private finish(id: string): void {
		const row = this.store.get(id);
		const report = this.reportOf(row);
		const ran = report.ran.length;
		const skipped = report.skipped.length;
		const detail = ran === 0 && skipped === 0 ? "No setup commands were needed" : `${ran} command${ran === 1 ? "" : "s"} ran, ${skipped} skipped`;
		this.move(id, "deps_ready", `Dependencies ready: ${detail}`, { n: 5, state: "done", detail });
		const validated = report.validation ?? "Workspace validated";
		this.move(id, "validated", `Workspace validated: ${validated}`, { n: 6, state: "done", detail: validated });
		this.move(id, "session_created", `Local session ${row.targetSessionId ?? "(none)"} is bound to the shared session`, { n: 7, state: "done", detail: row.targetSessionId ? `Local session ${row.targetSessionId}` : "Local session created" });
		this.move(id, "acked", `No acknowledgement round: this node announces epoch ${row.toEpoch} to the group itself`, { n: 8, state: "skipped", detail: "Shared sessions need no acknowledgement from the former driver" });
		this.move(id, "owner", `This node is the driver of the shared session (epoch ${row.toEpoch})`, { n: 9, state: "done", detail: `Epoch ${row.toEpoch} announced to the group` });
	}

	/** A failing setup or validation: record `failed(code)`; the continuation prompt still goes out, carrying the failure as a warning. */
	private fail(id: string, code: HandoffFailureCode, step: number, detail: string): void {
		if (step === 6) this.hub.setStep(id, 5, "done", "Dependencies set up");
		const rows = this.store.setupRows(id);
		const report = this.setupRowsReport(rows);
		(report.runtimeIssues ??= []).push(`${code === "validation_failed" ? "Workspace validation" : "Dependency setup"} failed: ${detail}`);
		report.validation = `FAILED — ${detail}`;
		this.store.patchMeta(id, { setupReport: report });
		this.hub.setStep(id, step, "failed", detail);
		this.hub.transition(id, "failed", { summary: `Dependency setup failed: ${detail}`, failure: { code, detail, step }, notify: false });
	}

	private setupRowsReport(rows: HandoffSetupRow[]): SetupReport {
		const report: SetupReport = emptyReport();
		for (const r of rows) {
			if (r.state === "succeeded" || r.state === "failed" || r.state === "running") report.ran.push({ command: r.command, exitCode: r.exitCode });
			else report.skipped.push({ command: r.command, reason: r.state === "denied" ? "denied by the user" : r.state === "pending_approval" ? "not approved" : "skipped" });
		}
		return report;
	}

	/** Hand the report to the waiting continuation, or (after a restart: nobody waits) send the persisted note ourselves. */
	private async release(id: string): Promise<void> {
		const row = this.store.get(id);
		const report = this.reportOf(row);
		const waiter = this.waiters.get(id);
		if (waiter) {
			this.waiters.delete(id);
			waiter.resolve(report);
			return;
		}
		await this.deliver(row, report);
	}

	/** Boot path: send the continuation note unless it went out already (the transcript is the witness), then finish the row. */
	private async deliver(row: HandoffRow, report: SetupReport): Promise<void> {
		const meta = this.metaOf(row);
		const continuation = meta.continuation;
		let error: string | undefined;
		if (continuation && continuation.sentAt === null && row.targetSessionId) {
			try {
				if (!(await this.alreadySent(row.targetSessionId, continuation.clientId))) {
					await this.hub.ctx.sessions.prompt(row.targetSessionId, { message: withSetupSection(continuation.text, report), clientId: continuation.clientId });
				}
			} catch (cause) {
				rethrowFault(cause);
				error = errorText(cause, 300);
			}
		}
		this.continued({ sharedSessionId: row.subjectId, toEpoch: row.toEpoch, ...(error && { error }) });
	}

	private async alreadySent(sessionId: string, clientId: string): Promise<boolean> {
		try {
			let cursor: string | undefined;
			do {
				const page = await this.hub.ctx.sessions.messages(sessionId, { limit: 256, ...(cursor && { cursor }) });
				if (page.messages.some((m) => m.role === "user" && m.clientId === clientId)) return true;
				cursor = page.nextCursor ?? undefined;
			} while (cursor);
		} catch (error) {
			this.hub.log.warn({ err: errorText(error), sessionId }, "could not check whether the continuation note was sent");
		}
		return false;
	}

	continued(input: { sharedSessionId: string; toEpoch: number; error?: string }): void {
		try {
			const row = this.find(input.sharedSessionId, input.toEpoch, "target");
			if (!row) return;
			const meta = this.metaOf(row);
			if (!input.error && meta.continuation && meta.continuation.sentAt === null) this.patchSession(row.id, { continuation: { ...meta.continuation, sentAt: new Date().toISOString() } });
			if (row.state === "failed" || row.state === "cancelled" || row.state === "completed") return;
			if (position(row.state) < position("owner")) return;
			const sent = input.error ? `The continuation note could not be sent: ${input.error}` : "The continuation note was sent to the agent; the work goes on in the new session";
			this.move(row.id, "resumed", sent, input.error ? { n: 10, state: "done", detail: sent } : { n: 10, state: "done", detail: "Continuation note sent to the new session" });
			this.move(row.id, "completed", `Hand-over of "${row.title}" completed`);
		} catch (error) {
			rethrowFault(error);
			this.hub.log.warn({ err: errorText(error), sharedId: input.sharedSessionId }, "could not complete the shared hand-over record");
		}
	}

	async setupDecision(id: string, body: z.infer<typeof SetupDecisionBody>): Promise<HandoffRow> {
		const row = this.store.get(id);
		if (row.kind !== "session" || row.role !== "target") throw ApiError.conflict("This is not a shared-session hand-over of this node");
		if (isTerminalState(row) || position(row.state) >= position("validated")) throw ApiError.conflict(`This hand-over is already ${row.state}; there is nothing left to approve`);
		this.hub.setup.decide(id, body);
		// Commands may run for minutes: the request returns now, the Handoff Center follows the row.
		this.track(this.drive(id));
		return this.store.get(id);
	}

	// ------------------------------------------------------------------ source

	recordSource(input: SourceInput): HandoffRow {
		const existing = this.find(input.sharedSessionId, input.toEpoch, "source");
		if (existing) {
			if (!isTerminalState(existing)) this.completeSource(existing.id, input);
			return this.store.get(existing.id);
		}
		const row = this.store.insert({
			id: newHandoffId(),
			kind: "session",
			role: "source",
			state: "offered",
			peerId: input.toNodeId,
			subjectId: input.sharedSessionId,
			title: input.title,
			workspaceId: input.workspaceId,
			sourceNodeId: this.hub.ctx.identity.nodeId,
			sourceNodeName: this.hub.nodeName(),
			sourceAgentName: input.agentName,
			sourceSessionId: input.sessionId,
			targetNodeId: input.toNodeId,
			targetNodeName: input.toNodeName,
			targetAgentName: input.toAgentName ?? null,
			fromEpoch: input.fromEpoch,
			toEpoch: input.toEpoch,
			vcs: input.vcs,
			correlationId: `shared:${input.sharedSessionId}:${input.toEpoch}`,
			meta: { session: { reason: input.reason } },
		});
		this.hub.note(row.id, input.reason === "transfer" ? `The driver role of "${input.title}" was handed over to ${input.toNodeName} (epoch ${input.fromEpoch} → ${input.toEpoch})` : `${input.toNodeName} continued "${input.title}" as driver without a hand-over (epoch ${input.fromEpoch} → ${input.toEpoch})`);
		return this.completeSource(row.id, input);
	}

	/** offered → accepted → awaiting_ack → acked → released → completed, every hop persisted (idempotent: resumes from the current state). */
	private completeSource(id: string, input: SourceInput): HandoffRow {
		const to = input.toNodeName;
		const epoch = input.toEpoch;
		const walk: Array<[HandoffState, string]> = [
			["accepted", `${to} took over the driver role`],
			["awaiting_ack", `Waiting for ${to}'s announcement of epoch ${epoch}`],
			["acked", `${to}'s announcement of epoch ${epoch} arrived and is the current epoch`],
			["released", "This node released the driver role: its session is a read-only copy and the work continues on the new driver"],
			["completed", `This node follows ${to} as a participant`],
		];
		let row = this.store.get(id);
		for (const [state, summary] of walk) row = this.hub.advance(id, state, { summary, notify: false });
		return row;
	}

	// ------------------------------------------------------------------ boot

	start(): void {
		this.stopped = false;
		for (const row of this.store.list({ kind: "session" })) {
			try {
				if (row.role === "source") {
					if (!isTerminalState(row)) this.finishSourceAtBoot(row);
					continue;
				}
				const meta = this.metaOf(row);
				const unsent = meta.continuation !== null && meta.continuation.sentAt === null;
				if (isTerminalState(row) && !(row.state === "failed" && unsent)) continue;
				// Pending approvals are re-armed (their rows persist in `handoff_setup`); a finished setup whose note never went out is delivered.
				this.track(this.drive(row.id));
			} catch (error) {
				rethrowFault(error);
				this.hub.log.warn({ err: errorText(error), handoffId: row.id }, "could not re-arm a shared hand-over record");
			}
		}
	}

	private finishSourceAtBoot(row: HandoffRow): void {
		const meta = row.meta.session as { reason?: "takeover" | "transfer" } | undefined;
		this.completeSource(row.id, {
			sharedSessionId: row.subjectId,
			title: row.title,
			workspaceId: row.workspaceId,
			toNodeId: row.targetNodeId,
			toNodeName: row.targetNodeName,
			fromEpoch: row.fromEpoch,
			toEpoch: row.toEpoch,
			sessionId: row.sourceSessionId,
			agentName: row.sourceAgentName,
			reason: meta?.reason ?? "takeover",
			vcs: row.vcs === "files" ? "files" : "git",
		});
	}
}
