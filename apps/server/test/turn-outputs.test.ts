import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RuntimeStatus, SessionEvent, SessionOutputsPage, TurnOutputs, UiMessage } from "@clam/contracts";
import { agentSessions, agents, projects, turnOutputs, workspaces } from "@clam/database";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sessionRoutes from "../src/api/sessions.ts";
import { explicitPaths, snapshotFolder } from "../src/services/turn-outputs.ts";
import { createTestHarness, idleRuntime, type TestHarness } from "./helpers.ts";

/**
 * Turn outputs: the files an agent turn creates or modifies in its project folder, found by diffing a snapshot of the folder
 * taken at `agent_start` against one taken at `agent_end` plus the paths the turn's write tools named. The runtime is a double
 * whose events the test emits; the folders are real.
 */

/** The start snapshot is a real directory walk that runs off the event handler; wait for it before the test changes the folder. */
const started = (sessionId: string): Promise<void> => h.ctx.turnOutputs.startSnapshotTaken(sessionId);

let h: TestHarness;
let root: string;
const eventListeners: Array<(sessionId: string, event: SessionEvent) => void> = [];
const statusListeners: Array<(status: RuntimeStatus) => void> = [];

const emit = (sessionId: string, event: SessionEvent): void => {
	for (const listener of eventListeners) listener(sessionId, event);
};

const assistant = (id: string, text: string, stopReason = "stop"): UiMessage => ({ id, role: "assistant", timestamp: 1_700_000_000_000 + id.length, content: text === "" ? [] : [{ type: "text", text }], stopReason });

function folder(name: string): string {
	const dir = path.join(root, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function put(dir: string, rel: string, content: string | Buffer): void {
	mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	writeFileSync(path.join(dir, rel), content);
}

/** A project of `dir` with one session; returns the session id. */
function session(id: string, dir: string, kind = "local"): string {
	h.ctx.db.insert(projects).values({ id: `prj_${id}`, workspaceId: "wsp_1", name: id, path: dir }).run();
	h.ctx.db.insert(agentSessions).values({ id, agentId: "agt_1", projectId: `prj_${id}`, title: id, sessionDir: path.join(root, `sessions-${id}`), kind }).run();
	return id;
}

/** Run one turn: `agent_start`, let the start snapshot finish, do the work, `agent_end`. */
async function turn(sessionId: string, work: () => void | Promise<void>, middle: SessionEvent[] = []): Promise<void> {
	emit(sessionId, { type: "agent_start" });
	await started(sessionId);
	await work();
	for (const event of middle) emit(sessionId, event);
	emit(sessionId, { type: "agent_end" });
	await h.ctx.turnOutputs.drain();
}

const outputsOf = async (sessionId: string): Promise<TurnOutputs[]> => {
	const res = await h.app.inject({ method: "GET", url: `/api/local/sessions/${sessionId}/outputs` });
	expect(res.statusCode, res.body).toBe(200);
	return (res.json() as SessionOutputsPage).outputs;
};

beforeEach(async () => {
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "clam-outputs-")));
	eventListeners.length = 0;
	statusListeners.length = 0;
	const runtime = {
		...idleRuntime(),
		onEvent: (listener: (sessionId: string, event: SessionEvent) => void) => (eventListeners.push(listener), () => void eventListeners.splice(eventListeners.indexOf(listener), 1)),
		onStatus: (listener: (status: RuntimeStatus) => void) => (statusListeners.push(listener), () => void statusListeners.splice(statusListeners.indexOf(listener), 1)),
	};
	h = await createTestHarness({ plugins: [sessionRoutes], ctx: { runtime } });
	h.ctx.db.insert(workspaces).values({ id: "wsp_1", name: "W", ownerNodeId: h.ctx.identity.nodeId }).run();
	h.ctx.db.insert(agents).values({ id: "agt_1", nodeId: h.ctx.identity.nodeId, name: "OMP Agent", runtime: "omp" }).run();
});

afterEach(async () => {
	await h.cleanup();
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("turn output detection", () => {
	it("reports created and modified files, not deleted, unchanged or ignored ones; stores the turn, serves it and publishes it", async () => {
		const dir = folder("p1");
		put(dir, "keep.txt", "unchanged");
		put(dir, "edit.md", "old");
		put(dir, "gone.txt", "bye");
		const id = session("ses_1", dir);
		await turn(
			id,
			() => {
				put(dir, "chart.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
				put(dir, "reports/q3/summary.pdf", "%PDF-1.4 fake");
				put(dir, "edit.md", "a much longer new body");
				unlinkSync(path.join(dir, "gone.txt"));
				// never reported
				put(dir, ".git/HEAD", "ref");
				put(dir, "node_modules/pkg/index.js", "x");
				put(dir, ".cache/blob", "x");
				put(dir, ".hidden.txt", "x");
				put(dir, ".clam-upload-123", "x");
				put(dir, "dist/out.js", "x");
				put(dir, "debug.log", "x");
			},
			[{ type: "message_end", message: assistant("msg_1", "Here you go") }],
		);
		const taken = await h.ctx.turnOutputs.takeRunOutputs(id);
		expect(taken.map((f) => [f.path, f.change])).toEqual([
			["chart.png", "created"],
			["reports/q3/summary.pdf", "created"],
			["edit.md", "modified"],
		]);
		expect(taken[0]).toMatchObject({ name: "chart.png", size: 4, mimeType: "image/png" });
		expect(taken[1]).toMatchObject({ name: "summary.pdf", mimeType: "application/pdf" });
		expect(taken[2]).toMatchObject({ mimeType: "text/markdown", size: "a much longer new body".length });

		const listed = await outputsOf(id);
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ sessionId: id, projectId: "prj_ses_1", anchorMessageId: "msg_1", truncated: false });
		expect(listed[0]?.files).toEqual(taken);
		expect(listed[0]?.anchorTimestamp).toBe(assistant("msg_1", "").timestamp);
		expect(listed[0]?.endedAt).toBeGreaterThanOrEqual(listed[0]?.startedAt as number);
		expect(h.ctx.db.select().from(turnOutputs).where(eq(turnOutputs.sessionId, id)).all()).toHaveLength(1);

		const events = h.published.filter((p) => p.topic === `session:${id}` && (p.event as SessionEvent).type === "turn_outputs");
		expect(events).toHaveLength(1);
		expect((events[0]?.event as { outputs: TurnOutputs }).outputs).toEqual(listed[0]);
		// a second call finds nothing left
		expect(await h.ctx.turnOutputs.takeRunOutputs(id)).toEqual([]);
	});

	it("a turn that changes nothing stores nothing and publishes nothing", async () => {
		const dir = folder("p2");
		put(dir, "a.txt", "a");
		const id = session("ses_2", dir);
		await turn(id, () => {});
		expect(await h.ctx.turnOutputs.takeRunOutputs(id)).toEqual([]);
		expect(await outputsOf(id)).toEqual([]);
		expect(h.published.some((p) => (p.event as SessionEvent).type === "turn_outputs")).toBe(false);
	});

	it("takes the paths a write/edit tool named (exact paths win where the walk ignores the folder), refusing anything outside the root, .git and dot-folders", async () => {
		const dir = folder("p3");
		const outside = path.join(root, "outside.txt");
		put(root, "outside.txt", "secret");
		put(dir, ".git/config", "x");
		put(dir, "dist/report.pdf", "%PDF");
		put(dir, "dist/abs.png", "png");
		put(dir, "dist/untouched.txt", "u");
		put(dir, ".private/key.txt", "k");
		const id = session("ses_3", dir);
		const tool = (toolName: string, args: unknown): SessionEvent => ({ type: "tool_start", toolCallId: `c_${Math.random()}`, toolName, args });
		await turn(id, () => {}, [
			tool("write", { path: "dist/report.pdf", content: "…" }),
			tool("edit", { file_path: path.join(dir, "dist", "abs.png") }),
			tool("write", { path: "../outside.txt" }),
			tool("write", { path: outside }),
			tool("write", { path: ".git/config" }),
			tool("write", { path: ".private/key.txt" }),
			tool("write", { path: "missing.txt" }),
			tool("write", { path: "dist" }),
			tool("bash", { path: "dist/untouched.txt" }),
		]);
		const taken = await h.ctx.turnOutputs.takeRunOutputs(id);
		// the walk skips dist/, the explicit paths do not; the existing file was not in the start snapshot (skipped), so both are "created"
		expect(taken.map((f) => f.path).sort()).toEqual(["dist/abs.png", "dist/report.pdf"]);
	});

	it("explicit path parsing: absolute inside the root, relative, and nothing else", () => {
		const r = "/work/proj";
		expect(explicitPaths("write", { path: "a/b.txt" }, r)).toEqual(["a/b.txt"]);
		expect(explicitPaths("Edit", { filePath: "/work/proj/x/y.md" }, r)).toEqual(["x/y.md"]);
		expect(explicitPaths("notebook", { notebook_path: "n.ipynb" }, r)).toEqual(["n.ipynb"]);
		expect(explicitPaths("write", { path: "./c.txt" }, r)).toEqual(["c.txt"]);
		expect(explicitPaths("write", { path: "/work/other/x" }, r)).toEqual([]);
		expect(explicitPaths("write", { path: "../x" }, r)).toEqual([]);
		expect(explicitPaths("write", { path: "/work/proj" }, r)).toEqual([]);
		expect(explicitPaths("write", { path: ".git/HEAD" }, r)).toEqual([]);
		expect(explicitPaths("write", { path: "node_modules/a/b.js" }, r)).toEqual([]);
		expect(explicitPaths("bash", { path: "a.txt" }, r)).toEqual([]);
		expect(explicitPaths("write", null, r)).toEqual([]);
		expect(explicitPaths("write", { path: 3 }, r)).toEqual([]);
	});

	it("caps a turn at 50 files, keeps the showable ones, and says it truncated", async () => {
		const dir = folder("p4");
		const id = session("ses_4", dir);
		await turn(id, () => {
			for (let i = 0; i < 60; i++) put(dir, `data/file-${String(i).padStart(2, "0")}.dat`, `n${i}`);
			put(dir, "zz-late.png", "png");
			put(dir, "zz-late.mp4", "mp4");
		});
		const [outputs] = await outputsOf(id);
		expect(outputs?.files).toHaveLength(50);
		expect(outputs?.truncated).toBe(true);
		// images/video sort before the rest even with a name that sorts last
		expect(outputs?.files.slice(0, 2).map((f) => f.name)).toEqual(["zz-late.mp4", "zz-late.png"]);
	});

	it("an incomplete snapshot (entry/depth/time limits) is flagged and never silently trusted", async () => {
		const dir = folder("p5");
		for (let i = 0; i < 20; i++) put(dir, `f${i}.txt`, "x");
		expect((await snapshotFolder(dir)).complete).toBe(true);
		expect((await snapshotFolder(dir, { maxEntries: 5 })).complete).toBe(false);
		put(dir, "a/b/c/d.txt", "x");
		const shallow = await snapshotFolder(dir, { maxDepth: 1 });
		expect(shallow.complete).toBe(false);
		expect((await snapshotFolder(dir, { budgetMs: -1 })).complete).toBe(false);
		// a turn that could not snapshot falls back to the paths its tool calls named (and cannot tell created from modified)
		h.ctx.turnOutputs.snapshotLimits = { maxEntries: 3 };
		const id = session("ses_5", dir);
		emit(id, { type: "agent_start" });
		await started(id);
		put(dir, "found-by-walk.txt", "x");
		put(dir, "named.txt", "x");
		emit(id, { type: "tool_start", toolCallId: "c1", toolName: "write", args: { path: "named.txt" } });
		emit(id, { type: "agent_end" });
		expect((await h.ctx.turnOutputs.takeRunOutputs(id)).map((f) => [f.path, f.change])).toEqual([["named.txt", "modified"]]);
	});

	it("modified detection follows size and mtime: a rewrite with the same size and a new mtime counts", async () => {
		const dir = folder("p6");
		put(dir, "same.txt", "1234");
		utimesSync(path.join(dir, "same.txt"), new Date(1_600_000_000_000), new Date(1_600_000_000_000));
		const id = session("ses_6", dir);
		await turn(id, () => put(dir, "same.txt", "5678"));
		expect((await h.ctx.turnOutputs.takeRunOutputs(id)).map((f) => [f.path, f.change])).toEqual([["same.txt", "modified"]]);
	});

	it("keeps sessions apart: only the session whose turn ran reports, each in its own folder", async () => {
		const d1 = folder("iso1");
		const d2 = folder("iso2");
		const s1 = session("ses_i1", d1);
		const s2 = session("ses_i2", d2);
		emit(s1, { type: "agent_start" });
		emit(s2, { type: "agent_start" });
		await Promise.all([started(s1), started(s2)]);
		put(d1, "one.png", "1");
		put(d2, "two.png", "2");
		emit(s2, { type: "agent_end" });
		expect((await h.ctx.turnOutputs.takeRunOutputs(s2)).map((f) => f.path)).toEqual(["two.png"]);
		expect(await outputsOf(s1)).toEqual([]);
		emit(s1, { type: "agent_end" });
		expect((await h.ctx.turnOutputs.takeRunOutputs(s1)).map((f) => f.path)).toEqual(["one.png"]);
		expect((await outputsOf(s2)).map((o) => o.files.map((f) => f.path))).toEqual([["two.png"]]);
	});

	it("each agent_start/agent_end pair of a run is its own row; takeRunOutputs merges them (a later turn wins for the same path)", async () => {
		const dir = folder("multi");
		const id = session("ses_m", dir);
		await turn(id, () => put(dir, "a.png", "1"));
		await turn(id, () => {
			put(dir, "b.png", "2");
			put(dir, "a.png", "11");
		});
		const rows = await outputsOf(id);
		expect(rows.map((r) => r.files.map((f) => `${f.path}:${f.change}`))).toEqual([["a.png:created"], ["a.png:modified", "b.png:created"]]);
		const run = await h.ctx.turnOutputs.takeRunOutputs(id);
		expect(run.map((f) => [f.path, f.change]).sort()).toEqual([
			["a.png", "created"],
			["b.png", "created"],
		]);
		expect(run.find((f) => f.path === "a.png")?.size).toBe(2);
	});

	it("an aborted turn still reports; an empty aborted message does not take over the anchor", async () => {
		const dir = folder("abort");
		const id = session("ses_a", dir);
		await turn(id, () => put(dir, "partial.csv", "a,b"), [{ type: "message_end", message: assistant("msg_ok", "working on it") }, { type: "message_end", message: assistant("msg_aborted", "", "aborted") }]);
		const [row] = await outputsOf(id);
		expect(row?.anchorMessageId).toBe("msg_ok");
		expect(row?.files.map((f) => f.path)).toEqual(["partial.csv"]);
	});

	it("a runtime crash mid-turn drops the open snapshot: nothing is reported and the next turn starts clean", async () => {
		const dir = folder("crash");
		const id = session("ses_c", dir);
		emit(id, { type: "agent_start" });
		await started(id);
		put(dir, "lost.png", "x");
		for (const listener of statusListeners) listener({ sessionId: id, state: "crashed", pid: null, startedAt: null, restarts: 1, lastError: "boom", lastActivityAt: null });
		emit(id, { type: "agent_end" }); // nothing is open any more
		await turn(id, () => put(dir, "after.png", "y"));
		expect((await h.ctx.turnOutputs.takeRunOutputs(id)).map((f) => f.path)).toEqual(["after.png"]);
		expect((await outputsOf(id)).map((o) => o.files.map((f) => f.path))).toEqual([["after.png"]]);
	});

	it("a settled without agent_end closes the open turn", async () => {
		const dir = folder("settled");
		const id = session("ses_s", dir);
		emit(id, { type: "agent_start" });
		await started(id);
		put(dir, "x.png", "x");
		emit(id, { type: "settled" });
		expect((await h.ctx.turnOutputs.takeRunOutputs(id)).map((f) => f.path)).toEqual(["x.png"]);
	});

	it("survives a session that is deleted mid-turn, a vanished folder and a mirror", async () => {
		const gone = folder("deleted");
		const sGone = session("ses_d", gone);
		emit(sGone, { type: "agent_start" });
		await started(sGone);
		put(gone, "late.png", "x");
		h.ctx.db.delete(agentSessions).where(eq(agentSessions.id, sGone)).run();
		emit(sGone, { type: "agent_end" });
		expect(await h.ctx.turnOutputs.takeRunOutputs(sGone)).toEqual([]);
		expect(h.ctx.db.select().from(turnOutputs).all()).toEqual([]);

		const dir = folder("vanish");
		const sVanish = session("ses_v", dir);
		emit(sVanish, { type: "agent_start" });
		await started(sVanish);
		rmSync(dir, { recursive: true, force: true });
		emit(sVanish, { type: "agent_end" });
		expect(await h.ctx.turnOutputs.takeRunOutputs(sVanish)).toEqual([]);

		const mirrored = folder("mirror");
		const sMirror = session("ses_mirror", mirrored, "mirror");
		await turn(sMirror, () => put(mirrored, "m.png", "x"));
		expect(await h.ctx.turnOutputs.takeRunOutputs(sMirror)).toEqual([]);
		expect(await outputsOf(sMirror)).toEqual([]);
	});

	it("deleting the session removes its stored turns (cascade)", async () => {
		const dir = folder("cascade");
		const id = session("ses_k", dir);
		await turn(id, () => put(dir, "k.png", "x"));
		expect(await outputsOf(id)).toHaveLength(1);
		h.ctx.db.delete(agentSessions).where(eq(agentSessions.id, id)).run();
		expect(h.ctx.db.select().from(turnOutputs).all()).toEqual([]);
	});

	it("GET /sessions/:id/outputs: 404 for an unknown session, the newest 500 turns oldest → newest", async () => {
		const res = await h.app.inject({ method: "GET", url: "/api/local/sessions/ses_nope/outputs" });
		expect(res.statusCode).toBe(404);
		const dir = folder("many");
		const id = session("ses_many", dir);
		const file = { path: "x.png", name: "x.png", size: 1, mimeType: "image/png", modifiedAt: 1, change: "created" as const };
		for (let i = 0; i < 503; i++) {
			h.ctx.db.insert(turnOutputs).values({ id: `tout_${String(i).padStart(4, "0")}`, sessionId: id, projectId: `prj_${id}`, startedAt: i, endedAt: i + 1, files: [file], truncated: false }).run();
		}
		const outputs = await outputsOf(id);
		expect(outputs).toHaveLength(500);
		expect(outputs[0]?.endedAt).toBe(4);
		expect(outputs.at(-1)?.endedAt).toBe(503);
		expect(outputs.map((o) => o.endedAt)).toEqual([...outputs.map((o) => o.endedAt)].sort((a, b) => a - b));
	});
});
