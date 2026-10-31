import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentSession, Peer, SharedInvite, SharedSession } from "@clam/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api, type FullHarness } from "./full-harness.ts";
import { eventually, peerOf, signedRequest } from "./net-helpers.ts";
import { downloadSnapshot, digestHeader, SnapshotRejectedError } from "../src/shared/snapshots.ts";
import {
	detailOn,
	git,
	isolateGitConfig,
	promptAndWait,
	promptsOf,
	sessionsOn,
	sharedOn,
	startSharedPair,
	textOf,
	transcript,
	transcriptTexts,
	waitForShared,
	whenSettled,
	type GitConfigIsolation,
	type SharedPair,
} from "./shared-fixtures.ts";

/**
 * The wire endpoints of shared sessions (`/api/v1/shared*`), driven with fully signed requests between two real nodes:
 * duplicate and out-of-order deliveries are idempotent, every endpoint refuses what it must (capability, role, membership,
 * malformed input), and snapshots are verified while they are downloaded.
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

function post(from: FullHarness, to: FullHarness, pathName: string, body: unknown, options: { key?: string; bodyOverride?: string } = {}) {
	return signedRequest(from, to.netUrl, { method: "POST", path: pathName, body, ...(options.key && { idempotencyKey: options.key }), ...(options.bodyOverride !== undefined && { bodyOverride: options.bodyOverride }) });
}

const FAKE_SHA = "0".repeat(64);

let wireSeq = 500;
/** A valid group message as node B (its origin) pushes it; sequence numbers start far above what the real nodes use. */
function groupMessage(pair: SharedPair, overrides: Record<string, unknown> = {}) {
	const seq = ++wireSeq;
	return {
		messageId: `shm_wire_${seq}`,
		epoch: 1,
		kind: "chat",
		body: "hello",
		author: { kind: "human" },
		to: { mode: "lead", agents: [] },
		origin: { nodeId: pair.bId, nodeName: "node-b", seq },
		hlc: `${String(Date.now()).padStart(15, "0")}-00000`,
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function inviteBody(pair: SharedPair, overrides: Record<string, unknown> = {}) {
	return {
		inviteId: "shi_wire1",
		sharedSessionId: "shs_wire1",
		workspaceId: pair.workspace.id,
		title: "Wire invite",
		goal: "",
		repo: { url: "https://github.com/acme/demo", branch: "clam/shared/wire-abc123" },
		epoch: 1,
		driver: { agentName: "OMP Agent" },
		...overrides,
	};
}

/** A shared session with B joined and the first snapshot held by B. */
async function joined() {
	pair = await startSharedPair();
	const result = await pair.shareAndJoin({ firstPrompt: "start" });
	await waitForShared(pair.a, result.shared.id, (s) => s.lastCheckpoint?.deliveredTo.includes(pair.bId) === true, "the first snapshot reached B");
	return result;
}

async function setCapabilities(node: FullHarness, peerId: string, capabilities: string[]): Promise<void> {
	const res = await api(node).patch<Peer>(`/network/peers/${peerId}`, { grantedCapabilities: capabilities });
	if (res.status !== 200) throw new Error(`patch failed: ${JSON.stringify(res.body)}`);
}

describe("invitations", () => {
	it("a replayed invite (same inviteId, same Idempotency-Key) is answered from the response store: one invite row, one event", async () => {
		pair = await startSharedPair();
		const body = inviteBody(pair);
		const first = await post(pair.a, pair.b, "/shared/invites", body, { key: "wire-inv-1" });
		expect(first.status).toBe(202);
		expect(first.body).toEqual({ inviteId: "shi_wire1", state: "pending" });
		expect(first.headers.get("idempotent-replay")).toBeNull();
		const replay = await post(pair.a, pair.b, "/shared/invites", body, { key: "wire-inv-1" });
		expect(replay.status).toBe(202);
		expect(replay.body).toEqual(first.body);
		expect(replay.headers.get("idempotent-replay")).toBe("true");
		const invites = (await api(pair.b).get<SharedInvite[]>("/shared/invites")).body;
		expect(invites).toEqual([expect.objectContaining({ id: "shi_wire1", sharedSessionId: "shs_wire1", state: "pending", candidateProjectIds: [pair.projectB.id], title: "Wire invite", from: expect.objectContaining({ nodeId: pair.aId, nodeName: "node-a" }) })]);
		expect(await sessionsOn(pair.b)).toEqual([]);
	});

	it("the same inviteId under a different key is not a second invite: 200 with the current state, still one row", async () => {
		pair = await startSharedPair();
		const body = inviteBody(pair);
		expect((await post(pair.a, pair.b, "/shared/invites", body, { key: "wire-inv-a" })).status).toBe(202);
		const again = await post(pair.a, pair.b, "/shared/invites", body, { key: "wire-inv-b" });
		expect(again.status).toBe(200);
		expect(again.body).toEqual({ inviteId: "shi_wire1", state: "pending" });
		expect(again.headers.get("idempotent-replay")).toBeNull();
		// even with a changed title the first invitation stands
		const changed = await post(pair.a, pair.b, "/shared/invites", inviteBody(pair, { title: "Something else" }), { key: "wire-inv-c" });
		expect(changed.status).toBe(200);
		const invites = (await api(pair.b).get<SharedInvite[]>("/shared/invites")).body;
		expect(invites).toHaveLength(1);
		expect(invites[0]?.title).toBe("Wire invite");
		// a different inviteId IS a new invitation
		expect((await post(pair.a, pair.b, "/shared/invites", inviteBody(pair, { inviteId: "shi_wire2" }), { key: "wire-inv-d" })).status).toBe(202);
		expect((await api(pair.b).get<SharedInvite[]>("/shared/invites")).body).toHaveLength(2);
	});

	it("an invite for a shared session this node already takes part in is acknowledged as accepted and creates nothing", async () => {
		const { shared } = await joined();
		const before = (await api(pair.b).get<SharedInvite[]>("/shared/invites")).body.length;
		const res = await post(pair.a, pair.b, "/shared/invites", inviteBody(pair, { inviteId: "shi_again", sharedSessionId: shared.id }), { key: "wire-inv-again" });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ inviteId: "shi_again", state: "accepted" });
		expect((await api(pair.b).get<SharedInvite[]>("/shared/invites")).body).toHaveLength(before);
	});

	it("rejects malformed invitations (400) and senders that are not in the workspace (403)", async () => {
		pair = await startSharedPair();
		const bad: Array<[string, Record<string, unknown>]> = [
			["no inviteId", { inviteId: undefined }],
			["an id with spaces", { inviteId: "shi bad id" }],
			["a shared id with spaces", { sharedSessionId: "shs bad" }],
			["an empty title", { title: "" }],
			["a non-positive epoch", { epoch: 0 }],
			["no repo", { repo: undefined }],
			["a repo that is not on GitHub", { repo: { url: "https://example.com/acme/demo", branch: "x" } }],
			["an empty branch", { repo: { url: "https://github.com/acme/demo", branch: "" } }],
		];
		for (const [what, overrides] of bad) {
			const res = await post(pair.a, pair.b, "/shared/invites", inviteBody(pair, overrides));
			expect(res.status, what).toBe(400);
			expect(res.body.error.code, what).toMatch(/invalid|bad_request|validation/);
		}
		const malformed = await post(pair.a, pair.b, "/shared/invites", undefined, { bodyOverride: "{not json" });
		expect(malformed.status).toBe(400);
		const stranger = await post(pair.a, pair.b, "/shared/invites", inviteBody(pair, { workspaceId: "wsp_unknown" }));
		expect(stranger.status).toBe(403);
		expect(stranger.body.error.code).toBe("forbidden");
		const unknownAgent = await post(pair.a, pair.b, "/shared/invites", inviteBody(pair, { targetAgentId: "agt_nobody" }));
		expect(unknownAgent.status).toBe(400);
		expect(unknownAgent.body.error.code).toBe("unknown_agent");
		expect((await api(pair.b).get<SharedInvite[]>("/shared/invites")).body).toEqual([]);
	});
});

describe("messages", () => {
	it("a duplicate message id is stored once and injected once, whatever key it arrives under; the first text wins", async () => {
		const { sessionId, shared } = await joined();
		const message = groupMessage(pair, { messageId: "shm_wire_dup", body: "wire-dup-text please keep going" });
		const first = await post(pair.b, pair.a, `/shared/${shared.id}/messages`, message, { key: "wire-msg-1" });
		expect(first.status).toBe(202);
		expect(first.body).toEqual({ messageId: "shm_wire_dup", accepted: true });
		await eventually(() => pair.a.ctx.shared.store.message("shm_wire_dup")?.injectedSessionId === sessionId, "the message injected into A's driving session");
		await whenSettled(pair.a, sessionId);
		const injections = () => promptsOf(pair.a).filter((p) => p.message.includes("wire-dup-text"));
		expect(injections()).toHaveLength(1);

		const sameKey = await post(pair.b, pair.a, `/shared/${shared.id}/messages`, message, { key: "wire-msg-1" });
		expect(sameKey.status).toBe(202);
		expect(sameKey.headers.get("idempotent-replay")).toBe("true");
		const otherKey = await post(pair.b, pair.a, `/shared/${shared.id}/messages`, { ...message, body: "a different text under the same id" }, { key: "wire-msg-2" });
		expect(otherKey.status).toBe(202);
		expect(otherKey.body).toEqual({ messageId: "shm_wire_dup", accepted: true });
		await whenSettled(pair.a, sessionId);

		expect(pair.a.ctx.shared.store.messages(shared.id).filter((m) => m.id === "shm_wire_dup")).toHaveLength(1);
		expect(pair.a.ctx.shared.store.message("shm_wire_dup")?.text).toBe(message.body);
		expect(injections()).toHaveLength(1);
		expect((await transcript(pair.a, sessionId)).filter((m) => m.role === "user" && textOf(m).includes("wire-dup-text"))).toHaveLength(1);
		expect(promptsOf(pair.a).some((p) => p.message.includes("a different text under the same id"))).toBe(false);
	});

	it("never fences chat by role or epoch: an agent instruction from a participant node is stored (the lead rule is checked where it is posted)", async () => {
		const { shared } = await joined();
		const res = await post(pair.b, pair.a, `/shared/${shared.id}/messages`, groupMessage(pair, { messageId: "shm_wire_instr", kind: "instruction", author: { kind: "agent", agentName: "Bee" }, epoch: 7 }));
		expect(res.status).toBe(202);
		expect(pair.a.ctx.shared.store.message("shm_wire_instr")).toMatchObject({ kind: "instruction", authorNodeId: pair.bId, epoch: 7 });
	});

	it("refuses malformed messages (400), someone else's origin (403) and reused ids or sequence numbers (409)", async () => {
		const { shared } = await joined();
		const path_ = `/shared/${shared.id}/messages`;
		const base = groupMessage(pair, { messageId: "shm_wire_x" });
		const bad: Array<[string, Record<string, unknown>]> = [
			["an empty body", { body: "" }],
			["a body over 20000 characters", { body: "x".repeat(20_001) }],
			["a bad kind", { kind: "shout" }],
			["a bad author kind", { author: { kind: "robot" } }],
			["a system message by a human", { kind: "system", author: { kind: "human" } }],
			["a human message by the system", { kind: "chat", author: { kind: "system" } }],
			["an epoch of 0", { epoch: 0 }],
			["a messageId with spaces", { messageId: "no good" }],
			["no hlc", { hlc: undefined }],
			["an hlc of the wrong shape", { hlc: "1793427266195-0" }],
			["no origin", { origin: undefined }],
			["an origin sequence of 0", { origin: { ...base.origin, seq: 0 } }],
			["no addressing", { to: undefined }],
			["an unknown addressing mode", { to: { mode: "everyone", agents: [] } }],
		];
		for (const [what, overrides] of bad) expect((await post(pair.b, pair.a, path_, { ...base, ...overrides })).status, what).toBe(400);
		expect((await post(pair.b, pair.a, path_, undefined, { bodyOverride: "[1,2" })).status).toBe(400);
		expect(pair.a.ctx.shared.store.message("shm_wire_x")).toBeUndefined();

		// a node pushes its own messages only (relaying is what messages/sync is for)
		const forged = await post(pair.b, pair.a, path_, { ...base, origin: { ...base.origin, nodeId: pair.aId, nodeName: "node-a" } });
		expect(forged.status).toBe(403);
		expect(forged.body.error.code).toBe("forbidden");
		expect(pair.a.ctx.shared.store.message("shm_wire_x")).toBeUndefined();

		// the first copy wins; the same id from another sequence, or another id on a used sequence, is a conflict
		expect((await post(pair.b, pair.a, path_, base)).status).toBe(202);
		const otherSeq = await post(pair.b, pair.a, path_, { ...base, origin: { ...base.origin, seq: base.origin.seq + 100 } });
		expect(otherSeq.status).toBe(409);
		expect(otherSeq.body.error.code).toBe("idempotency_conflict");
		const usedSeq = await post(pair.b, pair.a, path_, { ...base, messageId: "shm_wire_y" });
		expect(usedSeq.status).toBe(409);
		expect(usedSeq.body.error.code).toBe("idempotency_conflict");
		expect(pair.a.ctx.shared.store.message("shm_wire_y")).toBeUndefined();
		expect(pair.a.ctx.shared.store.messages(shared.id).filter((m) => m.authorKind !== "system" && m.id.startsWith("shm_wire_"))).toHaveLength(1);
	});
});

describe("checkpoint notices and acknowledgements", () => {
	it("a duplicate notice is one row (the held snapshot is not downloaded again) and the acknowledgement stays a single delivery", async () => {
		const { shared } = await joined();
		const row = pair.b.ctx.shared.store.checkpoint(shared.id, 1);
		expect(row?.snapshotPath).toBeTruthy();
		const notice = { seq: 1, epoch: 1, branch: row?.branch, commit: row?.commit, pushed: row?.pushed, snapshot: { sha256: row?.snapshotSha256, size: row?.snapshotSize, messageCount: row?.snapshotMessages ?? 0 }, note: row?.note, at: row?.createdAt };
		const stored = readdirSync(path.join(pair.b.dataDir, "shared", shared.id, "snapshots"));
		for (const key of ["wire-cp-1", "wire-cp-2"]) {
			const res = await post(pair.a, pair.b, `/shared/${shared.id}/checkpoints`, notice, { key });
			expect(res.status).toBe(202);
			expect(res.body).toEqual({ ok: true });
		}
		const replay = await post(pair.a, pair.b, `/shared/${shared.id}/checkpoints`, notice, { key: "wire-cp-1" });
		expect(replay.headers.get("idempotent-replay")).toBe("true");
		expect(pair.b.ctx.shared.store.checkpoints(shared.id).filter((c) => c.seq === 1)).toHaveLength(1);
		expect(readdirSync(path.join(pair.b.dataDir, "shared", shared.id, "snapshots"))).toEqual(stored);
		// the ack of seq 1 was queued once (a re-sent notice re-queues the same logical call) and A lists B once
		const acks = pair.b.ctx.shared.store.outboxOfRef("shared.snapshot_ack", `${shared.id}:1`);
		expect(acks).toHaveLength(1);
		expect(acks[0]?.state).toBe("sent");
		const onA = await sharedOn(pair.a, shared.id);
		expect(onA.lastCheckpoint?.deliveredTo.filter((id) => id === pair.bId)).toHaveLength(1);
	});

	it("an ack is idempotent, must name the real digest, and only the driver takes it", async () => {
		const { shared } = await joined();
		const row = pair.a.ctx.shared.store.checkpoint(shared.id, 1);
		const ack = { sha256: row?.snapshotSha256, size: row?.snapshotSize };
		for (const key of ["wire-ack-1", "wire-ack-2"]) expect((await post(pair.b, pair.a, `/shared/${shared.id}/checkpoints/1/ack`, ack, { key })).status).toBe(200);
		expect(pair.a.ctx.shared.store.checkpoint(shared.id, 1)?.deliveredTo).toEqual([pair.bId]);
		const wrongDigest = await post(pair.b, pair.a, `/shared/${shared.id}/checkpoints/1/ack`, { sha256: FAKE_SHA, size: 5 });
		expect(wrongDigest.status).toBe(404);
		expect((await post(pair.b, pair.a, `/shared/${shared.id}/checkpoints/77/ack`, ack)).status).toBe(404);
		// A is not a driver's receiver: B holds no checkpoints of its own to acknowledge
		const toParticipant = await post(pair.a, pair.b, `/shared/${shared.id}/checkpoints/1/ack`, ack);
		expect(toParticipant.status).toBe(404);
		expect(pair.a.ctx.shared.store.checkpoint(shared.id, 1)?.deliveredTo).toEqual([pair.bId]);
	});

	it("a notice for a checkpoint whose snapshot the driver does not hold is recorded, the download is given up on and the checkpoint shows no snapshot", async () => {
		const { shared } = await joined();
		const notice = { seq: 50, epoch: 1, branch: shared.repo.branch, commit: "a".repeat(40), pushed: true, snapshot: { sha256: "ab".repeat(32), size: 1234, messageCount: 3 }, note: "phantom", at: new Date().toISOString() };
		expect((await post(pair.a, pair.b, `/shared/${shared.id}/checkpoints`, notice)).status).toBe(202);
		const row = await eventually(() => {
			const current = pair.b.ctx.shared.store.checkpoint(shared.id, 50);
			return current && current.snapshotSha256 === null ? current : undefined;
		}, "the download of the phantom snapshot to be given up");
		expect(row.snapshotPath).toBeNull();
		expect(row.note).toContain("snapshot unavailable");
		// a notice without a snapshot at all is just a row
		const plain = { seq: 51, epoch: 1, branch: shared.repo.branch, pushed: false, snapshot: null, at: new Date().toISOString() };
		expect((await post(pair.a, pair.b, `/shared/${shared.id}/checkpoints`, plain)).status).toBe(202);
		expect(pair.b.ctx.shared.store.checkpoint(shared.id, 51)).toMatchObject({ pushed: false, snapshotSha256: null });
		// the snapshot of seq 1 is still the one a takeover would use
		expect(pair.b.ctx.shared.store.latestHeldCheckpoint(shared.id)?.seq).toBe(1);
	});

	it("validates notices and answers epoch_unknown to a notice from a future epoch (and asks the sender who drives)", async () => {
		const { shared } = await joined();
		const ok = { seq: 60, epoch: 1, branch: shared.repo.branch, pushed: true, snapshot: null, at: new Date().toISOString() };
		const bad: Array<[string, Record<string, unknown>]> = [
			["seq 0", { seq: 0 }],
			["a digest that is not hex", { snapshot: { sha256: "xyz", size: 5, messageCount: 1 } }],
			["a zero size", { snapshot: { sha256: FAKE_SHA, size: 0, messageCount: 1 } }],
			["no branch", { branch: "" }],
			["epoch 0", { epoch: 0 }],
		];
		for (const [what, overrides] of bad) expect((await post(pair.a, pair.b, `/shared/${shared.id}/checkpoints`, { ...ok, ...overrides })).status, what).toBe(400);
		const future = await post(pair.a, pair.b, `/shared/${shared.id}/checkpoints`, { ...ok, epoch: 5 });
		expect(future.status).toBe(409);
		expect(future.body.error).toMatchObject({ code: "epoch_unknown", details: { currentEpoch: 1 } });
		expect(pair.b.ctx.shared.store.checkpoint(shared.id, 60)).toBeUndefined();
		// the driver does not take notices or mirrors from anyone
		const toDriver = await post(pair.b, pair.a, `/shared/${shared.id}/checkpoints`, ok);
		expect(toDriver.status).toBe(409);
		expect(toDriver.body.error.message).toContain("drives");
		expect(pair.a.ctx.shared.store.checkpoint(shared.id, 60)).toBeUndefined();
	});
});

describe("mirror frames", () => {
	function message(id: string, text: string) {
		return { id, role: "assistant", timestamp: 1, content: [{ type: "text", text }] };
	}

	it("applies each batch once and in order, answers duplicates with applied:false, gaps and unknown streams with mirror_resync, and a re-sync repairs it", async () => {
		const { sessionId, shared, onB } = await joined();
		await whenSettled(pair.a, sessionId);
		const mirrorId = onB.mirrorSessionId as string;
		const path_ = `/shared/${shared.id}/mirror`;
		const texts = () => transcriptTexts(pair.b, mirrorId);

		// take over the stream with a sync of our own (A is idle, so its real publisher sends nothing meanwhile)
		const sync = await post(pair.a, pair.b, path_, { type: "sync", epoch: 1, streamId: "str_wire", seq: 5, index: 0, final: true, messages: [message("w1", "wire one")] });
		expect(sync.status).toBe(200);
		expect(sync.body).toEqual({ applied: true, lastSeq: 5 });
		expect(await texts()).toEqual(["wire one"]);

		const first = await post(pair.a, pair.b, path_, { type: "events", epoch: 1, streamId: "str_wire", seq: 6, events: [{ type: "message_end", message: message("w2", "wire two") }] });
		expect(first.body).toEqual({ applied: true, lastSeq: 6 });
		expect(await texts()).toEqual(["wire one", "wire two"]);

		// a duplicate of the batch just applied: acknowledged, not applied twice
		const duplicate = await post(pair.a, pair.b, path_, { type: "events", epoch: 1, streamId: "str_wire", seq: 6, events: [{ type: "message_end", message: message("w2", "wire two AGAIN") }] });
		expect(duplicate.status).toBe(200);
		expect(duplicate.body).toEqual({ applied: false, lastSeq: 6 });
		// an old one as well
		expect((await post(pair.a, pair.b, path_, { type: "events", epoch: 1, streamId: "str_wire", seq: 2, events: [{ type: "notice" }] })).body).toEqual({ applied: false, lastSeq: 6 });
		expect(await texts()).toEqual(["wire one", "wire two"]);

		// a gap: seq 8 while the mirror is at 6
		const gap = await post(pair.a, pair.b, path_, { type: "events", epoch: 1, streamId: "str_wire", seq: 8, events: [{ type: "message_end", message: message("w4", "never applied") }] });
		expect(gap.status).toBe(409);
		expect(gap.body.error).toMatchObject({ code: "mirror_resync", details: { lastSeq: 6 } });
		// a stream the mirror does not know
		const unknown = await post(pair.a, pair.b, path_, { type: "events", epoch: 1, streamId: "str_other", seq: 7, events: [{ type: "notice" }] });
		expect(unknown.status).toBe(409);
		expect(unknown.body.error).toMatchObject({ code: "mirror_resync", details: { lastSeq: 6 } });
		expect(await texts()).toEqual(["wire one", "wire two"]);

		// the next batch in order still applies (a refused frame changed nothing)
		const next = await post(pair.a, pair.b, path_, { type: "events", epoch: 1, streamId: "str_wire", seq: 7, events: [{ type: "message_start", message: message("w3", "") }, { type: "message_delta", messageId: "w3", contentIndex: 0, kind: "text", delta: "wire three" }, { type: "message_end", message: message("w3", "wire three") }] });
		expect(next.body).toEqual({ applied: true, lastSeq: 7 });
		expect(await texts()).toEqual(["wire one", "wire two", "wire three"]);

		// the driver replays its real conversation: the mirror equals A again
		pair.a.ctx.shared.mirror.syncPeer(shared.id, pair.bId);
		const expected = await transcriptTexts(pair.a, sessionId);
		await eventually(async () => JSON.stringify(await texts()) === JSON.stringify(expected), "B's mirror to equal A's transcript again");
	});

	it("sync chunks must arrive as 0,1,2...: index 0 resets, a chunk with the wrong index (or of another stream) is refused with mirror_resync", async () => {
		const { sessionId, shared, onB } = await joined();
		await whenSettled(pair.a, sessionId);
		const path_ = `/shared/${shared.id}/mirror`;
		const chunk = (over: Record<string, unknown>) => post(pair.a, pair.b, path_, { type: "sync", epoch: 1, streamId: "str_chunks", seq: 3, index: 0, final: false, messages: [message("c0", "chunk zero")], ...over });
		const mirrorId = onB.mirrorSessionId as string;

		// no chunk 0 yet for this stream
		const orphan = await chunk({ index: 1 });
		expect(orphan.status).toBe(409);
		expect(orphan.body.error.code).toBe("mirror_resync");
		expect((await chunk({ index: 0 })).body).toEqual({ applied: true, lastSeq: 0 });
		expect(await transcriptTexts(pair.b, mirrorId)).toEqual(["chunk zero"]);
		// skipping chunk 1
		const skipped = await chunk({ index: 2, messages: [message("c2", "chunk two")] });
		expect(skipped.status).toBe(409);
		expect(skipped.body.error.code).toBe("mirror_resync");
		// the right chunk of another stream
		expect((await chunk({ index: 1, streamId: "str_foreign" })).status).toBe(409);
		// the right one
		expect((await chunk({ index: 1, messages: [message("c1", "chunk one")] })).body).toEqual({ applied: true, lastSeq: 0 });
		// repeating chunk 1 is out of order now (the next one is 2)
		expect((await chunk({ index: 1, messages: [message("c1", "chunk one")] })).status).toBe(409);
		const last = await chunk({ index: 2, final: true, messages: [message("c2", "chunk two")] });
		expect(last.body).toEqual({ applied: true, lastSeq: 3 });
		expect(await transcriptTexts(pair.b, mirrorId)).toEqual(["chunk zero", "chunk one", "chunk two"]);
		// events now follow from seq 4
		expect((await post(pair.a, pair.b, path_, { type: "events", epoch: 1, streamId: "str_chunks", seq: 4, events: [{ type: "settled" }] })).body).toEqual({ applied: true, lastSeq: 4 });

		pair.a.ctx.shared.mirror.syncPeer(shared.id, pair.bId);
		const expected = await transcriptTexts(pair.a, sessionId);
		await eventually(async () => JSON.stringify(await transcriptTexts(pair.b, mirrorId)) === JSON.stringify(expected), "the real conversation back in the mirror");
	});

	it("rejects malformed frames (400) and a future epoch (409 epoch_unknown), and a driver does not take a mirror", async () => {
		const { shared } = await joined();
		const path_ = `/shared/${shared.id}/mirror`;
		const good = { type: "events", epoch: 1, streamId: "str_v", seq: 1, events: [{ type: "notice" }] };
		const bad: Array<[string, unknown]> = [
			["no type", { ...good, type: undefined }],
			["an unknown type", { ...good, type: "teleport" }],
			["an empty batch", { ...good, events: [] }],
			["an unknown event type", { ...good, events: [{ type: "approval_request" }] }],
			["seq 0 in events", { ...good, seq: 0 }],
			["a stream id with spaces", { ...good, streamId: "str bad" }],
			["epoch 0", { ...good, epoch: 0 }],
			["a negative sync index", { type: "sync", epoch: 1, streamId: "str_v", seq: 0, index: -1, final: true, messages: [] }],
			["a sync without final", { type: "sync", epoch: 1, streamId: "str_v", seq: 0, index: 0, messages: [] }],
		];
		for (const [what, body] of bad) expect((await post(pair.a, pair.b, path_, body)).status, what).toBe(400);
		expect((await post(pair.a, pair.b, path_, undefined, { bodyOverride: "not json" })).status).toBe(400);
		const future = await post(pair.a, pair.b, path_, { ...good, epoch: 4 });
		expect(future.status).toBe(409);
		expect(future.body.error.code).toBe("epoch_unknown");
		const toDriver = await post(pair.b, pair.a, path_, good);
		expect(toDriver.status).toBe(409);
		expect(toDriver.body.error.message).toContain("drives");
	});
});

describe("who may call what", () => {
	it("a driver call from a peer that is not the driver is forbidden (403)", async () => {
		const { shared } = await joined();
		// A drives. B is a participant and must not hand the session over, remove anybody or speak for another node.
		const transfer = await post(pair.b, pair.a, `/shared/${shared.id}/transfer`, { epoch: 1, checkpointSeq: 1, sha256: FAKE_SHA });
		expect(transfer.status).toBe(403);
		expect(transfer.body.error.code).toBe("forbidden");
		const remove = await post(pair.b, pair.a, `/shared/${shared.id}/membership`, { epoch: 1, action: "remove", nodeId: pair.aId });
		expect(remove.status).toBe(403);
		expect(remove.body.error.code).toBe("forbidden");
		const impersonate = await post(pair.b, pair.a, `/shared/${shared.id}/membership`, { epoch: 1, action: "leave", nodeId: pair.aId });
		expect(impersonate.status).toBe(403);
		expect((await sharedOn(pair.a, shared.id)).participants.find((p) => p.nodeId === pair.aId)?.state).toBe("active");
		// the other direction: A (the driver) cannot be told to hand over by B, and B (not driving) refuses A's transfer when A is not its driver
		// A third node is simulated on B's store: it drives from B's point of view, A is "just" a participant there.
		const store = pair.b.ctx.shared.store;
		store.upsertParticipant({ sharedSessionId: shared.id, nodeId: "node_c", nodeName: "node-c", agentId: null, agentName: null, role: "driver", state: "active", agentSessionId: null, uiUrl: null, snapshotSeq: 0, joinedAt: new Date().toISOString() });
		store.update(shared.id, { driverNodeId: "node_c", driverNodeName: "node-c" });
		const mirror = await post(pair.a, pair.b, `/shared/${shared.id}/mirror`, { type: "events", epoch: 1, streamId: "str_x", seq: 1, events: [{ type: "notice" }] });
		expect(mirror.status).toBe(403);
		expect(mirror.body.error).toMatchObject({ code: "forbidden", message: expect.stringContaining("driver") });
		const notice = await post(pair.a, pair.b, `/shared/${shared.id}/checkpoints`, { seq: 70, epoch: 1, branch: shared.repo.branch, pushed: true, snapshot: null, at: new Date().toISOString() });
		expect(notice.status).toBe(403);
		expect(store.checkpoint(shared.id, 70)).toBeUndefined();
		const transferToB = await post(pair.a, pair.b, `/shared/${shared.id}/transfer`, { epoch: 1, checkpointSeq: 1, sha256: FAKE_SHA });
		expect(transferToB.status).toBe(403);
		const removeOnB = await post(pair.a, pair.b, `/shared/${shared.id}/membership`, { epoch: 1, action: "remove", nodeId: pair.bId });
		expect(removeOnB.status).toBe(403);
		expect((await sharedOn(pair.b, shared.id)).localRole).toBe("participant");
	});

	it("unknown shared sessions and nodes that are not part of one see 404 on every endpoint", async () => {
		pair = await startSharedPair();
		// B was only invited: A knows B as `invited`, B holds no shared session at all
		const created = await api(pair.a).post<AgentSession>("/sessions", { projectId: pair.projectA.id, title: "Pending" });
		const added = await api(pair.a).post<SharedSession>(`/sessions/${created.body.id}/participants`, { nodeId: pair.bId });
		expect(added.status).toBe(201);
		const id = added.body.id;
		await eventually(async () => (await api(pair.b).get<SharedInvite[]>("/shared/invites")).body.find((i) => i.sharedSessionId === id), "the invitation on B");
		expect(await api(pair.b).get(`/shared/${id}`)).toMatchObject({ status: 404 });

		const probes: Array<[string, string, unknown]> = [
			["POST", "mirror", { type: "events", epoch: 1, streamId: "str_p", seq: 1, events: [{ type: "notice" }] }],
			["POST", "checkpoints", { seq: 1, epoch: 1, branch: "b", pushed: true, at: new Date().toISOString() }],
			["POST", "messages", groupMessage(pair, { messageId: "shm_p" })],
			["POST", "messages/sync", { cursor: {} }],
			["POST", "driver", { epoch: 2, reason: "takeover", at: new Date().toISOString() }],
			["POST", "membership", { epoch: 1, action: "leave", nodeId: pair.aId }],
			["POST", "transfer", { epoch: 1, checkpointSeq: 1, sha256: FAKE_SHA }],
			["POST", "decision", { inviteId: "shi_p", decision: "decline" }],
			["POST", "checkpoints/1/ack", { sha256: FAKE_SHA, size: 5 }],
			["GET", "", undefined],
			["GET", "snapshots/1", undefined],
		];
		for (const target of [{ label: "a node that never joined", to: pair.b, id }, { label: "an unknown shared id", to: pair.a, id: "shs_does_not_exist" }]) {
			for (const [method, suffix, body] of probes) {
				const res = await signedRequest(target.to === pair.b ? pair.a : pair.b, target.to.netUrl, { method, path: `/shared/${target.id}${suffix ? `/${suffix}` : ""}`, body });
				expect(res.status, `${method} ${suffix || "(state)"} on ${target.label}`).toBe(404);
			}
		}
		// B is only invited on A: it may not read snapshots, post to the thread or take part in membership
		expect((await signedRequest(pair.b, pair.a.netUrl, { path: `/shared/${id}/snapshots/1` })).status).toBe(404);
		const thread = await post(pair.b, pair.a, `/shared/${id}/messages`, groupMessage(pair, { messageId: "shm_inv" }));
		expect(thread.status).toBe(403);
		expect((await post(pair.b, pair.a, `/shared/${id}/messages/sync`, { cursor: {} })).status).toBe(403);
		expect((await detailOn(pair.a, id)).messages.some((m) => m.id === "shm_inv")).toBe(false);
		// ids that are not even valid identifiers
		const message = groupMessage(pair, { messageId: "shm_bogus" });
		for (const bogus of ["bad%20id", "a%2Fb", "semi;colon", "x".repeat(100)]) {
			expect((await signedRequest(pair.b, pair.a.netUrl, { path: `/shared/${bogus}` })).status, bogus).toBe(404);
			expect((await post(pair.b, pair.a, `/shared/${bogus}/messages`, message)).status, bogus).toBe(404);
		}
	});

	it("a participant that left is no longer served: messages 403, snapshots 404; state still names who drives", async () => {
		const { shared } = await joined();
		expect((await api(pair.b).post(`/shared/${shared.id}/leave`)).status).toBe(200);
		await waitForShared(pair.a, shared.id, (s) => s.participants.find((p) => p.nodeId === pair.bId)?.state === "left", "A sees B left");
		const message = await post(pair.b, pair.a, `/shared/${shared.id}/messages`, groupMessage(pair, { messageId: "shm_left", body: "still here?" }));
		expect(message.status).toBe(403);
		expect((await signedRequest(pair.b, pair.a.netUrl, { path: `/shared/${shared.id}/snapshots/1` })).status).toBe(404);
		expect(pair.a.ctx.shared.store.message("shm_left")).toBeUndefined();
		const toLeft = await post(pair.a, pair.b, `/shared/${shared.id}/mirror`, { type: "events", epoch: 1, streamId: "str_l", seq: 1, events: [{ type: "notice" }] });
		expect(toLeft.status).toBe(404);
	});

	it("a peer without the capability sessions.share is refused (403 forbidden naming it) on every endpoint, in both directions", async () => {
		const { shared } = await joined();
		const probes: Array<[string, string, unknown]> = [
			["POST", "/shared/invites", inviteBody(pair)],
			["POST", `/shared/${shared.id}/decision`, { inviteId: "shi_c", decision: "decline" }],
			["POST", `/shared/${shared.id}/messages`, groupMessage(pair, { messageId: "shm_cap" })],
			["POST", `/shared/${shared.id}/messages/sync`, { cursor: {} }],
			["POST", `/shared/${shared.id}/mirror`, { type: "events", epoch: 1, streamId: "str_c", seq: 1, events: [{ type: "notice" }] }],
			["POST", `/shared/${shared.id}/checkpoints`, { seq: 1, epoch: 1, branch: "b", pushed: true, at: new Date().toISOString() }],
			["POST", `/shared/${shared.id}/checkpoints/1/ack`, { sha256: FAKE_SHA, size: 5 }],
			["POST", `/shared/${shared.id}/driver`, { epoch: 2, reason: "takeover", at: new Date().toISOString() }],
			["POST", `/shared/${shared.id}/membership`, { epoch: 1, action: "leave", nodeId: pair.bId }],
			["POST", `/shared/${shared.id}/transfer`, { epoch: 1, checkpointSeq: 1, sha256: FAKE_SHA }],
			["GET", `/shared/${shared.id}`, undefined],
			["GET", `/shared/${shared.id}/snapshots/1`, undefined],
		];
		const capabilities = async (node: FullHarness, peerId: string) => (await peerOf(node, peerId))?.grantedCapabilities ?? [];
		const withoutShare = (list: string[]) => list.filter((c) => c !== "sessions.share");
		const expectRefused = async (from: FullHarness, to: FullHarness) => {
			for (const [method, pathName, body] of probes) {
				const res = await signedRequest(from, to.netUrl, { method, path: pathName, body });
				expect(res.status, `${method} ${pathName}`).toBe(403);
				expect(res.body.error, `${method} ${pathName}`).toMatchObject({ code: "forbidden", message: expect.stringContaining("sessions.share"), details: { missing: ["sessions.share"] } });
			}
		};
		// A stops granting B: B's calls to A are refused, A's calls to B (B's grant is untouched) still work
		const grantedByA = await capabilities(pair.a, pair.bId);
		await setCapabilities(pair.a, pair.bId, withoutShare(grantedByA));
		await expectRefused(pair.b, pair.a);
		expect((await signedRequest(pair.a, pair.b.netUrl, { path: `/shared/${shared.id}` })).status).toBe(200);
		// the snapshot download of B is refused with the same answer, and the downloader reports that as final
		await expect(downloadSnapshot(pair.b.ctx, { url: pair.a.netUrl }, { sharedId: shared.id, seq: 1, expected: { sha256: pair.a.ctx.shared.store.checkpoint(shared.id, 1)?.snapshotSha256 as string, size: pair.a.ctx.shared.store.checkpoint(shared.id, 1)?.snapshotSize as number } }, path.join(pair.b.dataDir, "refused.tmp"), { maxBytes: 1e9, idleMs: 5000 })).rejects.toThrow(/refused the download/);
		await setCapabilities(pair.a, pair.bId, grantedByA);
		expect((await signedRequest(pair.b, pair.a.netUrl, { path: `/shared/${shared.id}` })).status).toBe(200);
		// and the other way round
		const grantedByB = await capabilities(pair.b, pair.aId);
		await setCapabilities(pair.b, pair.aId, withoutShare(grantedByB));
		await expectRefused(pair.a, pair.b);
		await setCapabilities(pair.b, pair.aId, grantedByB);
	});

	it("the state endpoint tells a participant who drives, at which epoch, with whom and from which checkpoint", async () => {
		const { shared } = await joined();
		const res = await signedRequest(pair.b, pair.a.netUrl, { path: `/shared/${shared.id}` });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			sharedSessionId: shared.id,
			epoch: 1,
			driverNodeId: pair.aId,
			branch: shared.repo.branch,
			participants: expect.arrayContaining([expect.objectContaining({ nodeId: pair.aId, role: "driver", state: "active" }), expect.objectContaining({ nodeId: pair.bId, role: "participant", state: "active" })]),
			lastCheckpoint: expect.objectContaining({ seq: 1, epoch: 1, pushed: true }),
		});
	});
});

describe("snapshot download", () => {
	async function heldSnapshot() {
		const result = await joined();
		const row = pair.a.ctx.shared.store.checkpoint(result.shared.id, 1);
		return { ...result, sha256: row?.snapshotSha256 as string, size: row?.snapshotSize as number, file: path.join(pair.a.dataDir, "shared", result.shared.id, "snapshots", "1.tar") };
	}

	it("serves a participant the stored file with its digest and length, and 404 for an unknown seq", async () => {
		const { shared, sha256, size, file } = await heldSnapshot();
		const res = await signedRequest(pair.b, pair.a.netUrl, { path: `/shared/${shared.id}/snapshots/1` });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(res.headers.get("content-digest")).toBe(digestHeader(sha256));
		expect(Number(res.headers.get("content-length"))).toBe(size);
		expect(Buffer.byteLength(res.text)).toBe(size);
		expect(res.text).toBe(readFileSync(file, "utf8"));
		expect(res.headers.get("content-disposition")).toContain("attachment");
		for (const seq of ["999", "2"]) {
			if (seq === "2" && pair.a.ctx.shared.store.checkpoint(shared.id, 2)) continue;
			expect((await signedRequest(pair.b, pair.a.netUrl, { path: `/shared/${shared.id}/snapshots/${seq}` })).status, seq).toBe(404);
		}
		for (const seq of ["0", "-1", "abc", "1.5", "1234567890"]) {
			expect((await signedRequest(pair.b, pair.a.netUrl, { path: `/shared/${shared.id}/snapshots/${seq}` })).status, seq).toBe(400);
		}
		// the same for the ack route
		expect((await post(pair.b, pair.a, `/shared/${shared.id}/checkpoints/abc/ack`, { sha256, size })).status).toBe(400);
		expect((await post(pair.b, pair.a, `/shared/${shared.id}/checkpoints/0/ack`, { sha256, size })).status).toBe(400);
		expect((await post(pair.b, pair.a, `/shared/${shared.id}/checkpoints/1/ack`, { sha256: "nothex", size })).status).toBe(400);
		expect((await post(pair.b, pair.a, `/shared/${shared.id}/checkpoints/1/ack`, { sha256, size: 0 })).status).toBe(400);
	});

	it("verifies while downloading: a tampered file, a wrong announced digest or size and a cap below the size are all refused and leave no file", async () => {
		const { shared, sha256, size, file } = await heldSnapshot();
		const target = path.join(pair.b.dataDir, "download.tmp");
		const download = (expected: { sha256: string; size: number }, maxBytes = 1e9) => downloadSnapshot(pair.b.ctx, { url: pair.a.netUrl }, { sharedId: shared.id, seq: 1, expected }, target, { maxBytes, idleMs: 5000 });

		await download({ sha256, size });
		expect(readFileSync(target, "utf8")).toBe(readFileSync(file, "utf8"));
		unlinkSync(target);

		await expect(download({ sha256: FAKE_SHA, size })).rejects.toBeInstanceOf(SnapshotRejectedError);
		await expect(download({ sha256: FAKE_SHA, size })).rejects.toThrow(/does not match the digest/);
		expect(existsSync(target)).toBe(false);
		await expect(download({ sha256, size: size + 1 })).rejects.toThrow(/announces .* bytes, expected/);
		expect(existsSync(target)).toBe(false);
		await expect(download({ sha256, size }, size - 1)).rejects.toThrow(/larger than this node accepts/);
		expect(existsSync(target)).toBe(false);

		// tamper with the stored file on the driver (same length, one byte flipped)
		const original = readFileSync(file);
		const tampered = Buffer.from(original);
		tampered[Math.floor(tampered.length / 2)] = (tampered[Math.floor(tampered.length / 2)] as number) ^ 0xff;
		writeFileSync(file, tampered);
		await expect(download({ sha256, size })).rejects.toBeInstanceOf(SnapshotRejectedError);
		expect(existsSync(target)).toBe(false);
		writeFileSync(file, original);
		await download({ sha256, size });
		expect(readFileSync(target)).toEqual(original);
	});

	it("a node whose size cap is below the snapshot never stores it: the checkpoint shows no snapshot, the driver never lists it as delivered", async () => {
		pair = await startSharedPair({ nodeB: { sharedTimings: { maxSnapshotBytes: 100 } } });
		const { shared } = await pair.shareAndJoin({ firstPrompt: "start" });
		const row = await eventually(() => {
			const current = pair.b.ctx.shared.store.checkpoint(shared.id, 1);
			return current && current.snapshotSha256 === null ? current : undefined;
		}, "B to give up on the oversized snapshot");
		expect(row.snapshotPath).toBeNull();
		expect(row.note).toContain("snapshot unavailable");
		expect(row.note).toContain("larger than this node accepts");
		const onB = await sharedOn(pair.b, shared.id);
		expect(onB.lastCheckpoint).toMatchObject({ seq: 1, snapshot: null, deliveredTo: [] });
		expect(onB.takeoverAvailable).toBe(false);
		expect(onB.takeoverBlockedReason).toContain("No session snapshot");
		expect(existsSync(path.join(pair.b.dataDir, "shared", shared.id, "snapshots", "1.tar"))).toBe(false);
		const leftovers = existsSync(path.join(pair.b.dataDir, "shared", shared.id, "snapshots")) ? readdirSync(path.join(pair.b.dataDir, "shared", shared.id, "snapshots")) : [];
		expect(leftovers).toEqual([]);
		const onA = await sharedOn(pair.a, shared.id);
		expect(onA.lastCheckpoint?.snapshot).not.toBeNull();
		expect(onA.lastCheckpoint?.deliveredTo).not.toContain(pair.bId);
		// takeover is refused for want of a snapshot (never from a half-downloaded one)
		await pair.stop("a");
		const took = await api(pair.b).post<{ error: { code: string } }>(`/shared/${shared.id}/takeover`, { force: true });
		expect(took.status).toBe(409);
		expect(took.body.error.code).toBe("no_snapshot");
	});

	it("is not secret-scanned (a conversation containing token-looking strings is delivered whole) and never enters git", async () => {
		const { sessionId, shared } = await joined();
		const token = `ghp_${"A1b2C3d4E5".repeat(4)}`;
		const aws = "AKIAIOSFODNN7EXAMPLE";
		await promptAndWait(pair.a, sessionId, `remember my token ${token} and key ${aws}`);
		await promptAndWait(pair.a, sessionId, "@@fake-sh echo 'plain notes' > NOTES.md");
		const manual = await api(pair.a).post<{ seq: number; snapshot: { sha256: string } | null }>(`/shared/${shared.id}/checkpoint`, { note: "after the chatter" });
		expect(manual.status).toBe(200);
		expect(manual.body.snapshot).not.toBeNull();
		const seq = manual.body.seq;
		await waitForShared(pair.a, shared.id, (s) => s.lastCheckpoint?.seq === seq && s.lastCheckpoint.deliveredTo.includes(pair.bId), "B holds the checkpoint with the token in it");
		const onB = await eventually(() => {
			const current = pair.b.ctx.shared.store.checkpoint(shared.id, seq);
			return current?.snapshotPath ? current : undefined;
		}, "B stored the snapshot");
		expect(onB.note).not.toMatch(/secret|redact/i);
		for (const node of [pair.a, pair.b]) {
			const stored = readFileSync(path.join(node.dataDir, "shared", shared.id, "snapshots", `${seq}.tar`), "utf8");
			expect(stored).toContain(token);
			expect(stored).toContain(aws);
		}
		// the shared branch holds the work, never a snapshot: no .tar, nothing from the session store
		const branch = shared.repo.branch;
		const files = git(pair.origin, "ls-tree", "-r", "--name-only", branch).split("\n").filter(Boolean);
		expect(files).toContain("NOTES.md");
		expect(files.filter((f) => /\.tar$|snapshots?\//.test(f))).toEqual([]);
		const everything = git(pair.origin, "log", "--all", "--name-only", "--format=").split("\n").filter(Boolean);
		expect(everything.filter((f) => /\.tar$/.test(f))).toEqual([]);
		expect(() => git(pair.origin, "grep", "-q", token, branch)).toThrow();
		expect(git(pair.workA, "ls-files").split("\n").filter((f) => f.endsWith(".tar"))).toEqual([]);
		expect(git(pair.workA, "status", "--porcelain").trim()).toBe("");
		// the transcript text itself is untouched on both sides
		expect((await transcript(pair.a, sessionId)).some((m) => textOf(m).includes(token))).toBe(true);
	});
});
