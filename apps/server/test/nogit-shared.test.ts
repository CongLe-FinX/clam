import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Checkpoint, FilesApplyResult, FilesPreview, Project, SharedInvite, SharedSession } from "@clam/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { api } from "./full-harness.ts";
import { eventually, signedRequest } from "./net-helpers.ts";
import { exists, read, startPlainPair, write, type PlainPair } from "./nogit-fixtures.ts";
import { detailOn, promptAndWait, sessionOn, sharedOn, transcriptTexts, waitForShared, whenSettled } from "./shared-fixtures.ts";

/**
 * Shared sessions in FILES mode (no git repository anywhere): the driver's working folder travels as a bundle with every
 * checkpoint, next to the OMP session snapshot. Two real in-process nodes, fake omp, temp folders.
 */

let pair: PlainPair;
afterEach(async () => {
	await pair?.cleanup();
});

const folderOf = async (node: PlainPair["a"], projectId: string | null): Promise<string> => (await api(node).get<Project>(`/projects/${projectId}`)).body.path;

/** A drives `Plain notes` in the managed project and has written NOTES.md; B joined (managed folder) and holds the checkpoint. */
async function started() {
	pair = await startPlainPair();
	const joined = await pair.shareAndJoin({ firstPrompt: "@@fake-sh echo 'line one' > NOTES.md" });
	const held = await waitForShared(pair.a, joined.shared.id, (s) => s.lastCheckpoint?.files != null && s.lastCheckpoint.deliveredTo.includes(pair.bId), "the first folder bundle reached B");
	const folderB = await folderOf(pair.b, joined.onB.localProjectId);
	await eventually(() => exists(folderB, "NOTES.md"), "the first bundle placed in B's folder", 20_000);
	return { ...joined, checkpoint: held.lastCheckpoint as Checkpoint, folderA: pair.projectA.path, folderB };
}

describe("sharing a session of a plain folder", () => {
	it("creates a files-mode shared session; the invitation says so; accepting gives B a managed folder holding A's files", async () => {
		pair = await startPlainPair();
		const created = await api(pair.a).post<{ id: string }>("/sessions", { projectId: pair.projectA.id, title: "Plain notes" });
		await promptAndWait(pair.a, created.body.id, "@@fake-sh echo 'line one' > NOTES.md");
		const added = await api(pair.a).post<SharedSession>(`/sessions/${created.body.id}/participants`, { nodeId: pair.bId });
		expect(added.status, JSON.stringify(added.body)).toBe(201);
		expect(added.body).toMatchObject({ vcs: "files", repo: null, localRole: "driver", rescueFiles: null });

		const invite = await eventually(async () => (await api(pair.b).get<SharedInvite[]>("/shared/invites")).body.find((i) => i.sharedSessionId === added.body.id && i.state === "pending"), "the invitation on B");
		expect(invite).toMatchObject({ vcs: "files", repo: null, workspaceId: pair.workspace.id });
		// B has no plain-folder project in this workspace yet: nothing to suggest, accepting creates a managed folder
		expect(invite.candidateProjectIds).toEqual([]);
		const accepted = await api(pair.b).post<SharedInvite>(`/shared/invites/${invite.id}/decide`, { decision: "accept" });
		expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

		const onB = await waitForShared(pair.b, added.body.id, (s) => s.localRole === "participant" && s.mirrorSessionId !== null, "B joined");
		expect(onB).toMatchObject({ vcs: "files", repo: null });
		const projectB = (await api(pair.b).get<Project>(`/projects/${onB.localProjectId}`)).body;
		expect(projectB).toMatchObject({ managed: true, vcs: "none", workspaceId: pair.workspace.id });
		await eventually(() => exists(projectB.path, "NOTES.md"), "A's file in B's managed folder", 20_000);
		expect(read(projectB.path, "NOTES.md")).toBe("line one\n");
	});

	it("an auto-accepting B joins without a clone or a human: the session gets a managed folder", async () => {
		pair = await startPlainPair();
		await pair.autoAcceptOnB(true);
		const created = await api(pair.a).post<{ id: string }>("/sessions", { projectId: pair.projectA.id, title: "Auto" });
		const added = await api(pair.a).post<SharedSession>(`/sessions/${created.body.id}/participants`, { nodeId: pair.bId });
		expect(added.status).toBe(201);
		const onB = await waitForShared(pair.b, added.body.id, (s) => s.localRole === "participant" && s.localProjectId !== null, "B joined on its own");
		expect((await api(pair.b).get<Project>(`/projects/${onB.localProjectId}`)).body.managed).toBe(true);
	});

	it("B may join into one of its plain-folder projects instead; its different files are kept", async () => {
		pair = await startPlainPair();
		const created = await api(pair.a).post<{ id: string }>("/sessions", { projectId: pair.projectA.id, title: "Into mine" });
		await promptAndWait(pair.a, created.body.id, "@@fake-sh echo 'from A' > NOTES.md");
		const mine = (await api(pair.b).post<Project>("/projects", { workspaceId: pair.workspace.id, name: "B folder" })).body;
		write(mine.path, "NOTES.md", "B's own\n");
		write(mine.path, "other.txt", "stays\n");
		const added = await api(pair.a).post<SharedSession>(`/sessions/${created.body.id}/participants`, { nodeId: pair.bId });
		const invite = await eventually(async () => (await api(pair.b).get<SharedInvite[]>("/shared/invites")).body.find((i) => i.sharedSessionId === added.body.id), "the invitation on B");
		expect(invite.candidateProjectIds).toEqual([mine.id]);
		const accepted = await api(pair.b).post<SharedInvite>(`/shared/invites/${invite.id}/decide`, { decision: "accept", projectId: mine.id });
		expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
		const onB = await waitForShared(pair.b, added.body.id, (s) => s.localProjectId === mine.id && (s.lastCheckpoint?.files ?? null) !== null, "B holds the folder bundle");
		await eventually(async () => (await detailOn(pair.b, onB.id)).messages.some((m) => m.text.includes("kept")), "B notes which file it kept", 20_000);
		expect(read(mine.path, "NOTES.md")).toBe("B's own\n");
		expect(read(mine.path, "other.txt")).toBe("stays\n");
		// a project of another workspace cannot take the session
		const stray = (await api(pair.b).post<{ id: string }>("/workspaces", { name: "Elsewhere" })).body;
		const strayProject = (await api(pair.b).post<Project>("/projects", { workspaceId: stray.id, name: "stray" })).body;
		const second = await api(pair.a).post<{ id: string }>("/sessions", { projectId: pair.projectA.id, title: "Second" });
		const addedTwo = await api(pair.a).post<SharedSession>(`/sessions/${second.body.id}/participants`, { nodeId: pair.bId });
		const inviteTwo = await eventually(async () => (await api(pair.b).get<SharedInvite[]>("/shared/invites")).body.find((i) => i.sharedSessionId === addedTwo.body.id), "the second invitation");
		const refused = await api(pair.b).post<{ error: { code: string } }>(`/shared/invites/${inviteTwo.id}/decide`, { decision: "accept", projectId: strayProject.id });
		expect(refused.status).toBe(409);
		expect(refused.body.error.code).toBe("project_mismatch");
	});
});

describe("checkpoints carry the folder", () => {
	it("a checkpoint is a bundle of the driver's folder plus the session snapshot, both delivered with their digests", async () => {
		const { shared, checkpoint, folderB } = await started();
		expect(checkpoint).toMatchObject({ branch: null, commit: null, pushed: false });
		expect(checkpoint.files).toMatchObject({ fileCount: 1 });
		expect(checkpoint.snapshot).not.toBeNull();
		expect(read(folderB, "NOTES.md")).toBe("line one\n");

		// B holds both parts, owner-only, at the path the database records
		const row = pair.b.ctx.shared.store.checkpoint(shared.id, checkpoint.seq);
		const bundle = path.join(pair.b.dataDir, "shared", shared.id, "files", `${checkpoint.seq}.tar.gz`);
		expect(row?.filesPath).toBe(`${shared.id}/files/${checkpoint.seq}.tar.gz`);
		expect(statSync(bundle).size).toBe(checkpoint.files?.size);
		expect(statSync(bundle).mode & 0o777).toBe(0o600);
		expect(existsSync(path.join(pair.b.dataDir, "shared", shared.id, "snapshots", `${checkpoint.seq}.tar`))).toBe(true);
		// the folder is bundled without .git, node_modules and .env files
		write(pair.projectA.path, ".env", "TOKEN=nope\n");
		write(pair.projectA.path, "node_modules/x/index.js", "x\n");
		const next = await api(pair.a).post<Checkpoint>(`/shared/${shared.id}/checkpoint`, { note: "manual" });
		expect(next.status, JSON.stringify(next.body)).toBeLessThan(300);
		expect(next.body.files?.fileCount).toBe(1);
	});

	it("the wire route serves the bundle to active participants with its digest and 404s for anything else", async () => {
		const { shared, checkpoint } = await started();
		const ok = await signedRequest(pair.b, pair.a.netUrl, { path: `/shared/${shared.id}/files/${checkpoint.seq}` });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-length")).toBe(String(checkpoint.files?.size));
		expect(ok.headers.get("content-digest")).toBe(`sha-256=:${Buffer.from(checkpoint.files?.sha256 as string, "hex").toString("base64")}:`);
		expect((await signedRequest(pair.b, pair.a.netUrl, { path: `/shared/${shared.id}/files/999` })).status).toBe(404);
		expect((await signedRequest(pair.b, pair.a.netUrl, { path: `/shared/shs_unknown/files/1` })).status).toBe(404);
		expect((await signedRequest(pair.b, pair.a.netUrl, { path: `/shared/${shared.id}/files/abc` })).status).toBe(400);
	});

	it("participants stay in step with the group chat and mirror exactly as in git mode", async () => {
		const { shared, sessionId } = await started();
		await eventually(async () => (await transcriptTexts(pair.b, (await sharedOn(pair.b, shared.id)).mirrorSessionId as string)).some((t) => t.includes("line one")), "A's conversation in B's mirror", 20_000);
		expect((await sessionOn(pair.a, sessionId)).kind).toBe("local");
	});
});

describe("takeover without a repository", () => {
	async function withSecondBundle() {
		const ctx = await started();
		await promptAndWait(pair.a, ctx.sessionId, "@@fake-sh echo 'line two' >> NOTES.md && echo second > SECOND.md");
		const second = await waitForShared(pair.a, ctx.shared.id, (s) => (s.lastCheckpoint?.seq ?? 0) > ctx.checkpoint.seq && (s.lastCheckpoint?.files?.fileCount ?? 0) === 2 && s.lastCheckpoint?.deliveredTo.includes(pair.bId) === true, "the second bundle reached B", 30_000);
		return { ...ctx, second: second.lastCheckpoint as Checkpoint };
	}

	it("A offline: B restores the folder from the last bundle, unpacks the snapshot and continues with A's history", async () => {
		const { shared, sessionId, second, folderB } = await withSecondBundle();
		expect((await sharedOn(pair.b, shared.id)).takeoverAvailable).toBe(false);
		await pair.stop("a");
		await waitForShared(pair.b, shared.id, (s) => s.takeoverAvailable, "takeover available", 20_000);
		const took = await api(pair.b).post<SharedSession>(`/shared/${shared.id}/takeover`, {});
		expect(took.status, JSON.stringify(took.body)).toBe(200);
		expect(took.body).toMatchObject({ localRole: "driver", epoch: 2, vcs: "files", rescueFiles: null });
		const newSessionId = took.body.localSessionId as string;
		expect(newSessionId).not.toBe(sessionId);

		expect(read(folderB, "NOTES.md")).toBe("line one\nline two\n");
		expect(read(folderB, "SECOND.md")).toBe("second\n");
		await eventually(async () => (await transcriptTexts(pair.b, newSessionId)).some((t) => t.includes("driver changed (epoch 2)")), "the continuation note", 20_000);
		const texts = await transcriptTexts(pair.b, newSessionId);
		expect(texts).toEqual(expect.arrayContaining([expect.stringContaining("@@fake-sh echo 'line one'"), expect.stringContaining("@@fake-sh echo 'line two'")]));
		const note = texts.find((t) => t.includes("driver changed (epoch 2)")) as string;
		expect(note).toContain(`checkpoint ${second.seq} (folder bundle of 2 file(s)`);
		expect(note).toContain("There is no git repository");
		expect(note).toContain("never bundled");
		expect(note).toContain("may be missing");
		expect(note).not.toMatch(/branch|commit/);
		expect(await sharedOn(pair.b, shared.id)).toMatchObject({ driverNodeId: pair.bId });
	});

	it("tells the takeover which file changes after the last bundle may be missing (the post-checkpoint digest is about files too)", async () => {
		const { shared } = await withSecondBundle();
		// work A does after its last bundle: B only sees it in the mirror
		const sessionA = (await sharedOn(pair.a, shared.id)).localSessionId as string;
		pair.a.ctx.shared.checkpoints.turnSettled = () => {};
		await promptAndWait(pair.a, sessionA, "@@fake-sh echo late > LATE.md");
		await eventually(async () => (await transcriptTexts(pair.b, (await sharedOn(pair.b, shared.id)).mirrorSessionId as string)).some((t) => t.includes("LATE.md")), "the late turn in B's mirror", 20_000);
		await pair.stop("a");
		await waitForShared(pair.b, shared.id, (s) => s.takeoverAvailable, "takeover available", 20_000);
		const took = await api(pair.b).post<SharedSession>(`/shared/${shared.id}/takeover`, {});
		expect(took.status, JSON.stringify(took.body)).toBe(200);
		const newSessionId = took.body.localSessionId as string;
		await eventually(async () => (await transcriptTexts(pair.b, newSessionId)).some((t) => t.includes("driver changed (epoch 2)")), "the continuation note", 20_000);
		const note = (await transcriptTexts(pair.b, newSessionId)).find((t) => t.includes("driver changed (epoch 2)")) as string;
		expect(note).toContain("What node-a's agent did after checkpoint");
		expect(note).toContain("LATE.md");
		expect(note).toContain("unless they were part of the bundle");
		const folderB = await folderOf(pair.b, took.body.localProjectId);
		expect(exists(folderB, "LATE.md")).toBe(false);
	});

	it("refuses to replace files edited on B since the last checkpoint unless forced; forcing saves them as a rescue bundle first", async () => {
		const { shared, folderB } = await withSecondBundle();
		write(folderB, "NOTES.md", "B's own notes\n");
		write(folderB, "mine.txt", "only on B\n");
		await pair.stop("a");
		await waitForShared(pair.b, shared.id, (s) => s.takeoverAvailable, "takeover available", 20_000);

		const refused = await api(pair.b).post<{ error: { code: string; message: string; details?: { paths: string[] } } }>(`/shared/${shared.id}/takeover`, {});
		expect(refused.status).toBe(409);
		expect(refused.body.error.code).toBe("files_conflict");
		expect(refused.body.error.details?.paths).toEqual(["NOTES.md"]);
		expect(read(folderB, "NOTES.md")).toBe("B's own notes\n");
		expect(exists(folderB, "SECOND.md")).toBe(false); // nothing was applied
		expect((await sharedOn(pair.b, shared.id)).localRole).toBe("participant");

		const forced = await api(pair.b).post<SharedSession>(`/shared/${shared.id}/takeover`, { force: true });
		expect(forced.status, JSON.stringify(forced.body)).toBe(200);
		expect(read(folderB, "NOTES.md")).toBe("line one\nline two\n");
		expect(read(folderB, "SECOND.md")).toBe("second\n");
		// never deletes: a file only B has is still there; the replaced version is in the rescue bundle
		expect(read(folderB, "mine.txt")).toBe("only on B\n");
		expect(forced.body.rescueFiles).toMatchObject({ fileCount: 1, paths: ["NOTES.md"], epoch: 1 });

		// the rescue bundle can be looked at and applied to a project (conflicts only with `overwrite`)
		const target = (await api(pair.b).post<Project>("/projects", { workspaceId: pair.workspace.id, name: "rescued" })).body;
		const preview = await api(pair.b).get<FilesPreview>(`/shared/${shared.id}/rescue/preview?projectId=${target.id}`);
		expect(preview.status, JSON.stringify(preview.body)).toBe(200);
		expect(preview.body.files).toEqual([{ path: "NOTES.md", status: "new", size: "B's own notes\n".length }]);
		const applied = await api(pair.b).post<FilesApplyResult>(`/shared/${shared.id}/rescue/apply`, { projectId: target.id });
		expect(applied.body.written).toEqual(["NOTES.md"]);
		expect(read(target.path, "NOTES.md")).toBe("B's own notes\n");
		const onFolder = await api(pair.b).get<FilesPreview>(`/shared/${shared.id}/rescue/preview?projectId=${forced.body.localProjectId}`);
		expect(onFolder.body.files[0]?.status).toBe("conflict");
		const kept = await api(pair.b).post<FilesApplyResult>(`/shared/${shared.id}/rescue/apply`, { projectId: forced.body.localProjectId });
		expect(kept.body.skipped).toEqual([{ path: "NOTES.md", reason: "conflict" }]);
		expect(read(folderB, "NOTES.md")).toBe("line one\nline two\n");
	});

	it("while the driver is online a takeover still needs force; a missing bundle is a clear 409", async () => {
		const { shared } = await started();
		const refused = await api(pair.b).post<{ error: { code: string } }>(`/shared/${shared.id}/takeover`, {});
		expect(refused.body.error.code).toBe("driver_online");
		await pair.stop("a");
		await waitForShared(pair.b, shared.id, (s) => s.takeoverAvailable, "takeover available", 20_000);
		// the bundle file is gone on B: the takeover is unavailable rather than half done
		const row = pair.b.ctx.shared.store.checkpoint(shared.id, 1);
		pair.b.ctx.shared.store.updateCheckpoint(shared.id, row?.seq as number, { filesPath: null });
		const view = await sharedOn(pair.b, shared.id);
		expect(view.takeoverAvailable).toBe(false);
		expect(view.takeoverBlockedReason).toMatch(/folder bundle/);
	});
});

describe("hand-over without a repository", () => {
	it("a planned hand-over delivers everything, files created a moment before included, and A keeps a moved copy pointing at B", async () => {
		const { shared, sessionId, folderB } = await started();
		await promptAndWait(pair.a, sessionId, "@@fake-sh echo fresh > FRESH.md");
		await whenSettled(pair.a, sessionId);
		const started2 = await api(pair.a).post<SharedSession>(`/shared/${shared.id}/transfer`, { toNodeId: pair.bId });
		expect(started2.status, JSON.stringify(started2.body)).toBe(202);
		const moved = await waitForShared(pair.b, shared.id, (s) => s.localRole === "driver" && s.epoch === 2, "B drives", 30_000);
		expect(moved.localSessionId).not.toBeNull();
		expect(read(folderB, "NOTES.md")).toBe("line one\n");
		expect(read(folderB, "FRESH.md")).toBe("fresh\n");
		const former = await waitForShared(pair.a, shared.id, (s) => s.localRole === "former_driver" && s.driverNodeId === pair.bId && s.transfer?.phase === "continuing", "A follows B", 30_000);
		expect(former.rescueFiles).toBeNull();
		// A's session is a read-only moved copy pointing at B (the banner's data)
		await eventually(async () => (await sessionOn(pair.a, sessionId)).movedTo !== null, "A's session marked moved", 20_000);
		expect((await sessionOn(pair.a, sessionId)).movedTo).toMatchObject({ nodeId: pair.bId, sessionId: moved.localSessionId });
		await eventually(async () => (await transcriptTexts(pair.b, moved.localSessionId as string)).some((t) => t.includes("driver changed (epoch 2)")), "the continuation note on B", 20_000);
		const texts = await transcriptTexts(pair.b, moved.localSessionId as string);
		expect(texts).toEqual(expect.arrayContaining([expect.stringContaining("@@fake-sh echo 'line one'"), expect.stringContaining("@@fake-sh echo fresh")]));
		const note = texts.find((t) => t.includes("driver changed (epoch 2)")) as string;
		expect(note).toContain("every file is in the bundle");
		expect(note).toContain("Nothing is missing");
		expect(note).not.toContain("may be missing");
	});

	it("a hand-over replaces B's local edits only after saving them (a planned hand-over never stops for a conflict)", async () => {
		const { shared, sessionId, folderB } = await started();
		write(folderB, "NOTES.md", "B scribbles\n");
		await promptAndWait(pair.a, sessionId, "@@fake-sh echo 'line two' >> NOTES.md");
		await whenSettled(pair.a, sessionId);
		const res = await api(pair.a).post(`/shared/${shared.id}/transfer`, { toNodeId: pair.bId });
		expect(res.status).toBe(202);
		const moved = await waitForShared(pair.b, shared.id, (s) => s.localRole === "driver" && s.epoch === 2, "B drives", 30_000);
		expect(read(folderB, "NOTES.md")).toBe("line one\nline two\n");
		expect(moved.rescueFiles).toMatchObject({ fileCount: 1, paths: ["NOTES.md"] });
	});
});

describe("the former driver comes back", () => {
	it("keeps what it did after its last bundle as a rescue bundle; nothing is deleted or discarded", { timeout: 120_000 }, async () => {
		const { shared, sessionId, folderA, checkpoint } = await started();
		// A does work that no checkpoint has (written to its folder directly), then dies
		write(folderA, "unsynced.txt", "after the last checkpoint\n");
		write(folderA, "NOTES.md", "line one\nedited late\n");
		await pair.stop("a");
		await waitForShared(pair.b, shared.id, (s) => s.takeoverAvailable, "takeover available", 20_000);
		const took = await api(pair.b).post<SharedSession>(`/shared/${shared.id}/takeover`, {});
		expect(took.status, JSON.stringify(took.body)).toBe(200);

		const a = await pair.start("a");
		const former = await waitForShared(a, shared.id, (s) => s.localRole === "former_driver" && s.driverNodeId === pair.bId && s.epoch === 2 && s.rescueFiles !== null, "A learned it lost the role and kept its work", 40_000);
		expect(former.rescueFiles?.fileCount).toBe(2);
		expect(former.rescueFiles?.paths.sort()).toEqual(["NOTES.md", "unsynced.txt"]);
		expect(former.rescueFiles?.epoch).toBe(2);
		// A's folder is untouched and its session is a read-only moved copy
		expect(read(folderA, "unsynced.txt")).toBe("after the last checkpoint\n");
		expect(read(folderA, "NOTES.md")).toBe("line one\nedited late\n");
		await eventually(async () => (await sessionOn(a, sessionId)).movedTo !== null, "A's session marked moved", 20_000);
		await eventually(async () => (await detailOn(a, shared.id)).messages.some((m) => m.text.includes("rescue bundle")), "the group learns about the rescue bundle", 20_000);
		// the rescue bundle holds exactly those two files and applies to a fresh project
		const target = (await api(a).post<Project>("/projects", { workspaceId: pair.workspace.id, name: "recovered" })).body;
		const preview = await api(a).get<FilesPreview>(`/shared/${shared.id}/rescue/preview?projectId=${target.id}`);
		expect(preview.body.files.map((f) => f.path).sort()).toEqual(["NOTES.md", "unsynced.txt"]);
		const applied = await api(a).post<FilesApplyResult>(`/shared/${shared.id}/rescue/apply`, { projectId: target.id });
		expect(applied.body.written.sort()).toEqual(["NOTES.md", "unsynced.txt"]);
		expect(read(target.path, "NOTES.md")).toBe("line one\nedited late\n");
		expect(checkpoint.files?.fileCount).toBe(1);
	});
});

describe("restarts", () => {
	it("a participant that was down when a checkpoint was taken fetches the snapshot and the bundle when it is back, then can take over", async () => {
		const { shared, sessionId, folderB } = await started();
		await pair.stop("b");
		await promptAndWait(pair.a, sessionId, "@@fake-sh echo 'while B was away' > AWAY.md");
		const latest = await waitForShared(pair.a, shared.id, (s) => (s.lastCheckpoint?.files?.fileCount ?? 0) === 2, "A took a bundle with AWAY.md", 30_000);
		expect(latest.lastCheckpoint?.deliveredTo).not.toContain(pair.bId);

		const b = await pair.start("b");
		const delivered = await waitForShared(pair.a, shared.id, (s) => s.lastCheckpoint?.seq === latest.lastCheckpoint?.seq && s.lastCheckpoint?.deliveredTo.includes(pair.bId) === true, "B acknowledged the checkpoint after restarting", 40_000);
		expect(delivered.lastCheckpoint?.files?.fileCount).toBe(2);
		expect(b.ctx.shared.store.checkpoint(shared.id, delivered.lastCheckpoint?.seq as number)?.filesPath).not.toBeNull();

		await pair.stop("a");
		await waitForShared(b, shared.id, (s) => s.takeoverAvailable, "takeover available", 30_000);
		const took = await api(b).post<SharedSession>(`/shared/${shared.id}/takeover`, {});
		expect(took.status, JSON.stringify(took.body)).toBe(200);
		expect(read(await folderOf(b, took.body.localProjectId), "AWAY.md")).toBe("while B was away\n");
		expect(folderB).toBe(await folderOf(b, took.body.localProjectId));
	});

	it("the former driver's synced state and rescue bundle survive a restart of the driver", async () => {
		const { shared, folderA } = await started();
		await pair.stop("a");
		const a = await pair.start("a");
		// the synced manifest (base of local-edit detection) is on disk, so a restarted driver still knows what it shared
		expect(existsSync(path.join(a.dataDir, "shared", shared.id, "synced-manifest.json"))).toBe(true);
		write(folderA, "after-restart.txt", "x\n");
		await waitForShared(a, shared.id, (s) => s.localRole === "driver", "A still drives");
		const next = await api(a).post<Checkpoint>(`/shared/${shared.id}/checkpoint`, {});
		expect(next.status, JSON.stringify(next.body)).toBeLessThan(300);
		expect(next.body.files?.fileCount).toBe(2);
	});
});
