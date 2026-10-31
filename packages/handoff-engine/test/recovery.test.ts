import { describe, expect, it } from "vitest";
import { SourceHandoffState, TargetHandoffState } from "@clam/contracts";
import {
	bootFenceDecision,
	canTransition,
	recoveryAction,
	type RecoveryFacts,
	transitionPath,
} from "../src/index.ts";

const NOW = Date.parse("2026-01-01T10:10:00.000Z");
const FUTURE = "2026-01-01T10:30:00.000Z";
const PAST = "2026-01-01T10:00:00.000Z";
const f = (extra: Partial<RecoveryFacts> = {}): RecoveryFacts => ({ now: NOW, expiresAt: FUTURE, deadlineAt: FUTURE, ...extra });

const src = (state: string, extra?: Partial<RecoveryFacts>) => recoveryAction("source", state as never, f(extra));
const tgt = (state: string, extra?: Partial<RecoveryFacts>) => recoveryAction("target", state as never, f(extra));

describe("source recovery (§6.1)", () => {
	it("draft / preparing / prepare_failed: nothing was sent", () => {
		expect(src("draft").action).toBe("none");
		expect(src("preparing").action).toBe("restart_prepare");
		expect(src("prepare_failed").action).toBe("await_user");
	});

	it("offered: resend while valid, expire after expiresAt", () => {
		expect(src("offered")).toMatchObject({ action: "resend_offer", blockLocalResume: true });
		expect(src("offered", { expiresAt: PAST })).toMatchObject({ action: "expire", nextState: "expired" });
		expect(src("offered", { expiresAt: PAST }).blockLocalResume).toBeFalsy();
	});

	for (const state of ["accepted", "awaiting_ack"] as const) {
		describe(state, () => {
			it("queries the target first", () => {
				expect(src(state).action).toBe("query_target");
			});
			it("target acked at epoch n+1 → finish_release (run source-after-ack)", () => {
				for (const targetState of ["acked", "owner", "resumed", "completed"] as const) {
					expect(src(state, { targetReachable: true, targetState })).toMatchObject({ action: "finish_release", nextState: "acked", fenceTask: true });
				}
			});
			it("§6.4 lost ack response: local ack record or higher peer epoch → finish_release", () => {
				expect(src(state, { ackRecorded: true, targetReachable: false }).action).toBe("finish_release");
				expect(src(state, { targetReachable: true, targetState: null, localEpoch: 0, peerEpoch: 1 }).action).toBe("finish_release");
			});
			it("target failed/rejected/cancelled → mark failed, stay owner", () => {
				for (const targetState of ["failed", "rejected", "cancelled"] as const) {
					expect(src(state, { targetReachable: true, targetState })).toMatchObject({ action: "mark_failed", nextState: "failed" });
				}
			});
			it("target unreachable before the deadline → keep waiting, never release on silence", () => {
				const d = src(state, { targetReachable: false });
				expect(d.action).toBe("none");
				expect(d.blockLocalResume).toBe(true);
				expect(d.nextState === undefined || d.nextState === "awaiting_ack").toBe(true);
			});
			it("target still restoring before the deadline → wait", () => {
				expect(src(state, { targetReachable: true, targetState: "deps_ready" }).action).toBe("none");
			});
			it("deadline passed without ack → ack_timeout", () => {
				expect(src(state, { targetReachable: false, deadlineAt: PAST })).toMatchObject({ action: "enter_ack_timeout", nextState: "ack_timeout" });
				expect(src(state, { targetReachable: true, targetState: "validated", deadlineAt: PAST }).action).toBe("enter_ack_timeout");
			});
		});
	}

	it("ack_timeout: await the user; reclaim needs proof, otherwise an override", () => {
		expect(src("ack_timeout", { targetReachable: false })).toMatchObject({ action: "await_user", reclaimRequiresOverride: true });
		expect(src("ack_timeout")).toMatchObject({ action: "await_user", reclaimRequiresOverride: true });
		expect(src("ack_timeout", { targetReachable: true, targetState: "deps_ready" })).toMatchObject({ action: "await_user", reclaimRequiresOverride: false });
		expect(src("ack_timeout", { targetReachable: true, targetState: "failed" })).toMatchObject({ action: "await_user", reclaimRequiresOverride: false });
	});

	it("ack_timeout: learning the target DID ack (before reclaiming) → finish_release", () => {
		expect(src("ack_timeout", { targetReachable: true, targetState: "acked" })).toMatchObject({ action: "finish_release", nextState: "acked" });
	});

	it("acked (crash before stopping the runtime) → finish_release idempotently, fenced", () => {
		expect(src("acked")).toMatchObject({ action: "finish_release", nextState: "released", fenceTask: true });
	});

	it("released / completed / terminals", () => {
		expect(src("released")).toMatchObject({ action: "none", fenceTask: true });
		expect(src("released", { targetState: "resumed", targetReachable: true })).toMatchObject({ action: "mark_completed", nextState: "completed" });
		expect(src("released", { graceElapsed: true }).action).toBe("mark_completed");
		for (const s of ["rejected", "expired", "cancelled", "reclaimed", "failed"]) expect(src(s).action).toBe("none");
		expect(src("completed")).toMatchObject({ action: "none", fenceTask: true });
	});

	it("§8 returning source: a higher peer epoch fences and follows the new owner", () => {
		expect(src("released", { localEpoch: 0, peerEpoch: 1, targetReachable: true })).toMatchObject({ action: "fence_and_follow_owner", fenceTask: true });
		expect(src("completed", { localEpoch: 0, peerEpoch: 1 })).toMatchObject({ action: "fence_and_follow_owner", fenceTask: true });
		expect(src("offered", { localEpoch: 0, peerEpoch: 1 })).toMatchObject({ action: "fence_and_follow_owner", fenceTask: true, nextState: "cancelled" });
		expect(src("released", { localEpoch: 1, peerEpoch: 1 }).action).not.toBe("fence_and_follow_owner");
	});

	it("every nextState is reachable via allowed hops; every state yields a decision", () => {
		const factSets: Partial<RecoveryFacts>[] = [
			{},
			{ targetReachable: false },
			{ targetReachable: true, targetState: "acked" },
			{ targetReachable: true, targetState: "failed" },
			{ targetReachable: true, targetState: "deps_ready", deadlineAt: PAST },
			{ expiresAt: PAST },
			{ ackRecorded: true },
			{ localEpoch: 0, peerEpoch: 1 },
			{ graceElapsed: true },
		];
		for (const state of SourceHandoffState.options) {
			for (const extra of factSets) {
				const d = src(state, extra);
				expect(d.reason.length).toBeGreaterThan(0);
				if (d.nextState) expect(transitionPath("source", state, d.nextState), `${state} → ${d.nextState}`).not.toBeNull();
			}
		}
	});

	it("never produces finish_release without evidence of an ack (source never releases on silence)", () => {
		const silent: Partial<RecoveryFacts>[] = [{}, { targetReachable: false }, { targetReachable: true, targetState: null }, { targetReachable: true, targetState: "validated" }, { deadlineAt: PAST }];
		for (const state of ["accepted", "awaiting_ack", "ack_timeout"]) {
			for (const extra of silent) expect(src(state, extra).action).not.toBe("finish_release");
		}
	});
});

describe("target recovery (§6.2)", () => {
	it("received / accepted: re-evaluate or refetch, fail(timeout) after the deadline", () => {
		expect(tgt("received").action).toBe("reevaluate_acceptance");
		expect(tgt("received", { manifestStored: false }).action).toBe("refetch_manifest");
		expect(tgt("accepted", { manifestStored: false }).action).toBe("refetch_manifest");
		expect(tgt("accepted", { manifestStored: true })).toMatchObject({ action: "resume_step", step: { n: 2 } });
		expect(tgt("received", { deadlineAt: PAST })).toMatchObject({ action: "mark_failed", failureCode: "timeout", nextState: "failed" });
		expect(tgt("accepted", { deadlineAt: PAST })).toMatchObject({ action: "mark_failed", failureCode: "timeout" });
	});

	it("persisted … validated: resume at the first non-done step", () => {
		const expectedNext = { persisted: 3, files_restored: 4, context_restored: 5, deps_ready: 6, validated: 7 } as const;
		for (const [state, n] of Object.entries(expectedNext)) {
			expect(tgt(state)).toMatchObject({ action: "resume_step", step: { n } });
		}
		const steps = [1, 2, 3, 4].map((n) => ({ n, state: "done" as const }));
		expect(tgt("context_restored", { steps: [...steps, { n: 5, state: "running" }] })).toMatchObject({ action: "resume_step", step: { n: 5, name: "setup_dependencies" } });
		// a failed step is where we resume
		expect(tgt("deps_ready", { steps: [...steps, { n: 5, state: "done" }, { n: 6, state: "failed" }] })).toMatchObject({ step: { n: 6 } });
	});

	it("session_created (before ack): reopen the session, write the ack (step 8)", () => {
		expect(tgt("session_created")).toMatchObject({ action: "resume_step", step: { n: 8 } });
	});

	it("source cancelled / reclaimed / deadline before the ack", () => {
		expect(tgt("accepted", { sourceCancelled: true })).toMatchObject({ action: "mark_failed", nextState: "cancelled", failureCode: "cancelled" });
		expect(tgt("persisted", { sourceCancelled: true })).toMatchObject({ nextState: "cancelled", failureCode: "cancelled" });
		expect(tgt("deps_ready", { sourceCancelled: true })).toMatchObject({ nextState: "failed", failureCode: "cancelled" });
		expect(tgt("validated", { sourceReclaimed: true })).toMatchObject({ nextState: "failed", failureCode: "superseded" });
		expect(tgt("deps_ready", { deadlineAt: PAST })).toMatchObject({ nextState: "failed", failureCode: "timeout" });
	});

	it("acked: resend the ack; stale_epoch from the source → failed(superseded), never owner", () => {
		expect(tgt("acked")).toMatchObject({ action: "resend_ack" });
		expect(tgt("acked", { sourceReclaimed: true })).toMatchObject({ action: "mark_failed", failureCode: "superseded", nextState: "failed" });
		expect(tgt("acked", { ackResponseReceived: true })).toMatchObject({ action: "resume_step", step: { n: 9 } });
	});

	it("§6.4 lost ack response: acquire only after the deadline with no response and no reclaim", () => {
		expect(tgt("acked", { deadlineAt: PAST })).toMatchObject({ action: "acquire_after_deadline", step: { n: 9 } });
		expect(tgt("acked", { deadlineAt: PAST, ackResponseReceived: true }).action).toBe("resume_step");
		expect(tgt("acked", { deadlineAt: PAST, sourceReclaimed: true })).toMatchObject({ action: "mark_failed", failureCode: "superseded" });
		expect(tgt("acked", { deadlineAt: FUTURE }).action).not.toBe("acquire_after_deadline");
	});

	it("owner: resend the resume prompt only without turns", () => {
		expect(tgt("owner")).toMatchObject({ action: "resend_resume_if_no_turns", step: { n: 10 } });
		expect(tgt("owner", { sessionHasTurns: false }).action).toBe("resend_resume_if_no_turns");
		expect(tgt("owner", { sessionHasTurns: true })).toMatchObject({ action: "none", nextState: "resumed" });
	});

	it("resumed / completed / terminal states", () => {
		expect(tgt("resumed").action).toBe("none");
		expect(tgt("resumed", { resumeConfirmed: true })).toMatchObject({ action: "mark_completed", nextState: "completed" });
		expect(tgt("resumed", { graceElapsed: true }).action).toBe("mark_completed");
		expect(tgt("completed").action).toBe("none");
		for (const s of ["failed", "rejected", "cancelled"]) {
			expect(tgt(s).action).toBe("none");
			expect(tgt(s, { cleanedUp: false }).action).toBe("cleanup");
		}
	});

	it("owner/resumed ignore deadlines, reclaim and cancel flags (the epoch is already acquired)", () => {
		expect(tgt("owner", { deadlineAt: PAST, sourceReclaimed: true, sourceCancelled: true }).action).toBe("resend_resume_if_no_turns");
		expect(tgt("resumed", { deadlineAt: PAST, sourceCancelled: true }).action).toBe("none");
	});

	it("every nextState is reachable; every state yields a decision", () => {
		const factSets: Partial<RecoveryFacts>[] = [
			{},
			{ manifestStored: false },
			{ deadlineAt: PAST },
			{ sourceCancelled: true },
			{ sourceReclaimed: true },
			{ ackResponseReceived: true },
			{ sessionHasTurns: true },
			{ resumeConfirmed: true },
			{ cleanedUp: false },
		];
		for (const state of TargetHandoffState.options) {
			for (const extra of factSets) {
				const d = tgt(state, extra);
				expect(d.reason.length).toBeGreaterThan(0);
				if (d.nextState) expect(transitionPath("target", state, d.nextState), `${state} → ${d.nextState}`).not.toBeNull();
				if (d.nextState && d.action === "mark_failed") expect(canTransition("target", state, d.nextState)).toBe(true);
			}
		}
	});

	it("rejects states that do not belong to the role", () => {
		expect(() => recoveryAction("target", "draft", f())).toThrow(RangeError);
		expect(() => recoveryAction("source", "persisted", f())).toThrow(RangeError);
	});
});

describe("boot fence scan (§8)", () => {
	it("fences tasks with a persisted acked handoff", () => {
		for (const sourceState of ["acked", "released", "completed"] as const) {
			expect(bootFenceDecision({ localEpoch: 0, highestSeenEpoch: 0, sourceState }).fence).toBe(true);
		}
	});
	it("fences a task whose epoch is below the highest seen or the peer's", () => {
		expect(bootFenceDecision({ localEpoch: 0, highestSeenEpoch: 1 }).fence).toBe(true);
		expect(bootFenceDecision({ localEpoch: 0, highestSeenEpoch: 0, peerReachable: true, peerEpoch: 1 }).fence).toBe(true);
	});
	it("in-doubt handoff with an unreachable target: own task, but do not auto-resume", () => {
		expect(bootFenceDecision({ localEpoch: 0, highestSeenEpoch: 0, sourceState: "awaiting_ack", peerReachable: false })).toMatchObject({ fence: false, blockResume: true });
		expect(bootFenceDecision({ localEpoch: 0, highestSeenEpoch: 0, sourceState: "offered" })).toMatchObject({ fence: false, blockResume: true });
		expect(bootFenceDecision({ localEpoch: 0, highestSeenEpoch: 0, sourceState: "awaiting_ack", peerReachable: false, userOverride: true })).toMatchObject({ fence: false, blockResume: false });
	});
	it("no pending handoff, or a terminal one, leaves the task free", () => {
		expect(bootFenceDecision({ localEpoch: 2, highestSeenEpoch: 2 })).toMatchObject({ fence: false, blockResume: false });
		for (const sourceState of ["draft", "preparing", "rejected", "expired", "cancelled", "failed", "reclaimed"] as const) {
			expect(bootFenceDecision({ localEpoch: 1, highestSeenEpoch: 1, sourceState })).toMatchObject({ fence: false, blockResume: false });
		}
	});
});
