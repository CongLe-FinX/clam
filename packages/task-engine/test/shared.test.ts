import { describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_LIMIT,
	buildContinuationNote,
	buildSharedBrief,
	buildSharedMessageInjection,
	parseSharedHostToolCall,
	parseSharedInjectionHeader,
	SHARED_HOST_TOOL_DEFINITIONS,
	SHARED_HOST_TOOLS,
	buildPostCheckpointDigest,
	type DigestMessage,
} from "../src/index.ts";

describe("shared host tools", () => {
	it("definitions are essential object schemas named like SHARED_HOST_TOOLS", () => {
		expect(SHARED_HOST_TOOL_DEFINITIONS.map((t) => t.name)).toEqual([...SHARED_HOST_TOOLS]);
		for (const tool of SHARED_HOST_TOOL_DEFINITIONS) {
			const p = tool.parameters as { type: string; additionalProperties: boolean; required: string[] };
			expect(p.type).toBe("object");
			expect(p.additionalProperties).toBe(false);
			expect(tool.loadMode).toBe("essential");
		}
		expect((SHARED_HOST_TOOL_DEFINITIONS[1]?.parameters as { required: string[] }).required).toEqual(["text"]);
		expect(SHARED_HOST_TOOL_DEFINITIONS[1]?.description).toContain(String(AGENT_MESSAGE_LIMIT));
	});

	it("parses and validates calls", () => {
		expect(parseSharedHostToolCall("mesh_team", undefined)).toEqual({ ok: true, call: { name: "mesh_team", args: {} } });
		expect(parseSharedHostToolCall("mesh_say", { text: "  hi  " })).toEqual({ ok: true, call: { name: "mesh_say", args: { text: "hi", kind: "note" } } });
		expect(parseSharedHostToolCall("mesh_say", { text: "q?", kind: "question" })).toMatchObject({ ok: true, call: { args: { kind: "question" } } });
		expect(parseSharedHostToolCall("mesh_say", { text: "" })).toMatchObject({ ok: false });
		expect(parseSharedHostToolCall("mesh_say", { text: "x", kind: "shout" })).toMatchObject({ ok: false, error: expect.stringContaining("kind") });
		expect(parseSharedHostToolCall("mesh_say", { text: "x", extra: 1 })).toMatchObject({ ok: false, error: expect.stringContaining("unknown argument") });
		expect(parseSharedHostToolCall("mesh_team", { a: 1 })).toMatchObject({ ok: false });
		expect(parseSharedHostToolCall("mesh_nope", {})).toMatchObject({ ok: false, error: expect.stringContaining("unknown tool") });
	});
});

describe("shared texts", () => {
	it("frames a discussion message and the header parses back", () => {
		const text = buildSharedMessageInjection({ sharedSessionId: "shs_1", title: 'Fix "login"', author: { kind: "agent", agentName: "Ada", nodeName: "node-a" }, kind: "question", text: "Which file?", role: "participant" });
		expect(text.split("\n")[0]).toBe('[CL Agent Mesh] shared session shs_1 · "Fix \'login\'" · from Ada@node-a · kind question');
		expect(text).toContain("Which file?");
		expect(text).toContain("mesh_say");
		expect(parseSharedInjectionHeader(text)).toEqual({ sharedSessionId: "shs_1", title: "Fix 'login'", from: "Ada@node-a", kind: "question" });
		expect(parseSharedInjectionHeader("hello")).toBeNull();
	});

	it("briefs a participant: goal, driver, repo, tools, loop guard and a one-sentence acknowledgement", () => {
		const brief = buildSharedBrief({
			sharedSessionId: "shs_1",
			title: "Add notes",
			goal: "Create SHARED_NOTES.md",
			driver: { agentName: "Ada", nodeName: "node-a" },
			self: { agentName: "Bob", nodeName: "node-b" },
			repo: { url: "https://github.com/o/r", branch: "clam/shared/add-notes-abc123" },
			others: ["Cy@node-c"],
			agentMessageLimit: 12,
		});
		for (const needle of ["Add notes", "shs_1", "Bob@node-b", "Ada@node-a", "Cy@node-c", "Create SHARED_NOTES.md", "clam/shared/add-notes-abc123", "mesh_say", "mesh_team", "12 messages", "ONE short sentence"]) expect(brief).toContain(needle);
	});

	it("tells a participant agent woken while the lead is offline that it must not edit the shared branch; the brief says it is not the lead", () => {
		const woken = { sharedSessionId: "shs_1", title: "T", author: { kind: "human" as const, agentName: null, nodeName: "node-b" }, kind: "chat" as const, text: "review the plan", role: "participant" as const };
		const offline = buildSharedMessageInjection({ ...woken, leadOffline: { nodeName: "node-a" } });
		expect(offline).toContain("The lead (node-a) is offline right now, so this message was routed to you instead");
		expect(offline).toContain("do NOT edit, commit or push code on the shared branch");
		expect(buildSharedMessageInjection(woken)).not.toContain("is offline right now");
		expect(buildSharedMessageInjection({ ...woken, leadOffline: null })).not.toContain("do NOT edit");
		const brief = buildSharedBrief({ sharedSessionId: "shs_1", title: "T", goal: "g", driver: { agentName: "Ada", nodeName: "node-a" }, self: { agentName: "Bob", nodeName: "node-b" }, repo: { url: "u", branch: "clam/shared/t-1" }, others: [], agentMessageLimit: 12 });
		expect(brief).toContain("You are NOT the lead");
		expect(brief).toContain("must not edit, commit or push the shared branch");
		expect(brief).toContain("to the agent of the node it was written on while the lead's node is offline");
	});

	it("continuation note: takeover warns about missing work, transfer does not", () => {
		const base = {
			sharedSessionId: "shs_1",
			title: "T",
			from: { nodeName: "node-a", agentName: "Ada" },
			to: { nodeName: "node-b", agentName: "Bob" },
			epoch: 2,
			checkpoint: { seq: 3, at: "2030-01-01T00:00:00.000Z", commit: "abcdef0123456789", pushed: true },
			branch: "clam/shared/t-abc",
			headCommit: "abcdef0123456789",
			treeNote: null,
		} as const;
		const takeover = buildContinuationNote({ ...base, reason: "takeover" });
		expect(takeover).toContain("driver changed (epoch 2)");
		expect(takeover).toContain("checkpoint 3 (commit abcdef012345");
		expect(takeover).toContain("may be missing");
		expect(takeover).toContain("DRIVER");
		const transfer = buildContinuationNote({ ...base, reason: "transfer", treeNote: "The branch tip is newer than the snapshot." });
		expect(transfer).toContain("handed over to this node");
		expect(transfer).not.toContain("may be missing");
		expect(transfer).toContain("newer than the snapshot");
	});

	it("continuation note renders the post-checkpoint section only when there is a digest", () => {
		const base = {
			sharedSessionId: "shs_1",
			title: "T",
			from: { nodeName: "node-a", agentName: "Ada" },
			to: { nodeName: "node-b", agentName: "Bob" },
			epoch: 2,
			reason: "takeover",
			checkpoint: { seq: 3, at: "2030-01-01T00:00:00.000Z", commit: "abcdef0123456789", pushed: true },
			branch: "b",
			headCommit: null,
			treeNote: null,
		} as const;
		const plain = buildContinuationNote({ ...base, afterCheckpoint: null });
		expect(plain).not.toContain("--- What");
		const note = buildContinuationNote({ ...base, afterCheckpoint: "User: hi" });
		expect(note).toContain("--- What node-a's agent did after checkpoint 3 (commit abcdef012345) ---");
		expect(note).toContain("NOT in this working tree unless they were pushed");
		expect(note.indexOf("User: hi")).toBeLessThan(note.indexOf("--- end ---"));
		const unpushed = buildContinuationNote({ ...base, checkpoint: { ...base.checkpoint, pushed: false }, afterCheckpoint: "User: hi" });
		expect(unpushed).toContain("never pushed either");
	});
 });

describe("files mode (no git repository)", () => {
	const base = {
		sharedSessionId: "shs_1",
		title: "T",
		from: { nodeName: "node-a", agentName: "Ada" },
		to: { nodeName: "node-b", agentName: "Bob" },
		epoch: 2,
		checkpoint: { seq: 3, at: "2030-01-01T00:00:00.000Z", commit: null, pushed: false },
		branch: null,
		headCommit: null,
		treeNote: null,
		files: { fileCount: 4, applied: ["a.txt", "b.txt"], kept: [], rescued: 0 },
	} as const;

	it("the brief talks about a working folder, not a repository or a branch", () => {
		const brief = buildSharedBrief({ sharedSessionId: "shs_1", title: "T", goal: "g", driver: { agentName: "Ada", nodeName: "node-a" }, self: { agentName: "Bob", nodeName: "node-b" }, repo: null, others: [], agentMessageLimit: 12 });
		expect(brief).toContain("## Working folder");
		expect(brief).toContain("no git repository");
		expect(brief).not.toContain("## Repository");
		expect(brief).not.toContain("Shared branch");
	});

	it("a takeover says which file changes after the last bundle may be missing; a transfer says nothing is missing", () => {
		const takeover = buildContinuationNote({ ...base, reason: "takeover" });
		expect(takeover).toContain("folder bundle of 4 file(s)");
		expect(takeover).toContain("restored from that checkpoint's bundle (2 file(s) written");
		expect(takeover).toContain("File changes node-a made after 2030-01-01T00:00:00.000Z");
		expect(takeover).toContain("NOT in this folder and may be missing");
		expect(takeover).not.toContain("branch");
		const transfer = buildContinuationNote({ ...base, reason: "transfer" });
		expect(transfer).toContain("every file is in the bundle");
		expect(transfer).toContain("Nothing is missing");
		expect(transfer).not.toContain("NOT in this folder");
	});

	it("reports kept files and rescued local edits", () => {
		const note = buildContinuationNote({ ...base, reason: "takeover", files: { fileCount: 4, applied: [], kept: ["keep.txt"], rescued: 2 } });
		expect(note).toContain("kept as they are: keep.txt");
		expect(note).toContain("2 local file(s) of this node that differed from the checkpoint were overwritten after a copy was saved as a rescue bundle");
	});

	it("the post-checkpoint digest does not promise git pushes", () => {
		const note = buildContinuationNote({ ...base, reason: "takeover", afterCheckpoint: "User: hi" });
		expect(note).toContain("unless they were part of the bundle");
		expect(note).not.toContain("pushed");
	});
});

describe("buildPostCheckpointDigest", () => {
	const text = (role: string, t: string): DigestMessage => ({ role, content: [{ type: "text", text: t }] });

	it("is null without a tail, without a boundary, or with nothing readable", () => {
		expect(buildPostCheckpointDigest([], { snapshotMessages: 0 })).toBeNull();
		expect(buildPostCheckpointDigest([text("user", "a"), text("assistant", "b")], { snapshotMessages: 2 })).toBeNull();
		expect(buildPostCheckpointDigest([text("user", "a"), text("assistant", "b")], { snapshotMessages: 5 })).toBeNull();
		expect(buildPostCheckpointDigest([text("user", "a")], { snapshotMessages: null })).toBeNull();
		expect(buildPostCheckpointDigest([text("user", "a")], { snapshotMessages: undefined })).toBeNull();
		expect(buildPostCheckpointDigest([text("user", "a"), { role: "assistant", content: [{ type: "thinking", text: "hmm" }] }], { snapshotMessages: 1 })).toBeNull();
	});

	it("starts at the message after the snapshot's count and keeps the order", () => {
		const digest = buildPostCheckpointDigest([text("user", "old q"), text("assistant", "old a"), text("user", "new q"), text("assistant", "new a")], { snapshotMessages: 2 });
		expect(digest).toBe("User: new q\n\nAgent: new a");
	});

	it("leaves thinking out and renders tool calls with intent, result and errors", () => {
		const digest = buildPostCheckpointDigest(
			[
				{
					role: "assistant",
					content: [
						{ type: "thinking", text: "secret reasoning" },
						{ type: "text", text: "Editing now" },
						{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "src/a.ts", diff: "x" }, intent: "Fix the parser" },
						{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "pnpm  test\n--run" } },
						{ type: "toolCall", id: "t3", name: "read", arguments: { path: "p".repeat(300) } },
						{ type: "toolCall", id: "t4", name: "grep", arguments: {} },
					],
				},
				{ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "Applied 1 edit\nsecond line" }] },
				{ role: "toolResult", toolCallId: "t2", isError: true, content: [{ type: "text", text: "exit 1: 3 tests failed" }] },
				{ role: "toolResult", toolCallId: "t3", content: [{ type: "text", text: "r".repeat(500) }] },
			],
			{ snapshotMessages: 0 },
		) as string;
		expect(digest).not.toContain("secret reasoning");
		expect(digest).toContain("Agent: Editing now");
		expect(digest).toContain("- edit(Fix the parser): Applied 1 edit");
		expect(digest).not.toContain("second line");
		expect(digest).toContain("- bash(pnpm test --run): ERROR exit 1: 3 tests failed");
		expect(digest).toContain(`- read(${"p".repeat(119)}…): ${"r".repeat(199)}…`);
		expect(digest).toContain("- grep(): no result recorded");
	});

	it("caps each message and keeps the most recent ones within the total cap", () => {
		expect(buildPostCheckpointDigest([text("user", "x".repeat(5000))], { snapshotMessages: 0 })).toBe(`User: ${"x".repeat(1499)}…`);
		const many = Array.from({ length: 30 }, (_, k) => text(k % 2 === 0 ? "user" : "assistant", `m${String(k).padStart(2, "0")} ${"y".repeat(1000)}`));
		const digest = buildPostCheckpointDigest(many, { snapshotMessages: 0 }) as string;
		expect(digest.length).toBeLessThan(10_300);
		expect(digest).toMatch(/^\(2[0-9] earlier messages omitted\)\n\n/);
		expect(digest).toContain("m29 ");
		expect(digest).not.toContain("m00 ");
		const omitted = Number(/^\((\d+) earlier/.exec(digest)?.[1]);
		expect(digest).toContain(`m${String(omitted).padStart(2, "0")} `);
		expect(digest).not.toContain(`m${String(omitted - 1).padStart(2, "0")} `);
	});

	it("honours custom caps and always keeps the newest message", () => {
		const digest = buildPostCheckpointDigest([text("user", "first"), text("assistant", "z".repeat(100))], { snapshotMessages: 0, maxTotalChars: 30, maxMessageChars: 50 }) as string;
		expect(digest).toBe(`(1 earlier message omitted)\n\nAgent: ${"z".repeat(22)}…`);
	});
});
