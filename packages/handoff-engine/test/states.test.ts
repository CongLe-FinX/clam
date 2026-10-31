import { describe, expect, it } from "vitest";
import {
	assertTransition,
	canTransition,
	InvalidTransitionError,
	isTerminal,
	nextTargetStep,
	SOURCE_TERMINAL,
	SOURCE_TRANSITIONS,
	stepAfterState,
	TARGET_STEPS,
	TARGET_TERMINAL,
	TARGET_TRANSITIONS,
	transitionPath,
} from "../src/index.ts";
import { HandoffState, SourceHandoffState, TargetHandoffState } from "@clam/contracts";

// docs/handoff-protocol.md §3 (+ the documented deviations in states.ts), spelled out independently of the tables.
const SOURCE_EDGES: Array<[string, string]> = [
	["draft", "preparing"],
	["preparing", "prepare_failed"],
	["preparing", "offered"],
	["offered", "accepted"],
	["offered", "rejected"],
	["offered", "expired"],
	["offered", "cancelled"],
	["accepted", "awaiting_ack"],
	["accepted", "failed"],
	["awaiting_ack", "acked"],
	["awaiting_ack", "ack_timeout"],
	["awaiting_ack", "cancelled"],
	["awaiting_ack", "failed"],
	["ack_timeout", "awaiting_ack"],
	["ack_timeout", "reclaimed"],
	["acked", "released"],
	["released", "completed"],
	["prepare_failed", "draft"],
];
const TARGET_EDGES: Array<[string, string]> = [
	["received", "rejected"],
	["received", "accepted"],
	["received", "failed"],
	["accepted", "persisted"],
	["accepted", "cancelled"],
	["accepted", "failed"],
	["persisted", "files_restored"],
	["files_restored", "context_restored"],
	["context_restored", "deps_ready"],
	["deps_ready", "validated"],
	["validated", "session_created"],
	["session_created", "acked"],
	["acked", "owner"],
	["owner", "resumed"],
	["resumed", "completed"],
	["persisted", "failed"],
	["files_restored", "failed"],
	["context_restored", "failed"],
	["deps_ready", "failed"],
	["validated", "failed"],
	["session_created", "failed"],
	["acked", "failed"],
	["persisted", "cancelled"],
];

describe("transition tables", () => {
	it("cover exactly the contract's state enums", () => {
		expect(Object.keys(SOURCE_TRANSITIONS).sort()).toEqual([...SourceHandoffState.options].sort());
		expect(Object.keys(TARGET_TRANSITIONS).sort()).toEqual([...TargetHandoffState.options].sort());
		expect(TargetHandoffState.options).not.toContain("git_restored");
	});

	it("every source pair is allowed iff it is in the doc's edge list", () => {
		for (const from of SourceHandoffState.options) {
			for (const to of SourceHandoffState.options) {
				const expected = SOURCE_EDGES.some(([a, b]) => a === from && b === to);
				expect(canTransition("source", from, to), `source ${from} → ${to}`).toBe(expected);
			}
		}
	});

	it("every target pair is allowed iff it is in the doc's edge list", () => {
		for (const from of TargetHandoffState.options) {
			for (const to of TargetHandoffState.options) {
				const expected = TARGET_EDGES.some(([a, b]) => a === from && b === to);
				expect(canTransition("target", from, to), `target ${from} → ${to}`).toBe(expected);
			}
		}
	});

	it("terminal states have no outgoing edges; non-terminal states have some", () => {
		for (const s of SourceHandoffState.options) {
			expect(isTerminal("source", s)).toBe(SOURCE_TERMINAL.has(s));
			expect(SOURCE_TRANSITIONS[s].length === 0).toBe(SOURCE_TERMINAL.has(s));
		}
		for (const s of TargetHandoffState.options) {
			expect(isTerminal("target", s)).toBe(TARGET_TERMINAL.has(s));
			expect(TARGET_TRANSITIONS[s].length === 0).toBe(TARGET_TERMINAL.has(s));
		}
		expect([...SOURCE_TERMINAL].sort()).toEqual(["cancelled", "completed", "expired", "failed", "reclaimed", "rejected"]);
		expect([...TARGET_TERMINAL].sort()).toEqual(["cancelled", "completed", "failed", "rejected"]);
	});

	it("the source can only reach released through acked", () => {
		for (const s of SourceHandoffState.options) {
			if (s !== "acked") expect(canTransition("source", s, "released")).toBe(false);
		}
	});

	it("the target can never reach owner without acked, nor leave acked except to owner/failed", () => {
		for (const s of TargetHandoffState.options) {
			if (s !== "acked") expect(canTransition("target", s, "owner")).toBe(false);
		}
		expect(TARGET_TRANSITIONS.acked).toEqual(["owner", "failed"]);
	});

	it("rejects a state of the wrong role and unknown states", () => {
		expect(canTransition("source", "persisted", "files_restored")).toBe(false);
		expect(canTransition("target", "draft", "preparing")).toBe(false);
		expect(canTransition("source", "nope" as never, "draft")).toBe(false);
	});

	it("assertTransition throws InvalidTransitionError", () => {
		expect(() => assertTransition("source", "awaiting_ack", "acked")).not.toThrow();
		expect(() => assertTransition("source", "awaiting_ack", "released")).toThrow(InvalidTransitionError);
		expect(() => assertTransition("target", "validated", "owner")).toThrow(/validated → owner/);
	});

	it("happy paths are valid chains", () => {
		const chain = (role: "source" | "target", states: string[]) => {
			for (let i = 1; i < states.length; i++) expect(canTransition(role, states[i - 1] as never, states[i] as never)).toBe(true);
		};
		chain("source", ["draft", "preparing", "offered", "accepted", "awaiting_ack", "acked", "released", "completed"]);
		chain("target", ["received", "accepted", "persisted", "files_restored", "context_restored", "deps_ready", "validated", "session_created", "acked", "owner", "resumed", "completed"]);
		expect(HandoffState.safeParse("files_restored").success).toBe(true);
	});

	it("transitionPath finds hops and null for unreachable", () => {
		expect(transitionPath("source", "ack_timeout", "acked")).toEqual(["awaiting_ack", "acked"]);
		expect(transitionPath("source", "accepted", "acked")).toEqual(["awaiting_ack", "acked"]);
		expect(transitionPath("source", "draft", "draft")).toEqual([]);
		expect(transitionPath("source", "completed", "draft")).toBeNull();
		expect(transitionPath("target", "received", "resumed")?.length).toBe(10);
	});
});

describe("target steps", () => {
	it("lists the ten steps of §4 in order with the state each reaches", () => {
		expect(TARGET_STEPS.map((s) => s.name)).toEqual([
			"receive",
			"persist",
			"restore_files",
			"restore_context",
			"setup_dependencies",
			"validate_workspace",
			"create_session",
			"durable_ack",
			"acquire_ownership",
			"resume",
		]);
		expect(TARGET_STEPS.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(TARGET_STEPS.map((s) => s.doneState)).toEqual(["received", "persisted", "files_restored", "context_restored", "deps_ready", "validated", "session_created", "acked", "owner", "resumed"]);
	});

	it("nextTargetStep returns the first step that is not done/skipped", () => {
		expect(nextTargetStep([])?.n).toBe(1);
		const done = (n: number) => ({ n, state: "done" as const });
		expect(nextTargetStep([done(1), done(2)])?.name).toBe("restore_files");
		expect(nextTargetStep([done(1), done(2), { n: 3, state: "skipped" }, { n: 4, state: "running" }])?.n).toBe(4);
		expect(nextTargetStep([done(1), done(2), done(3), { n: 4, state: "failed" }, done(5)])?.n).toBe(4);
		expect(nextTargetStep([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(done))).toBeNull();
		// out-of-order rows and gaps: step 2 missing counts as pending
		expect(nextTargetStep([done(1), done(3)])?.n).toBe(2);
	});

	it("stepAfterState maps a state to the following step", () => {
		expect(stepAfterState("persisted")?.n).toBe(3);
		expect(stepAfterState("session_created")?.n).toBe(8);
		expect(stepAfterState("resumed")).toBeNull();
		expect(stepAfterState("failed")).toBeNull();
	});
});
