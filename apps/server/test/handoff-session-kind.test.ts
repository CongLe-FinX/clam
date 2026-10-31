import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Checkpoint, Handoff, HandoffDetail, SharedSession } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeNodeSettings } from "../src/services/settings.ts";
import { api, type FullHarness } from "./full-harness.ts";
import { eventually } from "./net-helpers.ts";
import { isolateGitConfig, promptAndWait, startSharedPair, transcriptTexts, waitForShared, type GitConfigIsolation, type SharedPair } from "./shared-fixtures.ts";

/** M7: an M5 takeover is also a `kind: session` handoff (target on the new driver, source on the former one) and runs dependency setup before the continuation note. */

let gitConfig: GitConfigIsolation;
beforeAll(() => {
	gitConfig = isolateGitConfig();
});
afterAll(() => gitConfig.restore());

let pair: SharedPair;
afterEach(async () => {
	await pair?.cleanup();
});

const NOTE = "driver changed (epoch 2)";

/** A drives a shared session with B as participant; the checkpoint with A's file reached B. */
async function sharedWithNotes(): Promise<{ shared: SharedSession; checkpoint: Checkpoint }> {
	pair = await startSharedPair();
	const joined = await pair.shareAndJoin({ title: "Add notes", firstPrompt: "write the notes" });
	await promptAndWait(pair.a, joined.sessionId, "@@fake-sh echo 'line one' > SHARED_NOTES.md");
	const checkpointed = await waitForShared(pair.a, joined.shared.id, (s) => (s.lastCheckpoint?.seq ?? 0) >= 2 && s.lastCheckpoint?.deliveredTo.includes(pair.bId) === true, "the checkpoint with the file reached B");
	return { shared: joined.shared, checkpoint: checkpointed.lastCheckpoint as Checkpoint };
}

/** B continues as driver although A is online (A becomes the former driver). */
async function forceTakeover(sharedId: string): Promise<SharedSession> {
	const took = await api(pair.b).post<SharedSession>(`/shared/${sharedId}/takeover`, { force: true });
	expect(took.status, JSON.stringify(took.body)).toBe(200);
	return took.body;
}

async function handoffOn(node: FullHarness, role: "source" | "target", sharedId: string, predicate: (h: Handoff) => boolean = () => true): Promise<Handoff> {
	return eventually(
		async () => (await api(node).get<Handoff[]>(`/handoffs?kind=session&role=${role}`)).body.find((h) => h.subjectId === sharedId && predicate(h)),
		`the ${role} session handoff of ${sharedId}`,
		30_000,
	);
}

const detail = async (node: FullHarness, id: string): Promise<HandoffDetail> => (await api(node).get<HandoffDetail>(`/handoffs/${id}`)).body;

const noteOn = async (sessionId: string): Promise<string | undefined> => (await transcriptTexts(pair.b, sessionId)).find((t) => t.includes(NOTE));

const waitForNote = (sessionId: string): Promise<string> => eventually(() => noteOn(sessionId), "the continuation note in the new session", 30_000);

/** A tiny npm project in B's clone (untracked: the takeover does not touch it): the detected install command is `npm install`. */
function npmProject(extra: Record<string, unknown> = {}, lockfile?: string): void {
	writeFileSync(path.join(pair.workB, "package.json"), JSON.stringify({ name: "tiny-session-kind", version: "1.0.0", private: true, ...extra }));
	if (lockfile !== undefined) writeFileSync(path.join(pair.workB, "package-lock.json"), lockfile);
}

/** Asserting that something does NOT happen (the held-back note) needs a real delay: there is no event to await. */
function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

describe("a takeover is recorded as session handoffs", () => {
	it("B gets a target record that walks to completed with its steps, A a source record; the note still arrives", async () => {
		const { shared } = await sharedWithNotes();
		const took = await forceTakeover(shared.id);
		const sessionId = took.localSessionId as string;

		const target = await handoffOn(pair.b, "target", shared.id, (h) => h.state === "completed");
		expect(target).toMatchObject({
			kind: "session",
			role: "target",
			subjectId: shared.id,
			title: "Add notes",
			fromEpoch: 1,
			toEpoch: 2,
			vcs: "git",
			source: { nodeId: pair.aId, nodeName: "node-a" },
			target: { nodeId: pair.bId, nodeName: "node-b", sessionId },
			failure: null,
			actions: [],
		});
		expect(target.steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(target.steps.filter((s) => s.state === "done" || s.state === "skipped")).toHaveLength(10);
		expect(target.steps.find((s) => s.n === 8)?.state).toBe("skipped");
		const timeline = await detail(pair.b, target.id);
		expect(timeline.events.map((e) => e.seq)).toEqual(timeline.events.map((_, i) => i + 1));
		const states = timeline.events.map((e) => e.state);
		for (const state of ["received", "accepted", "persisted", "files_restored", "context_restored", "deps_ready", "validated", "session_created", "acked", "owner", "resumed", "completed"] as const) expect(states).toContain(state);
		expect(states.indexOf("owner")).toBeLessThan(states.indexOf("resumed"));

		const source = await handoffOn(pair.a, "source", shared.id, (h) => h.state === "completed");
		expect(source).toMatchObject({ kind: "session", role: "source", fromEpoch: 1, toEpoch: 2, source: { nodeId: pair.aId }, target: { nodeId: pair.bId, nodeName: "node-b" } });
		const sourceStates = (await detail(pair.a, source.id)).events.map((e) => e.state);
		expect(sourceStates).toEqual(expect.arrayContaining(["offered", "accepted", "awaiting_ack", "acked", "released", "completed"]));

		// no peer traffic for either record: the peer never learns about these ids
		expect((await api(pair.a).get<Handoff[]>("/handoffs?role=target")).body.filter((h) => h.subjectId === shared.id)).toEqual([]);
		expect(pair.b.ctx.tasks.store.pendingOutbox(pair.aId).filter((o) => o.kind.startsWith("handoff."))).toEqual([]);

		expect(await waitForNote(sessionId)).toContain("DRIVER");
	});

	it("is idempotent: the record is unique per epoch", async () => {
		const { shared } = await sharedWithNotes();
		await forceTakeover(shared.id);
		const first = await handoffOn(pair.b, "target", shared.id, (h) => h.state === "completed");
		const again = pair.b.ctx.handoffs.sessionKind.recordSource({
			sharedSessionId: shared.id,
			title: "Add notes",
			workspaceId: shared.workspaceId,
			toNodeId: pair.aId,
			toNodeName: "node-a",
			fromEpoch: 1,
			toEpoch: 2,
			sessionId: null,
			agentName: null,
			reason: "takeover",
			vcs: "git",
		});
		expect(again.role).toBe("source");
		const rows = (await api(pair.b).get<Handoff[]>(`/handoffs?kind=session`)).body.filter((h) => h.subjectId === shared.id && h.role === "target");
		expect(rows.map((h) => h.id)).toEqual([first.id]);
	});
});

describe("dependency setup before the continuation note", () => {
	it("auto: the install ran, the note comes after it and carries the report", async () => {
		const { shared } = await sharedWithNotes();
		writeNodeSettings(pair.b.ctx.db, { dependencySetup: "auto" });
		npmProject();
		const took = await forceTakeover(shared.id);

		const note = await waitForNote(took.localSessionId as string);
		expect(note).toContain("Environment setup on this node");
		expect(note).toMatch(/Ran `npm install`: succeeded/);
		const target = await handoffOn(pair.b, "target", shared.id, (h) => h.state === "completed");
		expect(target.setup).toEqual([expect.objectContaining({ command: "npm install", state: "succeeded", exitCode: 0 })]);
		expect(target.environment?.packageManager?.installCommand).toBe("npm install");
		expect(existsSync(path.join(pair.workB, "package-lock.json"))).toBe(true);
	});

	it("ask: the takeover returns at once, the note is held back until the user approves", async () => {
		const { shared } = await sharedWithNotes();
		npmProject();
		const took = await forceTakeover(shared.id);
		const sessionId = took.localSessionId as string;
		expect(took).toMatchObject({ localRole: "driver", epoch: 2 });

		const waiting = await handoffOn(pair.b, "target", shared.id, (h) => h.setup.some((s) => s.state === "pending_approval"));
		expect(waiting.state).toBe("context_restored");
		expect(waiting.actions).toEqual(expect.arrayContaining(["approve_setup", "deny_setup"]));
		await sleep(1_500);
		expect(await noteOn(sessionId)).toBeUndefined();
		expect(existsSync(path.join(pair.workB, "package-lock.json"))).toBe(false);

		const command = waiting.setup[0];
		const approved = await api(pair.b).post<Handoff>(`/handoffs/${waiting.id}/setup`, { approve: [command?.id] });
		expect(approved.status, JSON.stringify(approved.body)).toBe(200);

		const note = await waitForNote(sessionId);
		expect(note).toMatch(/Ran `npm install`: succeeded/);
		const done = await handoffOn(pair.b, "target", shared.id, (h) => h.state === "completed");
		expect(done.setup[0]).toMatchObject({ state: "succeeded" });
	});

	it("ask + deny: the note arrives with the command reported as skipped, the handoff is not failed", async () => {
		const { shared } = await sharedWithNotes();
		npmProject();
		const took = await forceTakeover(shared.id);
		const sessionId = took.localSessionId as string;
		const waiting = await handoffOn(pair.b, "target", shared.id, (h) => h.setup.some((s) => s.state === "pending_approval"));
		const denied = await api(pair.b).post<Handoff>(`/handoffs/${waiting.id}/setup`, { deny: [waiting.setup[0]?.id] });
		expect(denied.status, JSON.stringify(denied.body)).toBe(200);

		const note = await waitForNote(sessionId);
		expect(note).toContain("Environment setup on this node");
		expect(note).toMatch(/Skipped `npm install`/);
		const done = await handoffOn(pair.b, "target", shared.id, (h) => h.state === "completed");
		expect(done.failure).toBeNull();
		expect(existsSync(path.join(pair.workB, "package-lock.json"))).toBe(false);
	});

	it("a failing setup fails the record but never blocks the continuation note, which carries the warning", async () => {
		const { shared } = await sharedWithNotes();
		writeNodeSettings(pair.b.ctx.db, { dependencySetup: "auto" });
		// package.json and lockfile out of sync: `npm ci` (the detected install command) refuses before touching the network
		npmProject({ dependencies: { "left-pad": "1.3.0" } }, JSON.stringify({ name: "tiny-session-kind", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {} }));
		const took = await forceTakeover(shared.id);

		const note = await waitForNote(took.localSessionId as string);
		expect(note).toContain("Environment setup on this node");
		expect(note).toMatch(/failed/i);
		const failed = await handoffOn(pair.b, "target", shared.id, (h) => h.state === "failed");
		expect(failed.failure).toMatchObject({ code: "deps_failed", step: 5 });
		expect(failed.steps.find((s) => s.n === 5)?.state).toBe("failed");
	});

	it("a restart while an approval is pending re-arms it: after the approval exactly one note goes out", async () => {
		const { shared } = await sharedWithNotes();
		npmProject();
		const took = await forceTakeover(shared.id);
		const sessionId = took.localSessionId as string;
		const waiting = await handoffOn(pair.b, "target", shared.id, (h) => h.setup.some((s) => s.state === "pending_approval"));

		await pair.stop("b");
		await pair.start("b");
		const rearmed = await handoffOn(pair.b, "target", shared.id, (h) => h.setup.some((s) => s.state === "pending_approval"));
		expect(rearmed.id).toBe(waiting.id);
		expect(await noteOn(sessionId)).toBeUndefined();

		const approved = await api(pair.b).post<Handoff>(`/handoffs/${rearmed.id}/setup`, { approve: [rearmed.setup[0]?.id] });
		expect(approved.status, JSON.stringify(approved.body)).toBe(200);
		const note = await waitForNote(sessionId);
		expect(note).toMatch(/Ran `npm install`: succeeded/);
		await handoffOn(pair.b, "target", shared.id, (h) => h.state === "completed");
		await sleep(1_000);
		expect((await transcriptTexts(pair.b, sessionId)).filter((t) => t.includes(NOTE) && !t.startsWith("FAKE:"))).toHaveLength(1);
	});
});
