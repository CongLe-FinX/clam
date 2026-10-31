import { describe, expect, it } from "vitest";
import { AGENT_MESSAGE_LIMIT, agentMessageBudget, canSendKind, hasPendingQuestion, orderMessages, type BudgetMessage } from "../src/index.ts";

const m = (id: string, authorKind: BudgetMessage["authorKind"], authorNodeId: string, t: number): BudgetMessage => ({
	id,
	authorKind,
	authorNodeId,
	createdAt: new Date(2026, 0, 1, 0, 0, t).toISOString(),
});
const agents = (n: number, node = "A", start = 0) => Array.from({ length: n }, (_, i) => m(`m${node}${start + i}`, "agent", node, start + i));

describe("budget", () => {
	it("limit is 12 and trips exactly at 12", () => {
		expect(AGENT_MESSAGE_LIMIT).toBe(12);
		expect(agentMessageBudget(agents(11), "A")).toEqual({ limit: 12, used: 11, remaining: 1 });
		expect(agentMessageBudget(agents(12), "A")).toEqual({ limit: 12, used: 12, remaining: 0 });
		expect(agentMessageBudget(agents(15), "A").remaining).toBe(0);
		expect(agentMessageBudget([], "A").used).toBe(0);
	});
	it("custom limit", () => {
		expect(agentMessageBudget(agents(2), "A", 5)).toEqual({ limit: 5, used: 2, remaining: 3 });
	});
	it("human message by either node resets", () => {
		for (const node of ["A", "B"]) {
			const msgs = [...agents(12), m("h", "human", node, 20), ...agents(3, "A", 30)];
			expect(agentMessageBudget(msgs, "A").used).toBe(3);
		}
	});
	it("other node's agent messages don't count; system neither", () => {
		const msgs = [...agents(5, "B"), ...agents(2, "A", 10), m("s", "system", "A", 50)];
		expect(agentMessageBudget(msgs, "A").used).toBe(2);
		expect(agentMessageBudget(msgs, "B").used).toBe(5);
	});
	it("orders by createdAt then id, input order irrelevant", () => {
		const msgs = [m("a", "agent", "A", 1), m("h", "human", "B", 5), m("c", "agent", "A", 9), m("b", "agent", "A", 9)];
		expect(agentMessageBudget([...msgs].reverse(), "A").used).toBe(2);
		expect(orderMessages(msgs).map((x) => x.id)).toEqual(["a", "h", "b", "c"]);
		const same = [m("z", "agent", "A", 1), m("y", "human", "A", 1)];
		expect(agentMessageBudget(same, "A").used).toBe(1); // y (human) < z (agent), agent counts after
	});
});

describe("canSendKind", () => {
	it("instruction only for sender", () => {
		expect(canSendKind("sender", "agent", "instruction")).toEqual({ ok: true });
		expect(canSendKind("sender", "human", "instruction")).toEqual({ ok: true });
		for (const a of ["agent", "human"] as const) {
			const r = canSendKind("executor", a, "instruction");
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.message).toMatch(/sender/);
		}
	});
	it("other kinds ok for everyone", () => {
		for (const role of ["sender", "executor"] as const)
			for (const a of ["agent", "human"] as const)
				for (const k of ["question", "answer", "note"] as const) expect(canSendKind(role, a, k)).toEqual({ ok: true });
	});
});

describe("hasPendingQuestion", () => {
	const q = (id: string, kind: "question" | "answer" | "note" | "instruction", node: string, t: number) => ({
		id,
		kind,
		authorNodeId: node,
		createdAt: new Date(2026, 0, 1, 0, 0, t).toISOString(),
	});
	it("cases", () => {
		expect(hasPendingQuestion([], "B")).toBe(false);
		expect(hasPendingQuestion([q("1", "note", "B", 1)], "B")).toBe(false);
		expect(hasPendingQuestion([q("1", "question", "B", 1)], "B")).toBe(true);
		expect(hasPendingQuestion([q("1", "question", "B", 1), q("2", "note", "B", 2)], "B")).toBe(true);
		expect(hasPendingQuestion([q("1", "question", "B", 1), q("2", "answer", "A", 2)], "B")).toBe(false);
		expect(hasPendingQuestion([q("1", "question", "B", 1), q("2", "answer", "A", 2), q("3", "question", "B", 3)], "B")).toBe(true);
		expect(hasPendingQuestion([q("2", "answer", "A", 2), q("1", "question", "B", 1)], "B")).toBe(false);
		expect(hasPendingQuestion([q("1", "question", "A", 1)], "B")).toBe(false);
	});
});
