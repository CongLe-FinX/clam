import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AskQuestion, SessionEvent, Subagent } from "@clam/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type OmpRuntimeOptions,
	type PersistedSubagents,
	type OmpSupervisor,
	OmpEventMapper,
	SubagentTracker,
	createOmpRuntime,
	defaultAskAnswers,
	parseAskQuestions,
	readSubagentRoster,
	readSubagentTranscript,
	validateAskAnswers,
} from "../src/omp/index.ts";
import { AgentRuntimeError, type RuntimeSession, type RuntimeSessionSpec } from "../src/types.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const FAKE_OMP = join(FIXTURES, "fake-omp.mjs");

/** Frames captured from the real `omp` 18.14.0 (`--mode rpc-ui --no-ui`, `set_ask_dialog`, `set_subagent_subscription: progress`). */
function realFrames(name: string): Array<Record<string, unknown> & { type: string }> {
	return readFileSync(join(FIXTURES, name), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown> & { type: string });
}

describe("ask: real omp frames", () => {
	it("maps the captured ask request with every question field", () => {
		const frames = realFrames("real-omp-ask.jsonl");
		const m = new OmpEventMapper(() => 1000);
		const request = frames.find((f) => f.type === "extension_ui_request");
		expect(request).toBeDefined();
		const { events } = m.handleFrame(request as never);
		expect(events).toHaveLength(1);
		const event = events[0] as Extract<SessionEvent, { type: "ui_request" }>;
		expect(event.method).toBe("ask");
		expect(event.questions).toEqual([
			{ id: "db", question: "Which database?", header: "Database", options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite", description: "Embedded", preview: "```sql\nselect 1;\n```" }], recommended: 0 },
			{ id: "features", question: "Which features?", header: "Features", options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }], multi: true },
		]);
		expect(event.title).toBe("Database");
		expect(m.pendingUiRequests()).toHaveLength(1);
	});

	it("carries ask result details on tool_end and on the toolResult message", () => {
		const frames = realFrames("real-omp-ask.jsonl");
		const m = new OmpEventMapper();
		const events = frames.filter((f) => f.type !== "extension_ui_request").flatMap((f) => m.handleFrame(f as never).events);
		const end = events.find((e) => e.type === "tool_end");
		expect(end).toMatchObject({ type: "tool_end", isError: false });
		const details = (end as Extract<SessionEvent, { type: "tool_end" }>).toolDetails as { results: Array<{ id: string; selectedOptions: string[] }> };
		expect(details.results.map((r) => [r.id, r.selectedOptions])).toEqual([
			["db", ["SQLite"]],
			["features", ["Auth", "Search"]],
		]);
		const result = events.find((e) => e.type === "message_end" && e.message.role === "toolResult");
		expect((result as Extract<SessionEvent, { type: "message_end" }>).message.toolDetails).toEqual(details);
	});

	it("reports a single-question ask result in the same { results } shape (OMP puts it at the top level, without an id)", () => {
		const m = new OmpEventMapper();
		const events = realFrames("real-omp-ask-single.jsonl").flatMap((f) => m.handleFrame(f as never).events);
		expect(events.find((e) => e.type === "ui_request")).toMatchObject({ method: "ask", questions: [{ id: "color", header: "Color", recommended: 1 }] });
		const end = events.find((e) => e.type === "tool_end") as Extract<SessionEvent, { type: "tool_end" }>;
		expect(end.toolDetails).toEqual({ results: [{ question: "Pick a color", options: ["Red", "Blue"], multi: false, selectedOptions: ["Blue"] }] });
	});

	it("a cancelled ask is a failed tool call that aborts the run (as captured from omp)", () => {
		const m = new OmpEventMapper();
		const events = realFrames("real-omp-ask-cancelled.jsonl").flatMap((f) => m.handleFrame(f as never).events);
		expect(events.find((e) => e.type === "tool_end")).toMatchObject({ isError: true, result: "Ask tool was cancelled by the user" });
		expect(events.find((e) => e.type === "tool_end")).not.toHaveProperty("toolDetails");
	});

	it("maps todo tool details to phases", () => {
		const m = new OmpEventMapper();
		const events = realFrames("real-omp-todo.jsonl").flatMap((f) => m.handleFrame(f as never).events);
		const [first, second] = events.filter((e) => e.type === "tool_end") as Array<Extract<SessionEvent, { type: "tool_end" }>>;
		expect(first?.toolDetails).toMatchObject({ op: "init", phases: [{ name: "Tasks", tasks: [{ content: "write a", status: "in_progress" }, { content: "write b", status: "pending" }, { content: "write c", status: "pending" }] }] });
		expect(second?.toolDetails).toMatchObject({ op: "done", phases: [{ tasks: [{ status: "completed" }, { status: "in_progress" }, { status: "pending" }] }] });
	});

	it("reports a timeout cancel as timed_out with the defaults omp used, and an early cancel as cancelled", () => {
		let now = 10_000;
		const m = new OmpEventMapper(() => now);
		const questions = [
			{ id: "a", question: "A?", options: [{ label: "x" }, { label: "y" }], recommended: 1 },
			{ id: "b", question: "B?", options: [{ label: "p" }, { label: "q" }], multi: true },
		];
		m.handleFrame({ type: "extension_ui_request", id: "r1", method: "ask", questions, timeout: 30_000 });
		now += 30_100;
		const timedOut = m.handleFrame({ type: "extension_ui_request", id: "c1", method: "cancel", targetId: "r1" });
		expect(timedOut.events).toEqual([
			{ type: "ui_request_resolved", requestId: "r1", outcome: "timed_out", answers: [{ id: "a", selectedOptions: ["y"] }, { id: "b", selectedOptions: ["p"] }] },
		]);
		m.handleFrame({ type: "extension_ui_request", id: "r2", method: "ask", questions, timeout: 30_000 });
		now += 2_000;
		expect(m.handleFrame({ type: "extension_ui_request", id: "c2", method: "cancel", targetId: "r2" }).events).toEqual([{ type: "ui_request_resolved", requestId: "r2", outcome: "cancelled" }]);
	});

	it("keeps option details of select dialogs and the raise time of dialogs with a timeout", () => {
		const m = new OmpEventMapper(() => 5);
		const { events } = m.handleFrame({ type: "extension_ui_request", id: "s", method: "select", title: "Pick", options: ["A", "B"], optionDetails: [{ description: "first" }, {}], timeout: 1000 });
		expect(events).toEqual([{ type: "ui_request", requestId: "s", method: "select", title: "Pick", options: ["A", "B"], optionDetails: [{ description: "first" }, {}], timeoutMs: 1000, raisedAt: 5 }]);
	});

	it("rejects ask requests without usable questions", () => {
		expect(parseAskQuestions([{ id: "x" }])).toEqual([]);
		expect(parseAskQuestions("nope")).toEqual([]);
		expect(parseAskQuestions([{ id: "x", question: "?", options: [{ label: "a" }], recommended: 3 }])).toEqual([{ id: "x", question: "?", options: [{ label: "a" }] }]);
	});
});

describe("ask answers", () => {
	const questions: AskQuestion[] = [
		{ id: "db", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }], recommended: 1 },
		{ id: "features", question: "Which features?", options: [{ label: "Auth" }, { label: "Billing" }], multi: true },
	];

	it("serialises exactly OMP's shape, trimming free text and dropping empty text", () => {
		expect(
			validateAskAnswers(questions, [
				{ id: "db", selectedOptions: [], customInput: "  DuckDB  " },
				{ id: "features", selectedOptions: ["Auth"], customInput: "   " },
			]),
		).toEqual([
			{ id: "db", selectedOptions: [], customInput: "DuckDB" },
			{ id: "features", selectedOptions: ["Auth"] },
		]);
		expect(validateAskAnswers(questions, [{ id: "db", selectedOptions: ["SQLite"] }, { id: "features", selectedOptions: [] }])).toEqual([
			{ id: "db", selectedOptions: ["SQLite"] },
			{ id: "features", selectedOptions: [] },
		]);
	});

	it.each([
		["wrong count", [{ id: "db", selectedOptions: ["SQLite"] }]],
		["wrong order", [{ id: "features", selectedOptions: [] }, { id: "db", selectedOptions: ["SQLite"] }]],
		["unknown option", [{ id: "db", selectedOptions: ["Mongo"] }, { id: "features", selectedOptions: [] }]],
		["duplicate option", [{ id: "db", selectedOptions: ["SQLite"] }, { id: "features", selectedOptions: ["Auth", "Auth"] }]],
		["two options on a single-select", [{ id: "db", selectedOptions: ["SQLite", "Postgres"] }, { id: "features", selectedOptions: [] }]],
		["option and custom text on a single-select", [{ id: "db", selectedOptions: ["SQLite"], customInput: "x" }, { id: "features", selectedOptions: [] }]],
	])("refuses %s", (_name, answers) => {
		expect(() => validateAskAnswers(questions, answers)).toThrow(AgentRuntimeError);
	});

	it("allows option plus custom text on a multi-select and defaults to recommended else first", () => {
		expect(validateAskAnswers(questions, [{ id: "db", selectedOptions: [] }, { id: "features", selectedOptions: ["Auth"], customInput: "more" }])[1]).toEqual({ id: "features", selectedOptions: ["Auth"], customInput: "more" });
		expect(defaultAskAnswers(questions)).toEqual([{ id: "db", selectedOptions: ["SQLite"] }, { id: "features", selectedOptions: ["Auth"] }]);
	});
});

describe("SubagentTracker with real omp frames", () => {
	it("tracks spawn, progress and completion from the captured frames", () => {
		const events: SessionEvent[] = [];
		const tracker = new SubagentTracker({ emit: (e) => events.push(e), throttleMs: 0 });
		for (const frame of realFrames("real-omp-subagents.jsonl")) expect(tracker.handle(frame)).toBe(true);
		const list = tracker.list();
		expect(list.map((s) => [s.id, s.status, s.index])).toEqual([
			["Alpha", "completed", 0],
			["Beta", "completed", 1],
		]);
		const alpha = list[0] as Subagent;
		expect(alpha).toMatchObject({
			agent: "task",
			detached: true,
			parentToolCallId: expect.stringMatching(/^toolu_/),
			assignment: "Run `echo alpha` via bash and report the output.",
			description: "Run echo alpha command and report output",
			model: "anthropic/claude-sonnet-5-5:low",
			hasTranscript: true,
			currentTool: null,
		});
		expect(alpha.toolCount).toBeGreaterThanOrEqual(1);
		expect(alpha.tokens).toBeGreaterThan(0);
		expect(alpha.cost).toBeGreaterThan(0);
		expect(alpha.recentTools[0]).toMatchObject({ tool: "bash", args: "echo alpha" });
		expect(tracker.sessionFileOf("Alpha")).toMatch(/Alpha\.jsonl$/);
		const upserts = events.filter((e) => e.type === "subagent_upsert");
		expect(upserts.length).toBeGreaterThan(4);
		expect(events.every((e) => e.type === "subagent_upsert")).toBe(true);
	});

	it("ignores other frames, never revives a finished subagent and starts fresh when an id is reused", () => {
		const events: SessionEvent[] = [];
		const tracker = new SubagentTracker({ emit: (e) => events.push(e), throttleMs: 0 });
		expect(tracker.handle({ type: "subagent_event", payload: {} })).toBe(false);
		expect(tracker.handle({ type: "agent_start" })).toBe(false);
		const base = { id: "A", agent: "task", index: 0, parentToolCallId: "t1", sessionFile: "/x/A.jsonl" };
		tracker.handle({ type: "subagent_lifecycle", payload: { ...base, status: "started" } });
		tracker.handle({ type: "subagent_lifecycle", payload: { ...base, status: "completed" } });
		tracker.handle({ type: "subagent_progress", payload: { index: 0, agent: "task", progress: { id: "A", status: "running", toolCount: 3 } } });
		expect(tracker.get("A")?.status).toBe("completed");
		tracker.handle({ type: "subagent_lifecycle", payload: { ...base, parentToolCallId: "t2", status: "started" } });
		expect(tracker.get("A")).toMatchObject({ status: "running", parentToolCallId: "t2", toolCount: 0 });
	});

	it("throttles progress per subagent but always delivers the latest and every status change", () => {
		vi.useFakeTimers();
		try {
			const events: SessionEvent[] = [];
			const tracker = new SubagentTracker({ emit: (e) => events.push(e), now: () => Date.now(), throttleMs: 250 });
			const progress = (toolCount: number, status = "running") => ({ type: "subagent_progress", payload: { index: 0, agent: "task", progress: { id: "A", status, toolCount } } });
			tracker.handle({ type: "subagent_lifecycle", payload: { id: "A", agent: "task", index: 0, status: "started" } });
			expect(events).toHaveLength(1);
			// Inside the window after the lifecycle emit: held back, the newest wins when the window ends.
			for (let i = 1; i < 10; i++) tracker.handle(progress(i));
			expect(events).toHaveLength(1);
			vi.advanceTimersByTime(300);
			expect(events).toHaveLength(2);
			expect((events.at(-1) as Extract<SessionEvent, { type: "subagent_upsert" }>).subagent.toolCount).toBe(9);
			// A status change is never held back.
			tracker.handle(progress(10, "completed"));
			expect(events).toHaveLength(3);
			expect((events.at(-1) as Extract<SessionEvent, { type: "subagent_upsert" }>).subagent.status).toBe("completed");
		} finally {
			vi.useRealTimers();
		}
	});

	it("restores a saved roster with running entries reported as aborted, and aborts running ones when the process dies", () => {
		const events: SessionEvent[] = [];
		const a = new SubagentTracker({ emit: (e) => events.push(e), throttleMs: 0 });
		a.handle({ type: "subagent_lifecycle", payload: { id: "A", agent: "task", index: 0, status: "started", sessionFile: "/x/A.jsonl" } });
		a.handle({ type: "subagent_lifecycle", payload: { id: "B", agent: "task", index: 1, status: "started" } });
		a.handle({ type: "subagent_lifecycle", payload: { id: "B", agent: "task", index: 1, status: "completed" } });
		const saved = JSON.parse(JSON.stringify(a.persisted())) as PersistedSubagents;
		a.interruptRunning();
		expect(a.list().map((s) => [s.id, s.status])).toEqual([["A", "aborted"], ["B", "completed"]]);

		const b = new SubagentTracker({ emit: () => undefined });
		b.restore(saved);
		expect(b.list().map((s) => [s.id, s.status])).toEqual([["A", "aborted"], ["B", "completed"]]);
		expect(b.sessionFileOf("A")).toBe("/x/A.jsonl");
	});
});

describe("readSubagentTranscript", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "clam-subtx-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const line = (id: string, role: string, text: string) => `${JSON.stringify({ type: "message", id, message: { role, content: [{ type: "text", text }], timestamp: 1 } })}\n`;

	it("reads message entries incrementally and leaves an unfinished record for the next read", async () => {
		const file = join(dir, "A.jsonl");
		writeFileSync(file, `${JSON.stringify({ type: "session", id: "s" })}\n${line("m1", "user", "hello")}`);
		const first = await readSubagentTranscript(file);
		expect(first.messages.map((m) => [m.id, m.role])).toEqual([["m1", "user"]]);
		appendFileSync(file, `${line("m2", "assistant", "hi")}{"type":"message","id":"m3"`);
		const second = await readSubagentTranscript(file, first.nextByte);
		expect(second.messages.map((m) => m.id)).toEqual(["m2"]);
		expect(second.reset).toBe(false);
		appendFileSync(file, `,"message":{"role":"assistant","content":[{"type":"text","text":"x"}],"timestamp":1}}\n`);
		const third = await readSubagentTranscript(file, second.nextByte);
		expect(third.messages.map((m) => m.id)).toEqual(["m3"]);
		const same = await readSubagentTranscript(file, third.nextByte);
		expect(same).toMatchObject({ messages: [], nextByte: third.nextByte });
	});

	it("resets when the file shrank and answers empty for a missing file", async () => {
		const file = join(dir, "B.jsonl");
		writeFileSync(file, line("m1", "user", "a"));
		const page = await readSubagentTranscript(file, 99_999);
		expect(page.reset).toBe(true);
		expect(page.messages).toHaveLength(1);
		expect(await readSubagentTranscript(join(dir, "none.jsonl"), 5)).toEqual({ fromByte: 5, nextByte: 5, reset: false, messages: [] });
	});
});

// ---------------------------------------------------------------------------------------------- fake omp round trips

// Process spawns are slow on a loaded machine: generous limits, the suite does not sleep on them.
describe("ask and subagents against the fake omp", { timeout: 120_000 }, () => {
	let tmp: string;
	const supervisors: OmpSupervisor[] = [];

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "clam-surfaces-"));
	});
	afterEach(async () => {
		await Promise.all(supervisors.splice(0).map((s) => s.shutdown()));
		rmSync(tmp, { recursive: true, force: true });
	});

	function create(options: Partial<OmpRuntimeOptions> = {}, env: Record<string, string> = {}) {
		const supervisor = createOmpRuntime({
			binary: () => FAKE_OMP,
			settings: { maxConcurrentRuntimes: 4, idleTimeoutMs: 60_000, approvalMode: "yolo" },
			env: { FAKE_OMP_LOG: join(tmp, "fake.log"), FAKE_OMP_EVENT_DELAY_MS: "1", ...env },
			startTimeoutMs: 45_000,
			requestTimeoutMs: 45_000,
			closeGraceMs: 1000,
			stateRefreshMs: 10,
			reapIntervalMs: 60_000,
			...options,
		});
		supervisors.push(supervisor);
		const events: SessionEvent[] = [];
		supervisor.onEvent((_id, event) => events.push(event));
		return { supervisor, events };
	}

	const spec = (id: string): RuntimeSessionSpec => {
		const cwd = join(tmp, "project");
		mkdirSync(cwd, { recursive: true });
		return { sessionId: id, cwd, sessionDir: join(tmp, "sessions", id) };
	};

	async function waitFor(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	const commands = (): Array<{ kind: string; frame?: Record<string, unknown> }> =>
		readFileSync(join(tmp, "fake.log"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as { kind: string; frame?: Record<string, unknown> });

	const lastText = (events: SessionEvent[]): string => {
		const ends = events.filter((e): e is Extract<SessionEvent, { type: "message_end" }> => e.type === "message_end" && e.message.role === "assistant");
		return ends
			.at(-1)
			?.message.content.map((b) => (b.type === "text" ? b.text : ""))
			.join("") ?? "";
	};

	it("enables the ask dialog and subagent progress after open_session, in yolo (rpc-ui --no-ui) too", async () => {
		const { supervisor } = create();
		await supervisor.open(spec("s1"));
		const sent = commands().filter((c) => c.kind === "command").map((c) => c.frame?.type);
		expect(sent.indexOf("open_session")).toBeLessThan(sent.indexOf("set_ask_dialog"));
		expect(sent).toContain("set_subagent_subscription");
		const subscribe = commands().find((c) => c.frame?.type === "set_subagent_subscription");
		expect(subscribe?.frame).toMatchObject({ level: "progress" });
		expect(commands().find((c) => c.frame?.type === "set_ask_dialog")?.frame).toMatchObject({ enabled: true });
	});

	it.each(["yolo", "always-ask"] as const)("answers an ask request with OMP's answers shape (%s)", async (approvalMode) => {
		const { supervisor, events } = create({ settings: { maxConcurrentRuntimes: 4, idleTimeoutMs: 60_000, approvalMode } });
		const session = await supervisor.open(spec(`ask-${approvalMode}`));
		await session.prompt({ message: "__ask__", clientId: "c1" });
		await waitFor(() => session.pendingUiRequests().length === 1, "ask request");
		const request = session.pendingUiRequests()[0];
		expect(request).toMatchObject({ method: "ask", questions: [{ id: "db", recommended: 1 }, { id: "features", multi: true }] });

		// A wrong shape is refused before it reaches OMP and the request stays open.
		await expect(session.respondToUiRequest({ requestId: request?.requestId ?? "", answers: [{ id: "db", selectedOptions: ["Nope"] }, { id: "features", selectedOptions: [] }] })).rejects.toMatchObject({ code: "invalid_argument" });
		await expect(session.respondToUiRequest({ requestId: request?.requestId ?? "", value: "SQLite" })).rejects.toMatchObject({ code: "invalid_argument" });
		expect(session.pendingUiRequests()).toHaveLength(1);

		await session.respondToUiRequest({
			requestId: request?.requestId ?? "",
			answers: [
				{ id: "db", selectedOptions: [], customInput: "  DuckDB " },
				{ id: "features", selectedOptions: ["Auth", "Search"] },
			],
		});
		// The answer is a fire-and-forget frame: wait for the fake to log that it received it.
		await waitFor(() => commands().some((c) => c.frame?.type === "extension_ui_response"), "answer frame");
		const wire = commands().find((c) => c.frame?.type === "extension_ui_response");
		expect(wire?.frame).toEqual({
			type: "extension_ui_response",
			id: request?.requestId,
			answers: [
				{ id: "db", selectedOptions: [], customInput: "DuckDB" },
				{ id: "features", selectedOptions: ["Auth", "Search"] },
			],
		});
		expect(events).toContainEqual({
			type: "ui_request_resolved",
			requestId: request?.requestId,
			outcome: "answered",
			answers: [
				{ id: "db", selectedOptions: [], customInput: "DuckDB" },
				{ id: "features", selectedOptions: ["Auth", "Search"] },
			],
		});
		await waitFor(() => events.some((e) => e.type === "settled"), "settled");
		expect(lastText(events)).toContain("db: DuckDB");
		expect(lastText(events)).toContain("features: Auth, Search");
		expect(events.find((e) => e.type === "tool_end" && e.toolCallId === "call_fake_ask")).toMatchObject({ toolDetails: { results: [{ id: "db" }, { id: "features" }] } });
	});

	it("cancels an ask request by sending cancelled", async () => {
		const { supervisor, events } = create();
		const session = await supervisor.open(spec("ask-cancel"));
		await session.prompt({ message: "__ask__", clientId: "c1" });
		await waitFor(() => session.pendingUiRequests().length === 1, "ask request");
		const id = session.pendingUiRequests()[0]?.requestId ?? "";
		await session.respondToUiRequest({ requestId: id, value: null });
		await waitFor(() => commands().some((c) => c.frame?.type === "extension_ui_response"), "cancel frame");
		expect(commands().find((c) => c.frame?.type === "extension_ui_response")?.frame).toEqual({ type: "extension_ui_response", id, cancelled: true });
		expect(events).toContainEqual({ type: "ui_request_resolved", requestId: id, outcome: "cancelled" });
	});

	it("reports the defaults omp used when an ask times out", async () => {
		const { supervisor, events } = create({}, { FAKE_OMP_ASK_TIMEOUT_MS: "300" });
		const session = await supervisor.open(spec("ask-timeout"));
		await session.prompt({ message: "__ask_timeout__", clientId: "c1" });
		await waitFor(() => events.some((e) => e.type === "ui_request"), "ask request");
		expect(session.pendingUiRequests()[0]).toMatchObject({ timeoutMs: 300 });
		await waitFor(() => events.some((e) => e.type === "ui_request_resolved"), "timeout");
		expect(events.find((e) => e.type === "ui_request_resolved")).toMatchObject({
			outcome: "timed_out",
			answers: [{ id: "db", selectedOptions: ["SQLite"] }, { id: "features", selectedOptions: ["Auth"] }],
		});
		expect(session.pendingUiRequests()).toHaveLength(0);
	});

	it("keeps working with select dialogs when the build refuses set_ask_dialog", async () => {
		const { supervisor, events } = create({}, { FAKE_OMP_NO_ASK_DIALOG: "1" });
		const session = await supervisor.open(spec("ask-fallback"));
		await session.prompt({ message: "__ask__", clientId: "c1" });
		await waitFor(() => session.pendingUiRequests().length === 1, "first select");
		const first = session.pendingUiRequests()[0];
		expect(first).toMatchObject({ method: "select", title: "Which database?", options: ["Postgres", "SQLite"], optionDetails: [{ description: "Relational" }, { description: "Embedded" }] });
		await session.respondToUiRequest({ requestId: first?.requestId ?? "", value: "SQLite" });
		await waitFor(() => session.pendingUiRequests().length === 1, "second select");
		await session.respondToUiRequest({ requestId: session.pendingUiRequests()[0]?.requestId ?? "", value: "Auth" });
		await waitFor(() => events.some((e) => e.type === "settled"), "settled");
		expect(lastText(events)).toContain("db: SQLite");
	});

	it("lists subagents live, serves transcripts, steers and stops one while the other finishes", async () => {
		const { supervisor, events } = create();
		const session = await supervisor.open(spec("team"));
		await session.prompt({ message: "__subagents__", clientId: "c1" });
		await waitFor(() => session.subagents().length === 2, "both subagents");
		await waitFor(() => session.subagents().find((s) => s.id === "Alpha")?.status === "completed", "Alpha done");
		const beta = session.subagents().find((s) => s.id === "Beta") as Subagent;
		expect(beta).toMatchObject({ status: "running", agent: "task", parentToolCallId: "call_fake_task", detached: true, model: "fake/alpha:low", hasTranscript: true });
		await waitFor(() => (session.subagents().find((s) => s.id === "Beta")?.toolCount ?? 0) >= 2, "Beta progress");

		// Incremental transcript: reuse nextByte; only new entries arrive.
		const first = await session.subagentMessages("Beta", 0);
		expect(first.messages[0]).toMatchObject({ role: "user" });
		await session.steerSubagent("Beta", "please keep going");
		const next = await session.subagentMessages("Beta", first.nextByte);
		expect(next.fromByte).toBe(first.nextByte);
		expect(next.messages.some((m) => m.role === "user" && m.content.some((b) => b.type === "text" && b.text === "please keep going"))).toBe(true);
		await expect(session.subagentMessages("Nobody")).rejects.toMatchObject({ code: "invalid_argument" });

		expect(await session.cancelSubagent("Beta")).toEqual({ cancelled: true });
		await waitFor(() => session.subagents().find((s) => s.id === "Beta")?.status === "aborted", "Beta aborted");
		expect(await session.cancelSubagent("Beta")).toEqual({ cancelled: false });
		await expect(session.steerSubagent("Beta", "again")).rejects.toMatchObject({ code: "rejected" });

		await waitFor(() => events.some((e) => e.type === "settled"), "turn settled");
		const upserts = events.filter((e): e is Extract<SessionEvent, { type: "subagent_upsert" }> => e.type === "subagent_upsert");
		expect(upserts.some((e) => e.subagent.id === "Alpha" && e.subagent.status === "running")).toBe(true);
		expect(upserts.at(-1)?.subagent.status).toMatch(/aborted|completed/);
	});

	it("keeps the roster across a stop: snapshot and transcripts stay readable without a process", async () => {
		const { supervisor } = create();
		const s = spec("keep");
		const session: RuntimeSession = await supervisor.open(s);
		await session.prompt({ message: "__subagents__", clientId: "c1" });
		await waitFor(() => session.subagents().length === 2, "both subagents");
		await session.steerSubagent("Beta", "finish now");
		await waitFor(() => session.subagents().every((x) => x.status === "completed"), "all done");
		await supervisor.stop("keep");

		const roster = await readSubagentRoster(s.sessionDir);
		expect(roster?.subagents.map((x) => [x.subagent.id, x.subagent.status])).toEqual([["Alpha", "completed"], ["Beta", "completed"]]);
		const file = roster?.subagents.find((x) => x.subagent.id === "Alpha")?.sessionFile;
		expect(file).toBeTruthy();
		expect((await readSubagentTranscript(file ?? "", 0)).messages.length).toBeGreaterThan(0);

		// The same runtime object reports the list while stopped; a reopened one restores it from disk.
		expect(session.subagents().map((x) => x.id)).toEqual(["Alpha", "Beta"]);
		expect((await session.subagentMessages("Alpha")).messages.length).toBeGreaterThan(0);
		const reopened = await supervisor.open(s);
		expect(reopened.subagents().map((x) => [x.id, x.status])).toEqual([["Alpha", "completed"], ["Beta", "completed"]]);
	});

	it("marks subagents that were still running when the process stopped as aborted", async () => {
		const { supervisor } = create();
		const s = spec("killed");
		const session = await supervisor.open(s);
		await session.prompt({ message: "__subagents__", clientId: "c1" });
		await waitFor(() => session.subagents().find((x) => x.id === "Beta")?.status === "running", "Beta running");
		await supervisor.stop("killed");
		expect(session.subagents().find((x) => x.id === "Beta")?.status).toBe("aborted");
		const roster = await readSubagentRoster(s.sessionDir);
		expect(roster?.subagents.find((x) => x.subagent.id === "Beta")?.subagent.status).toBe("aborted");
	});
});
