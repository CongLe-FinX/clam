import { mkdirSync } from "node:fs";
import path from "node:path";
import type { wire } from "@clam/agent-network";
import {
	type CreateTaskHandoffBody,
	type DecideHandoffBody,
	type Handoff,
	type HandoffDetail,
	type HandoffListQuery,
	type HandoffRole,
	type HandoffState,
	type HandoffTopicEvent,
	type I18nMessage,
	i18nMsg,
	type SetupDecisionBody,
} from "@clam/contracts";
import { transitionPath } from "@clam/handoff-engine";
import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { KeyedLock } from "../network/util.ts";
import { readNodeSettings } from "../services/settings.ts";
import { FaultInjected, FaultInjector, type FaultOptions } from "./fault.ts";
import { FenceService } from "./fence.ts";
import {
	DEFAULT_HANDOFF_TIMINGS,
	type HandoffHub,
	type HandoffOutboxItem,
	type HandoffTimings,
	type HandoffTransitionOptions,
} from "./hub.ts";
import { handoffOutboxHandlers } from "./outbox.ts";
import { RecoveryService } from "./recovery.ts";
import { SessionKindService } from "./session-kind.ts";
import { DependencySetup } from "./setup.ts";
import { SourceFlow } from "./source.ts";
import { HandoffStore, type HandoffRow, type StepState } from "./store.ts";
import { TargetFlow } from "./target.ts";

export interface HandoffServiceOptions {
	timings?: Partial<HandoffTimings>;
	/** Fault injection (default: `CLAM_FAULT` from the environment, inert when unset). */
	fault?: FaultOptions;
}

/**
 * Target states the source is told about with `POST /handoffs/:id/state` (the others have their own call: `received` is the offer,
 * `accepted` the accept, `acked` the ack).
 */
export const TARGET_NOTIFIED_STATES: readonly HandoffState[] = ["rejected", "failed", "cancelled", "persisted", "files_restored", "context_restored", "deps_ready", "validated", "session_created", "owner", "resumed", "completed"];
/** Source states the target is told about. `released` lets the target move `resumed → completed`. */
export const SOURCE_NOTIFIED_STATES: readonly HandoffState[] = ["cancelled", "reclaimed", "expired", "released"];

/**
 * Composition root of the handoff engine (docs/handoff-protocol.md, M7): owns the store, the publication of changes, the outbox helper
 * and the fault-injection seam every unit needs, and wires the units (`source`, `target`, `setup`, `fence`, `recovery`, `sessionKind`).
 * Peer calls ride the task engine's durable outbox; the service starts and stops with the task engine (`TaskService`).
 */
export class HandoffService implements HandoffHub {
	readonly store: HandoffStore;
	readonly log: FastifyBaseLogger;
	readonly timings: HandoffTimings;
	readonly lock = new KeyedLock();
	readonly fault: FaultInjector;
	readonly source: SourceFlow;
	readonly target: TargetFlow;
	readonly setup: DependencySetup;
	readonly fence: FenceService;
	readonly recovery: RecoveryService;
	readonly sessionKind: SessionKindService;
	private readonly root: string;
	/** Per handoff, the highest timeline event `seq` already published (see `publish`). */
	private readonly publishedSeq = new Map<string, number>();
	private prepared = false;

	constructor(
		readonly ctx: ServerContext,
		options: HandoffServiceOptions = {},
	) {
		this.log = ctx.log;
		this.timings = { ...DEFAULT_HANDOFF_TIMINGS, ...options.timings };
		this.store = new HandoffStore(ctx.db, { nodeId: ctx.identity.nodeId });
		this.fault = new FaultInjector(options.fault);
		this.root = path.join(ctx.config.dataDir, "handoffs");
		// Units only keep the hub; none may call another unit from its constructor.
		this.fence = new FenceService(this);
		this.setup = new DependencySetup(this);
		this.source = new SourceFlow(this);
		this.target = new TargetFlow(this);
		this.recovery = new RecoveryService(this);
		this.sessionKind = new SessionKindService(this);
	}

	nodeName(): string {
		return readNodeSettings(this.ctx.db).nodeName;
	}

	// ------------------------------------------------------------------ lifecycle

	/**
	 * Before the task engine opens any runtime: register the outbox kinds, the prompt guard and run the boot fence scan, so a fenced
	 * task's session can never be started, resumed or prompted (docs §8.1).
	 */
	prepare(): void {
		if (this.prepared) return;
		this.prepared = true;
		for (const [kind, handler] of Object.entries(handoffOutboxHandlers(this))) this.ctx.tasks.outbox.register(kind, handler);
		this.ctx.sessions.addPromptGuard((row, input) => this.fence.guardPrompt(row, input));
		this.fence.bootScan();
	}

	/** After the outbox and the executor run: boot recovery of every non-terminal handoff, timers, peer reconnect reconcile. */
	start(): void {
		this.prepare();
		this.recovery.start();
		this.sessionKind.start();
	}

	async stop(): Promise<void> {
		await this.recovery.stop();
		await this.source.stop();
		await this.target.stop();
		await this.sessionKind.stop();
	}

	// ------------------------------------------------------------------ the hub

	/** True once a fault fired in `throw` mode: the node "crashed" and persists nothing more. */
	private assertAlive(): void {
		if (this.fault.crashed) throw new FaultInjected("crashed");
	}

	transition(id: string, to: HandoffState, options: HandoffTransitionOptions): HandoffRow {
		this.assertAlive();
		const { row } = this.store.transaction(() => {
			const result = this.store.transition(id, to, {
				summary: options.summary,
				...(options.from && { from: options.from }),
				patch: {
					...options.patch,
					...(options.failure && { failureCode: options.failure.code, failureDetail: options.failure.detail.text, failureI18n: options.failure.detail.i18n ?? null, failureStep: options.failure.step ?? null }),
				},
				...(options.nodeId && { nodeId: options.nodeId }),
			});
			for (const item of options.enqueue ?? []) this.queue(result.row, item);
			if (options.notify !== false && result.row.kind === "task" && this.isNotified(result.row.role as HandoffRole, to)) this.queue(result.row, this.stateNotice(result.row, to, options));
			return result;
		});
		this.publish(row);
		this.fault.check(row.role as HandoffRole, to);
		this.ctx.tasks.outbox.kick(row.peerId);
		return row;
	}

	faultPoint(id: string): void {
		this.assertAlive();
		const row = this.store.get(id);
		this.fault.check(row.role as HandoffRole, row.state as HandoffState);
	}

	advance(id: string, target: HandoffState, options: HandoffTransitionOptions): HandoffRow {
		const current = this.store.get(id);
		if (current.state === target) return current;
		const hops = transitionPath(current.role as HandoffRole, current.state as HandoffState, target);
		if (!hops) throw new ApiError(409, "illegal_transition", i18nMsg("Handoff cannot go from {fromStatus} to {toStatus}", { fromStatus: current.state, toStatus: target }), { from: current.state, to: target });
		let row = current;
		for (const hop of hops) row = this.transition(id, hop, hop === target ? options : { summary: options.summary, notify: false });
		return row;
	}

	note(id: string, summary: I18nMessage): void {
		this.assertAlive();
		const row = this.store.get(id);
		this.store.appendEvent(id, { state: row.state as HandoffState, summary });
		this.publish(row);
	}

	enqueue(row: HandoffRow, item: HandoffOutboxItem): void {
		this.assertAlive();
		this.queue(row, item);
		this.ctx.tasks.outbox.kick(item.peerId ?? row.peerId);
	}

	private queue(row: HandoffRow, item: HandoffOutboxItem): void {
		const peerId = item.peerId ?? row.peerId;
		// Items of one (handoff, peer) pair go out in order: the ack never overtakes the accept, a state notice never overtakes the ack.
		this.ctx.tasks.store.enqueue({
			peerId,
			taskId: `${row.id}:${peerId}`,
			kind: item.kind,
			refId: row.id,
			path: item.path,
			body: item.body,
			idempotencyKey: item.idempotencyKey ?? `${item.kind}:${row.id}`,
			correlationId: row.correlationId,
		});
	}

	private isNotified(role: HandoffRole, to: HandoffState): boolean {
		if (role === "target") return TARGET_NOTIFIED_STATES.includes(to);
		return SOURCE_NOTIFIED_STATES.includes(to);
	}

	/** The `POST /handoffs/:id/state` that announces a state to the other node. */
	private stateNotice(row: HandoffRow, to: HandoffState, options: HandoffTransitionOptions): HandoffOutboxItem {
		const failure = options.failure ?? (row.failureCode ? { code: row.failureCode, detail: { text: row.failureDetail ?? "", i18n: row.failureI18n ?? undefined }, step: row.failureStep } : undefined);
		const body: wire.HandoffStateRequest = {
			epoch: row.toEpoch,
			state: to,
			summary: options.summary.text,
			...(options.summary.i18n && { summaryI18n: options.summary.i18n }),
			...(failure && (to === "failed" || to === "rejected") && { failure: { code: failure.code, detail: failure.detail.text, ...(failure.detail.i18n && { i18n: failure.detail.i18n }), step: failure.step ?? null } }),
			...(options.deadlineAt && { deadlineAt: options.deadlineAt }),
			...(row.targetSessionId && { targetSessionId: row.targetSessionId }),
			at: new Date().toISOString(),
		};
		return { kind: "handoff.state", path: `/handoffs/${row.id}/state`, body, idempotencyKey: `handoff.state:${row.id}:${row.role}:${to}` };
	}

	/**
	 * Publish the row on `handoffs` + `handoff:<id>`, followed by every timeline event that was persisted since the last publish
	 * of this handoff (all of them for the first publish after a boot: clients upsert by `seq`). Deriving the events from the log
	 * instead of from whoever appended them means no caller can persist an event the open page never hears about.
	 */
	private publish(row: HandoffRow): void {
		const message: HandoffTopicEvent = { type: "handoff", handoff: this.store.toHandoff(row) };
		this.ctx.bus.publish("handoffs", message);
		this.ctx.bus.publish(`handoff:${row.id}`, message);
		const after = this.publishedSeq.get(row.id) ?? 0;
		let last = after;
		for (const event of this.store.events(row.id)) {
			if (event.seq <= after) continue;
			last = Math.max(last, event.seq);
			this.ctx.bus.publish(`handoff:${row.id}`, { type: "event", handoffId: row.id, event: this.store.toEvent(event) } satisfies HandoffTopicEvent);
		}
		this.publishedSeq.set(row.id, last);
	}

	setStep(id: string, n: number, state: StepState, detail?: string | I18nMessage | null): void {
		this.store.setStep(id, n, state, detail);
		this.changed(id);
	}

	changed(id: string): void {
		const row = this.store.find(id);
		if (row) this.publish(row);
	}

	assertPeerCapable(peerId: string, direction: "granted" | "received"): void {
		const peer = this.ctx.network.peers.row(peerId);
		if (!peer || peer.status === "revoked") throw ApiError.notFound("Peer");
		const list = (direction === "granted" ? peer.grantedCapabilities : peer.receivedCapabilities) as string[];
		if (!list.includes("handoff.receive")) {
			throw new ApiError(
				409,
				"capability_missing",
				direction === "received"
					? i18nMsg("{peer} has not granted this node the capability handoff.receive. Ask its user to enable handoffs for this node (Network → peers).", { peer: peer.name })
					: i18nMsg("This node has not granted {peer} the capability handoff.receive, which it needs for handoffs. Grant it in Network → {peer}.", { peer: peer.name }),
				{ missing: ["handoff.receive"], grantedBy: direction === "received" ? peer.id : this.ctx.identity.nodeId },
			);
		}
	}

	statusOf(row: HandoffRow): wire.HandoffStatusResponse {
		const task = row.kind === "task" ? this.ctx.tasks.store.find(row.subjectId) : undefined;
		return {
			handoffId: row.id,
			role: row.role as HandoffRole,
			state: row.state,
			taskId: row.subjectId,
			fromEpoch: row.fromEpoch,
			toEpoch: row.toEpoch,
			taskEpoch: task?.epoch ?? row.fromEpoch,
			manifestSha256: row.manifestSha256,
			deadlineAt: row.deadlineAt,
			ackAt: row.ackAt,
			targetSessionId: row.targetSessionId,
			fencingToken: row.fencingToken,
			failure: row.failureCode ? { code: row.failureCode, detail: row.failureDetail ?? "", ...(row.failureI18n && { i18n: row.failureI18n }), step: row.failureStep } : null,
			lastEventSeq: task?.lastEventSeq ?? null,
		};
	}

	dir(id: string): string {
		const dir = path.join(this.root, id);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return dir;
	}

	// ------------------------------------------------------------------ local API

	list(query: z.infer<typeof HandoffListQuery>): Handoff[] {
		return this.store
			.list({ ...(query.role && { role: query.role }), ...(query.kind && { kind: query.kind }), ...(query.active !== undefined && { active: query.active === "true" }) })
			.map((row) => this.store.toHandoff(row));
	}

	detail(id: string): HandoffDetail {
		const row = this.store.get(id);
		return { handoff: this.store.toHandoff(row), events: this.store.events(id).map((e) => this.store.toEvent(e)) };
	}

	view(row: HandoffRow): Handoff {
		return this.store.toHandoff(row);
	}

	async create(body: z.infer<typeof CreateTaskHandoffBody>): Promise<Handoff> {
		return this.view(await this.source.create(body));
	}

	async decide(id: string, body: z.infer<typeof DecideHandoffBody>): Promise<Handoff> {
		this.requireRole(id, "target");
		return this.view(await this.target.decide(id, body));
	}

	async setupDecision(id: string, body: z.infer<typeof SetupDecisionBody>): Promise<Handoff> {
		const row = this.requireRole(id, "target");
		return this.view(row.kind === "session" ? await this.sessionKind.setupDecision(id, body) : await this.target.setupDecision(id, body));
	}

	async retry(id: string): Promise<Handoff> {
		const row = this.store.get(id);
		return this.view(row.role === "source" ? await this.source.retry(id) : await this.target.retry(id));
	}

	async cancel(id: string): Promise<Handoff> {
		const row = this.store.get(id);
		return this.view(row.role === "source" ? await this.source.cancel(id) : await this.target.cancel(id));
	}

	async extend(id: string, minutes: number): Promise<Handoff> {
		this.requireRole(id, "source");
		return this.view(await this.source.extend(id, minutes));
	}

	async reclaim(id: string, override: boolean): Promise<Handoff> {
		this.requireRole(id, "source");
		return this.view(await this.source.reclaim(id, override));
	}

	private requireRole(id: string, role: HandoffRole): HandoffRow {
		const row = this.store.get(id);
		if (row.role !== role) throw ApiError.conflict(i18nMsg("This handoff is on its {side} side here; only the {role} node can do that", { side: row.role, role }));
		return row;
	}
}
