import { realpathSync } from "node:fs";
import type { Checkpoint, SharedSession } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api } from "./full-harness.ts";
import { eventually } from "./net-helpers.ts";
import {
	detailOn,
	git,
	isolateGitConfig,
	promptAndWait,
	readIn,
	sessionOn,
	startSharedPair,
	transcriptTexts,
	waitForShared,
	whenSettled,
	worktreeOf,
	type GitConfigIsolation,
	type SharedPair,
} from "./shared-fixtures.ts";

/**
 * A node that handed the driver role on keeps its worktree of the shared branch, and its participant agent works there: it may push to the
 * shared branch beside the lead. The lead's next checkpoint push is then refused (the branch moved on); the lead's agent is told once to
 * pull with rebase, and once it has, the checkpoint pushes both sides' work.
 */

let gitConfig: GitConfigIsolation;
beforeAll(() => {
	gitConfig = isolateGitConfig();
});
afterAll(() => gitConfig.restore());

let pair: SharedPair;
afterEach(async () => {
	await pair?.cleanup();
});

const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
/** The notices the lead's session received (the fake agent echoes each one back; that answer does not count). */
const refusedNotices = async (sessionId: string) => (await transcriptTexts(pair.b, sessionId)).filter((t) => t.startsWith("[CL Agent Mesh]") && t.includes("checkpoint not pushed")).length;

describe("a participant agent in the former driver's worktree", () => {
	it("works on the shared branch; its push makes the lead's checkpoint refused, the lead is told once, and after a pull --rebase the checkpoint pushes", async () => {
		pair = await startSharedPair();
		const { sessionId: drivingId, shared } = await pair.shareAndJoin({ title: "Notes", firstPrompt: "write the notes" });
		const branch = shared.repo?.branch as string;
		const started = await api(pair.a).post<SharedSession>(`/shared/${shared.id}/transfer`, { toNodeId: pair.bId });
		expect(started.status, JSON.stringify(started.body)).toBe(202);
		await waitForShared(pair.a, shared.id, (s) => s.transfer?.phase === "continuing", "the hand-over to finish", 60_000);
		const onB = await waitForShared(pair.b, shared.id, (s) => s.localRole === "driver" && s.epoch === 2, "B is the driver");
		const leadId = onB.localSessionId as string;
		// A's own seat names the session it drove until the participant agent session that replaces it is created
		const seatOf = (s: SharedSession) => s.participants.find((p) => p.nodeId === pair.aId)?.agentSessionId;
		const former = await waitForShared(pair.a, shared.id, (s) => Boolean(seatOf(s)) && seatOf(s) !== drivingId, "A's participant agent", 30_000);
		const participantId = seatOf(former) as string;

		// A's participant agent works in A's worktree of the shared branch, and was briefed that it may push there
		const worktreeA = worktreeOf(pair.a, shared.id);
		expect((await sessionOn(pair.a, participantId)).checkoutId).toBe(`${pair.projectA.id}~${shared.id}`);
		await eventually(async () => (await transcriptTexts(pair.a, participantId)).some((t) => t.includes(`worktree of the shared branch ${branch}`)), "the participant brief", 30_000);
		await whenSettled(pair.a, participantId);
		await promptAndWait(pair.a, participantId, "@@fake-sh echo from-a > FROM_A.md");
		expect(realpathSync(pair.a.ctx.runtime.get(participantId)?.spec.cwd as string)).toBe(realpathSync(worktreeA));
		expect(readIn(worktreeA, "FROM_A.md")).toBe("from-a\n");
		expect(git(pair.workA, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
		// what the brief tells it to do: commit and push at once
		git(worktreeA, "add", "FROM_A.md");
		git(worktreeA, ...ID, "commit", "-m", "from A");
		git(worktreeA, "push", "origin", `HEAD:${branch}`);

		// the lead changes something too: its checkpoint commits, but the push is refused and the lead's agent is told
		await whenSettled(pair.b, leadId);
		await promptAndWait(pair.b, leadId, "@@fake-sh echo from-b > FROM_B.md");
		await whenSettled(pair.b, leadId);
		const refused = await api(pair.b).post<Checkpoint>(`/shared/${shared.id}/checkpoint`, { note: "lead work" });
		expect(refused.status, JSON.stringify(refused.body)).toBe(200);
		expect(refused.body.pushed).toBe(false);
		await eventually(async () => (await refusedNotices(leadId)) === 1, "the lead to be told the push was refused", 20_000);
		const notice = (await transcriptTexts(pair.b, leadId)).find((t) => t.startsWith("[CL Agent Mesh]") && t.includes("checkpoint not pushed")) as string;
		expect(notice).toContain("git pull --rebase");
		expect(notice).toContain("another participant pushed");
		expect((await detailOn(pair.b, shared.id)).messages.some((m) => m.author.kind === "system" && m.text.includes("could not be pushed"))).toBe(true);

		// still diverged: another refused checkpoint does not tell the lead again
		await whenSettled(pair.b, leadId);
		const again = await api(pair.b).post<Checkpoint>(`/shared/${shared.id}/checkpoint`, {});
		expect(again.body.pushed).toBe(false);
		await whenSettled(pair.b, leadId);
		expect(await refusedNotices(leadId)).toBe(1);

		// the lead pulls the participant's commit in (what the notice asks): the next checkpoint pushes both sides' work
		const worktreeB = worktreeOf(pair.b, shared.id);
		git(worktreeB, ...ID, "pull", "--rebase", "origin", branch);
		const pushed = await api(pair.b).post<Checkpoint>(`/shared/${shared.id}/checkpoint`, {});
		expect(pushed.body.pushed, JSON.stringify(pushed.body)).toBe(true);
		expect(git(pair.origin, "show", `${branch}:FROM_A.md`)).toBe("from-a\n");
		expect(git(pair.origin, "show", `${branch}:FROM_B.md`)).toBe("from-b\n");
	}, 120_000);
});
