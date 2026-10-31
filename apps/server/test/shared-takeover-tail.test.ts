import type { Checkpoint, SharedSession } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api } from "./full-harness.ts";
import { eventually } from "./net-helpers.ts";
import { isolateGitConfig, promptAndWait, sharedOn, startSharedPair, transcriptTexts, waitForShared, type GitConfigIsolation, type SharedPair } from "./shared-fixtures.ts";

let gitConfig: GitConfigIsolation;
beforeAll(() => {
	gitConfig = isolateGitConfig();
});
afterAll(() => gitConfig.restore());

let pair: SharedPair;
afterEach(async () => {
	await pair?.cleanup();
});

/** The continuation note the new session on B opened with. */
async function continuationNote(sessionId: string): Promise<string> {
	await eventually(async () => (await transcriptTexts(pair.b, sessionId)).some((t) => t.includes("driver changed (epoch 2)")), "the continuation note in the new session", 20_000);
	return (await transcriptTexts(pair.b, sessionId)).find((t) => t.includes("driver changed (epoch 2)")) as string;
}

describe("takeover continuation note: what the driver did after the last checkpoint", () => {
	it("lists the turns B's mirror holds beyond the snapshot, and not the conversation the snapshot already has", async () => {
		// Automatic checkpoints are pushed an hour out, so the work after the manual checkpoint never gets one.
		pair = await startSharedPair({ nodeA: { sharedTimings: { checkpointDebounceMs: 3_600_000 } } });
		const { sessionId, shared, onB } = await pair.shareAndJoin({ title: "Tail", firstPrompt: "first request" });
		await promptAndWait(pair.a, sessionId, "second request");
		const taken = await api(pair.a).post<Checkpoint>(`/shared/${shared.id}/checkpoint`, {});
		expect(taken.status, JSON.stringify(taken.body)).toBe(200);
		const checkpoint = taken.body;
		expect(checkpoint.snapshot?.messageCount).toBeGreaterThan(0);
		await waitForShared(pair.a, shared.id, (s) => s.lastCheckpoint?.seq === checkpoint.seq && s.lastCheckpoint.deliveredTo.includes(pair.bId), "the checkpoint reached B");

		await promptAndWait(pair.a, sessionId, "tail request one\n@@fake-sh echo tail-marker > TAIL.txt");
		await promptAndWait(pair.a, sessionId, "tail request two");
		const mirrorId = onB.mirrorSessionId as string;
		await eventually(async () => (await transcriptTexts(pair.b, mirrorId)).some((t) => t.includes("FAKE: tail request two")), "the tail on B's mirror");
		expect((await sharedOn(pair.a, shared.id)).lastCheckpoint?.seq).toBe(checkpoint.seq);

		await pair.stop("a");
		await waitForShared(pair.b, shared.id, (s) => s.takeoverAvailable, "takeover available", 20_000);
		const took = await api(pair.b).post<SharedSession>(`/shared/${shared.id}/takeover`, {});
		expect(took.status, JSON.stringify(took.body)).toBe(200);
		const note = await continuationNote(took.body.localSessionId as string);

		const start = note.indexOf(`--- What node-a's agent did after checkpoint ${checkpoint.seq}`);
		expect(start).toBeGreaterThan(-1);
		expect(note).toContain(`(commit ${checkpoint.commit?.slice(0, 12)})`);
		const end = note.indexOf("--- end ---", start);
		expect(end).toBeGreaterThan(start);
		const section = note.slice(start, end);
		expect(section).toContain("NOT in this working tree");
		expect(section).toContain("User: tail request one");
		expect(section).toContain("Agent: FAKE_TOOL_RESULT sh: exit=0");
		expect(section).toMatch(/- bash\([^)]*\): exit=0/);
		expect(section).toContain("User: tail request two");
		expect(section).toContain("Agent: FAKE: tail request two");
		expect(section.indexOf("tail request one")).toBeLessThan(section.indexOf("tail request two"));
		// the conversation the snapshot holds is not repeated
		expect(section).not.toContain("first request");
		expect(section).not.toContain("second request");
	});

	it("has no such section when nothing happened after the checkpoint", async () => {
		pair = await startSharedPair();
		const { sessionId, shared } = await pair.shareAndJoin({ title: "No tail", firstPrompt: "only request" });
		await promptAndWait(pair.a, sessionId, "another request");
		await waitForShared(
			pair.a,
			shared.id,
			(s) => s.lastCheckpoint?.deliveredTo.includes(pair.bId) === true && (s.lastCheckpoint.snapshot?.messageCount ?? 0) >= 4,
			"a checkpoint with both turns reached B",
		);
		await pair.stop("a");
		await waitForShared(pair.b, shared.id, (s) => s.takeoverAvailable, "takeover available", 20_000);
		const took = await api(pair.b).post<SharedSession>(`/shared/${shared.id}/takeover`, {});
		expect(took.status, JSON.stringify(took.body)).toBe(200);
		const note = await continuationNote(took.body.localSessionId as string);
		expect(note).toContain("may be missing");
		expect(note).not.toContain("--- What node-a's agent did after");
		expect(note).not.toContain("--- end ---");
	});
});
