import { TaskStatus } from "@clam/contracts";
import { describe, expect, it } from "vitest";
import {
	ACTIVE_TASK_STATUSES,
	ALLOWED_TRANSITIONS,
	TaskTransitionError,
	assertTransition,
	canTransition,
	checkEpoch,
	isTerminalStatus,
	statusAfterCompletion,
	statusChangeMessage,
	applyMirroredEvents,
} from "../src/index.ts";

const ALL = TaskStatus.options;

describe("status", () => {
	it("every legal transition is allowed and everything else is not", () => {
		for (const from of ALL)
			for (const to of ALL) {
				const legal = ALLOWED_TRANSITIONS[from].includes(to);
				expect(canTransition(from, to), `${from}->${to}`).toBe(legal);
			}
	});
	it("legal table", () => {
		const legal: [string, string][] = [
			["offered", "accepted"], ["offered", "rejected"], ["offered", "cancelled"], ["offered", "failed"],
			["accepted", "running"], ["accepted", "blocked"], ["accepted", "cancelled"], ["accepted", "failed"],
			["running", "blocked"], ["running", "succeeded"], ["running", "failed"], ["running", "cancelled"], ["running", "handed_off"],
			["blocked", "running"], ["blocked", "accepted"], ["blocked", "succeeded"], ["blocked", "failed"], ["blocked", "cancelled"], ["blocked", "handed_off"],
		];
		for (const [f, t] of legal) expect(canTransition(f as never, t as never)).toBe(true);
		expect(legal.length).toBe(Object.values(ALLOWED_TRANSITIONS).flat().length);
	});
	it("illegal", () => {
		expect(canTransition("offered", "running")).toBe(false);
		expect(canTransition("offered", "succeeded")).toBe(false);
		expect(canTransition("running", "running")).toBe(false);
		expect(canTransition("running", "offered")).toBe(false);
		for (const from of ALL.filter(isTerminalStatus)) for (const to of ALL) expect(canTransition(from, to)).toBe(false);
	});
	it("assertTransition throws typed error", () => {
		expect(() => assertTransition("offered", "accepted")).not.toThrow();
		try {
			assertTransition("succeeded", "running");
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(TaskTransitionError);
			const err = e as TaskTransitionError;
			expect(err.code).toBe("illegal_transition");
			expect(err.from).toBe("succeeded");
			expect(err.to).toBe("running");
		}
	});
	it("active/terminal partition and completion mapping", () => {
		for (const s of ALL) expect(ACTIVE_TASK_STATUSES.includes(s)).toBe(!isTerminalStatus(s));
		expect(statusAfterCompletion("succeeded")).toBe("succeeded");
		expect(statusAfterCompletion("failed")).toBe("failed");
		expect(statusAfterCompletion("blocked")).toBe("blocked");
	});
});

describe("epoch", () => {
	it("three outcomes", () => {
		expect(checkEpoch(3, 3)).toEqual({ ok: true });
		expect(checkEpoch(3, 2)).toEqual({ ok: false, reason: "stale", currentEpoch: 3, suppliedEpoch: 2 });
		expect(checkEpoch(3, 4)).toEqual({ ok: false, reason: "future", currentEpoch: 3, suppliedEpoch: 4 });
	});
});

describe("events", () => {
	it("statusChangeMessage", () => {
		expect(statusChangeMessage(null, "offered").text).toBe("offered");
		expect(statusChangeMessage("accepted", "running").text).toBe("accepted → running");
		expect(statusChangeMessage("running", "blocked", "waiting for answer").text).toBe("blocked: waiting for answer");
		expect(statusChangeMessage("running", "failed", "boom").text).toBe("running → failed: boom");
	});
	it("applyMirroredEvents", () => {
		const e = (seq: number) => ({ seq });
		expect(applyMirroredEvents(0, [])).toEqual({ accepted: [], lastSeq: 0, gap: false });
		expect(applyMirroredEvents(0, [e(1), e(2)])).toEqual({ accepted: [e(1), e(2)], lastSeq: 2, gap: false });
		expect(applyMirroredEvents(2, [e(1), e(2), e(3), e(3)])).toEqual({ accepted: [e(3)], lastSeq: 3, gap: false });
		expect(applyMirroredEvents(0, [e(3), e(1), e(2)]).accepted.map((x) => x.seq)).toEqual([1, 2, 3]);
		expect(applyMirroredEvents(2, [e(5), e(4)])).toEqual({ accepted: [e(4), e(5)], lastSeq: 5, gap: true });
		expect(applyMirroredEvents(2, [e(1)])).toEqual({ accepted: [], lastSeq: 2, gap: false });
		expect(() => applyMirroredEvents(0, [e(NaN), e(-1), e(2)])).not.toThrow();
	});
});
