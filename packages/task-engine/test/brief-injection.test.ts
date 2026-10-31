import { describe, expect, it } from "vitest";
import {
	MESH_MARKER,
	buildBrief,
	buildCompletionReminder,
	buildMessageInjection,
	buildResumePrompt,
	buildStatusNote,
	deliveryMode,
	formatAuthor,
	parseInjectionHeader,
	type BriefInput,
} from "../src/index.ts";

const base: BriefInput = {
	taskId: "01HZXTASK123",
	title: "Fix the flaky test",
	description: "Line one\n  indented `code` \"quoted\"\nLine three",
	delegator: { agentName: "planner", nodeName: "laptop" },
	executorNodeName: "server",
	repo: { url: "https://github.com/o/r", branch: "main", commit: "abc123" },
	baseBranch: "main",
	workBranch: "clam/server/fix-abc123",
	deliverAs: "branch",
	constraints: { maxCostUsd: 2.5, deadline: "2026-12-01T00:00:00Z", approvalMode: "write" },
	priorMessages: [{ author: "human@laptop", kind: "note", text: "be careful" }],
	canAskDelegator: true,
};

describe("brief", () => {
	it("branch brief", () => {
		const b = buildBrief(base);
		expect(b).toContain(base.taskId);
		expect(b).toContain(base.description);
		expect(b).toContain("planner@laptop");
		expect(b).toContain("clam/server/fix-abc123");
		expect(b).toContain("do NOT run git commit/push or switch branches yourself");
		expect(b).toContain("mesh_message");
		expect(b).toContain("question");
		expect(b).toContain("END YOUR TURN");
		expect(b).toContain("[CL Agent Mesh]");
		expect(b).toContain("mesh_complete");
		expect(b).toContain("$2.5");
		expect(b).toContain("be careful");
	});
	it("summary brief", () => {
		const b = buildBrief({ ...base, deliverAs: "summary", workBranch: null, baseBranch: null, constraints: {}, priorMessages: [], canAskDelegator: false });
		expect(b).toContain(base.description);
		expect(b).toContain("no git changes expected; answer in your summary".replace("no", "No"));
		expect(b).not.toContain("do NOT run git commit");
		expect(b).not.toContain("Constraints");
		expect(b).not.toContain("END YOUR TURN");
		expect(b).toContain("mesh_complete");
	});
	it("files brief without a repository", () => {
		const b = buildBrief({ ...base, repo: null, deliverAs: "files", workBranch: null, baseBranch: null, inputFiles: { paths: ["notes.txt", "data/a.csv"], notReplaced: ["old.txt"] }, constraints: {}, priorMessages: [], canAskDelegator: true });
		expect(b).toContain("## Working folder");
		expect(b).not.toContain("## Repository");
		expect(b).toContain("notes.txt, data/a.csv");
		expect(b).toContain("NOT placed");
		expect(b).toContain("old.txt");
		expect(b).toContain("Deliver as: files");
		expect(b).toContain("returns the files you created or changed");
		expect(b).not.toContain("do NOT run git commit");
	});
	it("anonymous delegator", () => {
		expect(buildBrief({ ...base, delegator: { agentName: null, nodeName: "n" } })).toContain("agent@n");
	});
	it("resume and reminder", () => {
		const r = buildResumePrompt({ taskId: "T1", title: "Hello" });
		expect(r).toContain("T1");
		expect(r).toContain("restarted");
		expect(r).toContain("mesh_complete");
		const c = buildCompletionReminder({ taskId: "T1" });
		expect(c).toContain("T1");
		expect(c).toContain("mesh_complete");
	});
});

describe("injection", () => {
	const author = { kind: "agent", agentName: "planner", nodeName: "laptop" } as const;
	it("formatAuthor", () => {
		expect(formatAuthor(author)).toBe("planner@laptop");
		expect(formatAuthor({ kind: "agent", agentName: null, nodeName: "n" })).toBe("agent@n");
		expect(formatAuthor({ kind: "human", agentName: "x", nodeName: "n" })).toBe("human@n");
		expect(formatAuthor({ kind: "system", agentName: null, nodeName: "n" })).toBe("system@n");
	});
	it("message first line exact + round trip", () => {
		for (const role of ["executor", "sender"] as const) {
			const s = buildMessageInjection({ taskId: "T1", title: "Do it", author, kind: "question", text: "What\nnow?", role });
			expect(s.split("\n")[0]).toBe('[CL Agent Mesh] task T1 · "Do it" · from planner@laptop · kind question');
			expect(s.split("\n").slice(1, 4)).toEqual(["", "What", "now?"]);
			expect(s).toContain("\n\nWhat\nnow?\n\n");
			expect(s).toContain("mesh_message");
			expect(s).toContain("T1");
			expect(parseInjectionHeader(s)).toEqual({ taskId: "T1", title: "Do it", kind: "message", from: "planner@laptop", messageKind: "question" });
		}
		expect(buildMessageInjection({ taskId: "T1", title: "t", author, kind: "answer", text: "x", role: "executor" })).toContain("mesh_complete");
	});
	it("titles with quotes/newlines are flattened", () => {
		const s = buildMessageInjection({ taskId: "T2", title: 'Fix "the"\nbug\r\n now', author, kind: "note", text: "x", role: "executor" });
		const first = s.split("\n")[0]!;
		expect(first).toBe(`${MESH_MARKER} task T2 · "Fix 'the' bug now" · from planner@laptop · kind note`);
		expect(parseInjectionHeader(s)?.title).toBe("Fix 'the' bug now");
	});
	it("status note", () => {
		const s = buildStatusNote({
			taskId: "T3",
			title: "Ship",
			status: "succeeded",
			summary: "done",
			reason: "r",
			branch: "clam/x/y-1",
			pushed: true,
			compareUrl: "https://github.com/o/r/compare/main...clam/x/y-1",
			artifacts: [{ name: "a.txt" }, { name: "b.txt" }],
		});
		const lines = s.split("\n");
		expect(lines[0]).toBe('[CL Agent Mesh] task T3 · "Ship" · status succeeded');
		expect(lines).toContain("summary: done");
		expect(lines).toContain("reason: r");
		expect(lines).toContain("branch: clam/x/y-1 (pushed)");
		expect(lines).toContain("compare: https://github.com/o/r/compare/main...clam/x/y-1");
		expect(lines).toContain("artifacts: a.txt, b.txt");
		expect(parseInjectionHeader(s)).toEqual({ taskId: "T3", title: "Ship", kind: "status", status: "succeeded" });
		expect(buildStatusNote({ taskId: "T", title: "t", status: "failed" }).split("\n")).toHaveLength(1);
	});
	it("parseInjectionHeader rejects others", () => {
		for (const t of ["", "hello", "[CL Agent Mesh] task T · \"x\" · status bogus", '[CL Agent Mesh] task T · "x" · from a@b · kind weird', "[CL Agent Mesh] nope"])
			expect(parseInjectionHeader(t)).toBeNull();
	});
	it("deliveryMode", () => {
		expect(deliveryMode({ busy: false, kind: "instruction" })).toBe("prompt");
		expect(deliveryMode({ busy: false, kind: "note" })).toBe("prompt");
		expect(deliveryMode({ busy: true, kind: "instruction" })).toBe("steer");
		for (const k of ["question", "answer", "note"] as const) expect(deliveryMode({ busy: true, kind: k })).toBe("followUp");
	});
});
