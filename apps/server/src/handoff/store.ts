import { ulid } from "@clam/agent-network";
import type { Handoff, HandoffEvent, I18nMessage, HandoffKind, HandoffRole, HandoffState, HandoffStep, SetupCommand } from "@clam/contracts";
import { handoffArtifacts, handoffEvents, handoffSetup, handoffSteps, handoffs, type ClamDb } from "@clam/database";
import { assertTransition, HandoffManifest, InvalidTransitionError, isTerminal, TARGET_STEPS } from "@clam/handoff-engine";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { ApiError } from "../http/errors.ts";

export type HandoffRow = typeof handoffs.$inferSelect;
export type HandoffInsert = typeof handoffs.$inferInsert;
export type HandoffEventRow = typeof handoffEvents.$inferSelect;
export type HandoffStepRow = typeof handoffSteps.$inferSelect;
export type HandoffSetupRow = typeof handoffSetup.$inferSelect;
export type HandoffArtifactRow = typeof handoffArtifacts.$inferSelect;
export type StepState = HandoffStep["state"];
export type SetupState = SetupCommand["state"];
type Action = Handoff["actions"][number];

export const newHandoffId = (): string => `hnd_${ulid()}`;
export const newSetupId = (): string => `hsu_${ulid()}`;
export const newHandoffArtifactId = (): string => `hart_${ulid()}`;

const nowIso = (): string => new Date().toISOString();

export interface HandoffFilter {
	role?: HandoffRole;
	kind?: HandoffKind;
	/** true = non-terminal states only. */
	active?: boolean;
}

export interface TransitionOptions {
	/** Timeline text (the same text appears in the Handoff Center of this node). */
	summary: I18nMessage;
	/** Compare-and-set guard: only transition when the current state is one of these (409 `conflict` otherwise). */
	from?: readonly HandoffState[];
	/** Extra columns written together with the state. */
	patch?: Partial<HandoffInsert>;
	/** Node the event is attributed to (default: this node). */
	nodeId?: string;
}

/** The states in which a source/target handoff no longer needs anything from the node. Wraps the engine's table. */
export const isTerminalState = (row: Pick<HandoffRow, "role" | "state">): boolean => isTerminal(row.role as HandoffRole, row.state as HandoffState);

/**
 * Every SQL statement of the handoff engine (docs/handoff-protocol.md). Domain rules (state tables, epochs, fencing, recovery
 * decisions) live in `@clam/handoff-engine`; this class only persists them and maps rows to the contract types. All methods are
 * synchronous (better-sqlite3), so each compare-and-set update below is atomic within this process. It never publishes and never
 * calls peers: `HandoffService` does.
 */
export class HandoffStore {
	constructor(
		private readonly db: ClamDb,
		private readonly self: { nodeId: string },
	) {}

	get nodeId(): string {
		return this.self.nodeId;
	}

	transaction<T>(work: () => T): T {
		return this.db.transaction(() => work());
	}

	// ------------------------------------------------------------------ handoffs

	find(id: string): HandoffRow | undefined {
		return this.db.select().from(handoffs).where(eq(handoffs.id, id)).get();
	}

	get(id: string): HandoffRow {
		const row = this.find(id);
		if (!row) throw ApiError.notFound("Handoff");
		return row;
	}

	/** A handoff is addressed by id only; both roles on one node (a node can be the target of its own source row only in tests) never share an id. */
	list(filter: HandoffFilter = {}): HandoffRow[] {
		const conditions = [];
		if (filter.role) conditions.push(eq(handoffs.role, filter.role));
		if (filter.kind) conditions.push(eq(handoffs.kind, filter.kind));
		const rows = this.db
			.select()
			.from(handoffs)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(desc(handoffs.updatedAt), desc(handoffs.id))
			.all();
		if (filter.active === undefined) return rows;
		return rows.filter((r) => !isTerminalState(r) === filter.active);
	}

	/** Every handoff that is not terminal on this node (what boot recovery and the timers look at). */
	nonTerminal(): HandoffRow[] {
		return this.db
			.select()
			.from(handoffs)
			.orderBy(asc(handoffs.createdAt), asc(handoffs.id))
			.all()
			.filter((r) => !isTerminalState(r));
	}

	/** The live handoff of a subject on this node for a role, newest first. Terminal ones are not returned. */
	activeBySubject(subjectId: string, role?: HandoffRole): HandoffRow | undefined {
		const rows = this.db
			.select()
			.from(handoffs)
			.where(role ? and(eq(handoffs.subjectId, subjectId), eq(handoffs.role, role)) : eq(handoffs.subjectId, subjectId))
			.orderBy(desc(handoffs.createdAt), desc(handoffs.id))
			.all();
		return rows.find((r) => !isTerminalState(r));
	}

	bySubject(subjectId: string, role?: HandoffRole): HandoffRow[] {
		return this.db
			.select()
			.from(handoffs)
			.where(role ? and(eq(handoffs.subjectId, subjectId), eq(handoffs.role, role)) : eq(handoffs.subjectId, subjectId))
			.orderBy(desc(handoffs.createdAt), desc(handoffs.id))
			.all();
	}

	/** The row that holds `(subject, toEpoch, role)` (a live or effective handoff), if any. */
	holder(subjectId: string, toEpoch: number, role: HandoffRole): HandoffRow | undefined {
		return this.db
			.select()
			.from(handoffs)
			.where(
				and(
					eq(handoffs.subjectId, subjectId),
					eq(handoffs.toEpoch, toEpoch),
					eq(handoffs.role, role),
					notInArray(handoffs.state, ["prepare_failed", "rejected", "expired", "cancelled", "failed"]),
				),
			)
			.get();
	}

	/**
	 * Insert a new side. The partial unique index `(subject_id, to_epoch, role)` makes a competing handoff for the same epoch
	 * impossible: the loser gets `409 competing_handoff` naming the holder.
	 */
	insert(values: HandoffInsert): HandoffRow {
		try {
			return this.db.insert(handoffs).values(values).returning().get();
		} catch (error) {
			if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
				const holder = this.holder(values.subjectId, values.toEpoch, values.role as HandoffRole);
				throw new ApiError(409, "competing_handoff", "Another handoff of this work already holds that ownership epoch", { holderId: holder?.id ?? null, epoch: values.toEpoch });
			}
			throw error;
		}
	}

	/** Update columns (and `updated_at`) without touching the state machine. Throws 404 for an unknown handoff. */
	update(id: string, patch: Partial<HandoffInsert>): HandoffRow {
		const row = this.db
			.update(handoffs)
			.set({ ...patch, updatedAt: nowIso() })
			.where(eq(handoffs.id, id))
			.returning()
			.get();
		if (!row) throw ApiError.notFound("Handoff");
		return row;
	}

	/** Merge keys into `meta` (`undefined` values delete the key). */
	patchMeta(id: string, patch: Record<string, unknown>): HandoffRow {
		const row = this.get(id);
		const next: Record<string, unknown> = { ...row.meta, ...patch };
		for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
		return this.update(id, { meta: next });
	}

	/**
	 * Move a side to `to` and append the timeline event, atomically. The edge must exist in the engine's table (409
	 * `illegal_transition`); `options.from` adds a compare-and-set guard (409 `conflict`). The state is persisted BEFORE the side
	 * effect it announces (docs §3), so callers perform the side effect after this returns.
	 */
	transition(id: string, to: HandoffState, options: TransitionOptions): { row: HandoffRow; event: HandoffEventRow; from: HandoffState } {
		return this.db.transaction((tx) => {
			const row = tx.select().from(handoffs).where(eq(handoffs.id, id)).get();
			if (!row) throw ApiError.notFound("Handoff");
			const from = row.state as HandoffState;
			if (options.from && !options.from.includes(from)) throw ApiError.conflict(`Handoff is ${from}, expected ${options.from.join(" or ")}`, { state: from });
			try {
				assertTransition(row.role as HandoffRole, from, to);
			} catch (error) {
				if (error instanceof InvalidTransitionError) throw new ApiError(409, "illegal_transition", error.message, { from, to });
				throw error;
			}
			const at = nowIso();
			const event = appendEventTx(tx, id, { nodeId: options.nodeId ?? this.self.nodeId, state: to, summary: options.summary, at });
			const updated = tx
				.update(handoffs)
				.set({ ...options.patch, state: to, updatedAt: at })
				.where(eq(handoffs.id, id))
				.returning()
				.get() as HandoffRow;
			return { row: updated, event, from };
		});
	}

	// ------------------------------------------------------------------ events

	/** Append a timeline event without changing the state (progress notes, the other node's states). Gap-free `seq`. */
	appendEvent(id: string, e: { state: HandoffState; summary: I18nMessage; nodeId?: string }): HandoffEventRow {
		return this.db.transaction((tx) => appendEventTx(tx, id, { nodeId: e.nodeId ?? this.self.nodeId, state: e.state, summary: e.summary, at: nowIso() }));
	}

	events(id: string): HandoffEventRow[] {
		return this.db.select().from(handoffEvents).where(eq(handoffEvents.handoffId, id)).orderBy(asc(handoffEvents.seq)).all();
	}

	// ------------------------------------------------------------------ steps

	steps(id: string): HandoffStepRow[] {
		return this.db.select().from(handoffSteps).where(eq(handoffSteps.handoffId, id)).orderBy(asc(handoffSteps.n)).all();
	}

	/** Create the ten target step rows (idempotent). */
	initTargetSteps(id: string): HandoffStepRow[] {
		for (const step of TARGET_STEPS) {
			this.db.insert(handoffSteps).values({ handoffId: id, n: step.n, name: step.name, state: "pending" }).onConflictDoNothing().run();
		}
		return this.steps(id);
	}

	setStep(id: string, n: number, state: StepState, detail?: string | I18nMessage | null): HandoffStepRow {
		const at = nowIso();
		const say = typeof detail === "string" ? { text: detail, i18n: undefined } : detail;
		const row = this.db
			.update(handoffSteps)
			.set({ state, at, ...(say !== undefined && { detail: say?.text ?? null, detailI18n: say?.i18n ?? null }) })
			.where(and(eq(handoffSteps.handoffId, id), eq(handoffSteps.n, n)))
			.returning()
			.get();
		if (!row) throw ApiError.notFound("Handoff step");
		return row;
	}

	// ------------------------------------------------------------------ setup commands

	setupRows(id: string): HandoffSetupRow[] {
		return this.db.select().from(handoffSetup).where(eq(handoffSetup.handoffId, id)).orderBy(asc(handoffSetup.ord)).all();
	}

	setupRow(id: string): HandoffSetupRow | undefined {
		return this.db.select().from(handoffSetup).where(eq(handoffSetup.id, id)).get();
	}

	insertSetup(values: typeof handoffSetup.$inferInsert): HandoffSetupRow {
		return this.db.insert(handoffSetup).values(values).returning().get();
	}

	updateSetup(id: string, patch: Partial<typeof handoffSetup.$inferInsert>): HandoffSetupRow {
		const row = this.db.update(handoffSetup).set(patch).where(eq(handoffSetup.id, id)).returning().get();
		if (!row) throw ApiError.notFound("Setup command");
		return row;
	}

	clearSetup(id: string): void {
		this.db.delete(handoffSetup).where(eq(handoffSetup.handoffId, id)).run();
	}

	// ------------------------------------------------------------------ artifacts

	artifacts(id: string): HandoffArtifactRow[] {
		return this.db.select().from(handoffArtifacts).where(eq(handoffArtifacts.handoffId, id)).orderBy(asc(handoffArtifacts.createdAt), asc(handoffArtifacts.artifactId)).all();
	}

	artifact(id: string, artifactId: string): HandoffArtifactRow | undefined {
		return this.db.select().from(handoffArtifacts).where(and(eq(handoffArtifacts.handoffId, id), eq(handoffArtifacts.artifactId, artifactId))).get();
	}

	/** Forget every artifact row of a handoff (a preparation that restarts rebuilds them; the caller removes the files). */
	deleteArtifacts(id: string): void {
		this.db.delete(handoffArtifacts).where(eq(handoffArtifacts.handoffId, id)).run();
	}

	insertArtifact(values: typeof handoffArtifacts.$inferInsert): HandoffArtifactRow {
		return this.db.insert(handoffArtifacts).values(values).onConflictDoNothing().returning().get() ?? (this.artifact(values.handoffId, values.artifactId) as HandoffArtifactRow);
	}

	// ------------------------------------------------------------------ mapping to the contract

	toEvent(row: HandoffEventRow): HandoffEvent {
		return { seq: row.seq, at: row.at, nodeId: row.nodeId, state: row.state as HandoffState, summary: row.summary, ...(row.i18n && { i18n: row.i18n }) };
	}

	toStep(row: HandoffStepRow): HandoffStep {
		return { n: row.n, name: row.name, state: row.state as StepState, detail: row.detail, ...(row.detailI18n && { i18n: row.detailI18n }), at: row.at };
	}

	toSetup(row: HandoffSetupRow): SetupCommand {
		return { id: row.id, command: row.command, cwd: row.cwd, purpose: row.purpose as SetupCommand["purpose"], state: row.state as SetupState, exitCode: row.exitCode, outputTail: row.outputTail, startedAt: row.startedAt, finishedAt: row.finishedAt };
	}

	/** What the user can do with this side right now. */
	actions(row: HandoffRow): Action[] {
		const state = row.state as HandoffState;
		if (row.kind === "session") {
			// A shared-session hand-over has no accept/cancel here (M5 owns that); only the dependency-setup approval is the user's.
			if (row.role === "target" && this.setupRows(row.id).some((s) => s.state === "pending_approval")) return ["approve_setup", "deny_setup"];
			return [];
		}
		if (row.role === "source") {
			switch (state) {
				case "preparing":
				case "offered":
					return ["cancel"];
				case "accepted":
					return ["cancel"];
				case "awaiting_ack":
					return ["cancel", "extend"];
				case "ack_timeout":
					return ["extend", "reclaim"];
				case "prepare_failed":
					return ["retry"];
				default:
					return [];
			}
		}
		switch (state) {
			case "received":
				return ["accept", "reject"];
			case "accepted":
			case "persisted":
			case "files_restored":
			case "context_restored":
			case "deps_ready":
			case "validated": {
				const pending = this.setupRows(row.id).some((s) => s.state === "pending_approval");
				return pending ? ["approve_setup", "deny_setup", "cancel"] : ["cancel"];
			}
			case "failed":
				return row.failureCode === "superseded" || row.failureCode === "cancelled" || row.failureCode === "timeout" ? [] : ["retry"];
			default:
				return [];
		}
	}

	toHandoff(row: HandoffRow): Handoff {
		const parsed = HandoffManifest.safeParse(row.manifest);
		const manifest = parsed.success ? parsed.data : null;
		const git = manifest?.git ? { repoUrl: manifest.git.repoUrl, branch: manifest.git.branch, commit: manifest.git.commit, pushed: manifest.git.pushed, patch: manifest.git.patchArtifact !== undefined } : null;
		const files = manifest?.files ? { sha256: manifest.files.sha256, size: manifest.files.size, fileCount: manifest.files.fileCount } : null;
		const environment = row.environment ? (row.environment as Handoff["environment"]) : null;
		return {
			id: row.id,
			kind: row.kind as HandoffKind,
			role: row.role as HandoffRole,
			state: row.state as HandoffState,
			subjectId: row.subjectId,
			title: row.title,
			workspaceId: row.workspaceId,
			source: { nodeId: row.sourceNodeId, nodeName: row.sourceNodeName, agentName: row.sourceAgentName, sessionId: row.sourceSessionId },
			target: { nodeId: row.targetNodeId, nodeName: row.targetNodeName, agentName: row.targetAgentName, sessionId: row.targetSessionId },
			fromEpoch: row.fromEpoch,
			toEpoch: row.toEpoch,
			vcs: row.vcs as Handoff["vcs"],
			git,
			files,
			environment,
			setup: this.setupRows(row.id).map((s) => this.toSetup(s)),
			steps: this.steps(row.id).map((s) => this.toStep(s)),
			manifestSha256: row.manifestSha256,
			conversationSummary: row.conversationSummary,
			includeTranscript: row.includeTranscript,
			failure: row.failureCode ? { code: row.failureCode as NonNullable<Handoff["failure"]>["code"], detail: row.failureDetail ?? "", ...(row.failureI18n && { i18n: row.failureI18n }), step: row.failureStep } : null,
			actions: this.actions(row),
			expiresAt: row.expiresAt,
			deadlineAt: row.deadlineAt,
			ackAt: row.ackAt,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	/** Rows of `states` for a role (recovery helpers). */
	inStates(role: HandoffRole, states: readonly HandoffState[]): HandoffRow[] {
		return this.db
			.select()
			.from(handoffs)
			.where(and(eq(handoffs.role, role), inArray(handoffs.state, [...states])))
			.orderBy(asc(handoffs.createdAt))
			.all();
	}

	count(): number {
		return this.db.select({ n: sql<number>`count(*)` }).from(handoffs).get()?.n ?? 0;
	}
}

type Tx = Parameters<Parameters<ClamDb["transaction"]>[0]>[0];

function appendEventTx(tx: Tx, handoffId: string, e: { nodeId: string; state: string; summary: I18nMessage; at: string }): HandoffEventRow {
	const last = tx.select({ seq: sql<number>`coalesce(max(${handoffEvents.seq}), 0)` }).from(handoffEvents).where(eq(handoffEvents.handoffId, handoffId)).get();
	const seq = (last?.seq ?? 0) + 1;
	return tx.insert(handoffEvents).values({ handoffId, seq, at: e.at, nodeId: e.nodeId, state: e.state, summary: e.summary.text.slice(0, 2000), i18n: e.summary.text.length <= 2000 ? (e.summary.i18n ?? null) : null }).returning().get();
}
