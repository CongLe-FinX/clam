import { afterAll, describe, expect, it } from "vitest";
import {
	generatePairingNonce,
	pairingProof,
	deriveCodeKey,
	invitationIdFromCode,
	publicKeyToBase64,
	publicKeyToWire,
	signTranscript,
	transcriptHash,
	wire,
} from "../src/index.ts";
import { cleanupIdentities, makeNode } from "./helpers.ts";

afterAll(cleanupIdentities);

const a = makeNode();
const b = makeNode();

function info(node = a, over: Record<string, unknown> = {}) {
	return {
		protocolVersions: [1],
		nodeId: node.identity.nodeId,
		name: "Node A",
		publicKey: publicKeyToWire(node.identity.publicKey),
		fingerprint: node.identity.fingerprint,
		appVersion: "0.3.0",
		platform: "darwin",
		arch: "arm64",
		publicUrl: "https://a.example.com",
		capabilities: ["agents.read", "tasks.send"],
		runtimes: ["omp"],
		startedAt: "2026-10-31T05:52:42.212Z",
		...over,
	};
}

describe("no-git payloads (files mode, task inputs)", () => {
	const sha = "a".repeat(64);
	it("a task without projectRef parses, with optional input files and deliverAs files", () => {
		const create = { taskId: "tsk_01J", workspaceId: "w1", title: "T", description: "d", epoch: 0, correlationId: "corr_1", deliverAs: "files", inputFiles: { artifactId: "art_1", sha256: sha, size: 10, fileCount: 2 } };
		const parsed = wire.CreateTaskRequest.parse(create);
		expect(parsed.projectRef ?? null).toBeNull();
		expect(parsed.inputFiles).toMatchObject({ fileCount: 2 });
		expect(wire.CreateTaskRequest.safeParse({ ...create, inputFiles: { ...create.inputFiles, sha256: "short" } }).success).toBe(false);
	});

	it("a files-mode invite carries vcs and no repo; the default stays git", () => {
		const base = { inviteId: "shi_01J", sharedSessionId: "shs_01J", workspaceId: "w1", title: "T", epoch: 1 };
		expect(wire.SharedInviteRequest.parse({ ...base, vcs: "files" })).toMatchObject({ vcs: "files" });
		const git = wire.SharedInviteRequest.parse({ ...base, repo: { url: "https://github.com/o/r", branch: "clam/shared/x" } });
		expect(git.vcs).toBe("git");
		expect(wire.SharedInviteRequest.safeParse({ ...base, vcs: "svn" }).success).toBe(false);
	});

	it("checkpoint notices and acks describe the folder bundle", () => {
		const notice = wire.SharedCheckpointNotice.parse({ seq: 1, epoch: 1, pushed: false, files: { sha256: sha, size: 5, fileCount: 1 }, at: "2030-01-01T00:00:00.000Z" });
		expect(notice.branch ?? null).toBeNull();
		expect(notice.files).toMatchObject({ fileCount: 1 });
		expect(wire.SharedCheckpointAck.parse({ files: { sha256: sha, size: 5 } }).sha256).toBeUndefined();
		expect(wire.SharedCheckpointAck.parse({ sha256: sha, size: 5 })).toMatchObject({ size: 5 });
		expect(wire.SharedCheckpointAck.safeParse({ files: { sha256: "x", size: 5 } }).success).toBe(false);
	});
});

describe("wire.NodeInfo", () => {
	it("accepts a well-formed document with either key encoding and a null publicUrl, ignoring unknown fields", () => {
		expect(wire.NodeInfo.safeParse(info()).success).toBe(true);
		expect(wire.NodeInfo.safeParse(info(a, { publicKey: publicKeyToBase64(a.identity.publicKey), publicUrl: null, future: "field" })).success).toBe(true);
		expect(wire.NodeInfo.parse(info(a, { future: 1 }))).not.toHaveProperty("future");
	});

	it("rejects a fingerprint or node id that does not derive from the public key", () => {
		expect(wire.NodeInfo.safeParse(info(a, { fingerprint: b.identity.fingerprint })).success).toBe(false);
		expect(wire.NodeInfo.safeParse(info(a, { nodeId: b.identity.nodeId })).success).toBe(false);
		expect(wire.NodeInfo.safeParse(info(a, { publicKey: publicKeyToWire(b.identity.publicKey) })).success).toBe(false);
	});

	it("rejects malformed keys, fingerprints and version lists", () => {
		expect(wire.NodeInfo.safeParse(info(a, { publicKey: "AAAA" })).success).toBe(false);
		expect(wire.NodeInfo.safeParse(info(a, { fingerprint: a.identity.fingerprint.toUpperCase() })).success).toBe(false);
		expect(wire.NodeInfo.safeParse(info(a, { protocolVersions: [] })).success).toBe(false);
		expect(wire.NodeInfo.safeParse(info(a, { protocolVersions: [0] })).success).toBe(false);
		expect(wire.NodeInfo.safeParse({ ...info(), name: undefined }).success).toBe(false);
	});
});

describe("wire.NodeHealth", () => {
	const full = { status: "ok", uptimeMs: 1000, time: 1_760_000_000_000, activeRuntimes: 1, maxConcurrentRuntimes: 4, runningTasks: 0, queuedTasks: 0, checks: [{ name: "db", status: "ok" }, { name: "tunnel", status: "degraded", message: "reconnecting" }] };

	it("distinguishes the public minimal answer from the authenticated one", () => {
		expect(wire.NodeHealthMinimal.safeParse({ status: "degraded", time: 5 }).success).toBe(true);
		expect(wire.NodeHealthFull.safeParse(full).success).toBe(true);
		expect(wire.NodeHealthFull.safeParse({ status: "ok", time: 5 }).success).toBe(false);
		expect(wire.NodeHealth.parse(full)).toHaveProperty("checks");
		expect(wire.NodeHealth.parse({ status: "ok", time: 5 })).toEqual({ status: "ok", time: 5 });
	});

	it("rejects unknown statuses and negative numbers", () => {
		expect(wire.NodeHealthMinimal.safeParse({ status: "fine", time: 5 }).success).toBe(false);
		expect(wire.NodeHealthFull.safeParse({ ...full, runningTasks: -1 }).success).toBe(false);
		expect(wire.NodeHealthFull.safeParse({ ...full, checks: [{ name: "x", status: "weird" }] }).success).toBe(false);
	});
});

describe("wire pairing payloads", () => {
	const code = "ABCD-EF12";
	const invitationId = invitationIdFromCode(code);
	const node = (n = a) => ({ nodeId: n.identity.nodeId, name: "N", publicKey: publicKeyToWire(n.identity.publicKey), publicUrl: "https://n.example.com" });
	const nonce = generatePairingNonce();
	const proof = pairingProof(deriveCodeKey(code, invitationId), "hello", ["x"]);
	const signature = signTranscript(a.signer, transcriptHash({ inviterId: "i", inviterPub: a.identity.publicKey, joinerId: "j", joinerPub: b.identity.publicKey, nonceInviter: nonce, nonceJoiner: nonce, invitationId, capabilities: [] }));

	it("hello request and reply", () => {
		const hello = { step: "hello", invitationId, node: node(b), nonce, proof };
		expect(wire.PairHelloRequest.safeParse(hello).success).toBe(true);
		expect(wire.PairRequest.parse(hello)).toMatchObject({ step: "hello" });
		const reply = { step: "hello", node: node(a), nonce, proof, status: "pending_user_approval", workspaceId: "ws_1", workspaceName: "Project", expiresAt: "2026-10-31T06:00:00.000Z" };
		expect(wire.PairHelloResponse.safeParse(reply).success).toBe(true);
		expect(wire.PairHelloResponse.safeParse({ ...reply, status: "paired" }).success).toBe(false);
	});

	it("refuses node objects whose id does not derive from the key, and bad proofs/nonces", () => {
		expect(wire.PairNode.safeParse({ ...node(a), nodeId: b.identity.nodeId }).success).toBe(false);
		expect(wire.PairHelloRequest.safeParse({ step: "hello", invitationId, node: node(b), nonce: "x", proof }).success).toBe(false);
		expect(wire.PairHelloRequest.safeParse({ step: "hello", invitationId, node: node(b), nonce, proof: "short" }).success).toBe(false);
		expect(wire.PairHelloRequest.safeParse({ step: "hello", invitationId, node: node(b), nonce }).success).toBe(false);
	});

	it("confirm request (inviter → joiner) defaults to approved and supports rejection", () => {
		const confirm = { step: "confirm", invitationId, signature, capabilities: ["agents.read"], node: node(a) };
		expect(wire.PairConfirmRequest.parse(confirm)).toMatchObject({ status: "approved", capabilities: ["agents.read"] });
		expect(wire.PairConfirmRequest.parse({ ...confirm, status: "rejected", capabilities: [], reason: "no" })).toMatchObject({ status: "rejected", reason: "no" });
		expect(wire.PairConfirmRequest.safeParse({ ...confirm, status: "maybe" }).success).toBe(false);
		expect(wire.PairConfirmRequest.safeParse({ ...confirm, signature: "x" }).success).toBe(false);
		expect(wire.PairRequest.parse(confirm)).toMatchObject({ step: "confirm" });
		expect(wire.PairRequest.safeParse({ step: "other" }).success).toBe(false);
	});

	it("confirm response (joiner → inviter)", () => {
		expect(wire.PairConfirmResponse.safeParse({ step: "confirm", signature, grantedCapabilities: ["agents.read"], status: "paired" }).success).toBe(true);
		expect(wire.PairConfirmResponse.safeParse({ step: "confirm", signature, grantedCapabilities: [], status: "pending_user_approval" }).success).toBe(false);
	});
});

describe("wire agents, announce, revoke, events, errors", () => {
	it("agents list: activeSessions defaults to 0, statuses are enumerated", () => {
		const agent = { agentId: "ag_1", name: "Planner", role: "free text", runtime: "omp", capabilities: ["code"], status: "online", activeTasks: 1, acceptsTasks: true };
		const parsed = wire.AgentsResponse.parse({ agents: [agent, { ...agent, agentId: "ag_2", status: "busy", activeSessions: 3 }] });
		expect(parsed.agents.map((x) => x.activeSessions)).toEqual([0, 3]);
		expect(wire.AgentsResponse.safeParse({ agents: [{ ...agent, status: "asleep" }] }).success).toBe(false);
		expect(wire.AgentsResponse.safeParse({ agents: [{ ...agent, activeTasks: -1 }] }).success).toBe(false);
		expect(wire.AgentsResponse.parse({ agents: [] })).toEqual({ agents: [] });
	});

	it("announce and revoke bodies and the ok response", () => {
		expect(wire.AnnounceBody.parse({ url: "https://new.trycloudflare.com", name: "Renamed" })).toEqual({ url: "https://new.trycloudflare.com", name: "Renamed" });
		expect(wire.AnnounceBody.safeParse({ name: "x" }).success).toBe(false);
		expect(wire.AnnounceBody.safeParse({ url: "https://x", name: "" }).success).toBe(false);
		expect(wire.RevokeBody.parse({})).toEqual({});
		expect(wire.RevokeBody.parse({ reason: "lost laptop" })).toEqual({ reason: "lost laptop" });
		expect(wire.RevokeBody.safeParse({ reason: "x".repeat(501) }).success).toBe(false);
		expect(wire.OkResponse.safeParse({ ok: true }).success).toBe(true);
		expect(wire.OkResponse.safeParse({ ok: false }).success).toBe(false);
	});

	it("node events: envelope, known types and their payloads; unknown types still parse as envelopes", () => {
		const event = { stream: "node", seq: 4, eventId: "evt_1", at: "2026-10-31T05:52:42.212Z", correlationId: "corr", type: "agents_changed", payload: { count: 2 } };
		expect(wire.NodeEvent.parse(event)).toMatchObject({ seq: 4, type: "agents_changed" });
		expect(wire.NodeEvent.safeParse({ ...event, seq: -1 }).success).toBe(false);
		expect(wire.NodeEvent.safeParse({ ...event, seq: 1.5 }).success).toBe(false);
		expect(wire.NodeEvent.safeParse({ ...event, eventId: undefined }).success).toBe(false);
		expect(wire.NodeEvent.safeParse({ ...event, type: "from_the_future", payload: { x: 1 } }).success).toBe(true);
		expect(wire.NodeEventType.options).toEqual(["agents_changed", "health", "peer_revoked", "peer_updated", "task.updated"]);
		expect(wire.NodeEventPayloads.agents_changed.parse({ count: 2 })).toEqual({ count: 2 });
		expect(wire.NodeEventPayloads.health.parse({ status: "degraded" })).toEqual({ status: "degraded" });
		expect(wire.NodeEventPayloads.peer_revoked.parse({})).toEqual({});
		expect(wire.NodeEventPayloads.peer_updated.parse({ url: "https://x", name: "N" })).toEqual({ url: "https://x", name: "N" });
		expect(wire.NodeEventPayloads.health.safeParse({ status: "bad" }).success).toBe(false);
	});

	it("task payloads: create request defaults, record, events, cancel and message bodies", () => {
		const create = { taskId: "tsk_01J", workspaceId: "w1", projectRef: { repoUrl: "https://github.com/o/r" }, title: "T", description: "do it", epoch: 0, correlationId: "corr_1" };
		expect(wire.CreateTaskRequest.parse(create)).toMatchObject({ deliverAs: "branch", constraints: {}, sender: {} });
		expect(wire.CreateTaskRequest.safeParse({ ...create, taskId: "bad id" }).success).toBe(false);
		expect(wire.CreateTaskRequest.safeParse({ ...create, title: "" }).success).toBe(false);
		expect(wire.CreateTaskRequest.safeParse({ ...create, deliverAs: "magic" }).success).toBe(false);
		expect(wire.CreateTaskRequest.safeParse({ ...create, epoch: -1 }).success).toBe(false);
		expect(wire.CreateTaskRequest.safeParse({ ...create, unknownField: 1 }).success).toBe(true);

		const record = { taskId: "tsk_01J", status: "running", epoch: 0, createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z", lastEventSeq: 3 };
		expect(wire.TaskRecord.parse(record)).toMatchObject({ status: "running", lastEventSeq: 3 });
		expect(wire.TaskRecord.safeParse({ ...record, status: "weird" }).success).toBe(false);
		expect(wire.GetTaskResponse.parse({ ...record, events: [{ seq: 1, type: "status", at: "2026-10-31T00:00:00.000Z", summary: "offered" }] }).events).toHaveLength(1);
		expect(wire.GetTaskResponse.safeParse({ ...record, events: [{ seq: 0, type: "status", at: "x", summary: "s" }] }).success).toBe(false);

		expect(wire.CancelTaskRequest.parse({ epoch: 1 })).toEqual({ epoch: 1 });
		const message = { messageId: "msg_1", epoch: 0, kind: "question", body: "which file?", author: { kind: "agent", agentName: "OMP Agent" }, createdAt: "2026-10-31T00:00:00.000Z" };
		expect(wire.TaskMessageRequest.parse(message)).toMatchObject({ kind: "question" });
		expect(wire.TaskMessageRequest.safeParse({ ...message, kind: "shout" }).success).toBe(false);
		expect(wire.TaskMessageRequest.safeParse({ ...message, body: "" }).success).toBe(false);
		expect(wire.TaskMessageRequest.safeParse({ ...message, author: { kind: "system" } }).success).toBe(false);
		expect(wire.TaskMessageAccepted.parse({ messageId: "msg_1", accepted: true, eventSeq: 4 })).toEqual({ messageId: "msg_1", accepted: true, eventSeq: 4 });
		expect(wire.NodeEventPayloads["task.updated"].parse({ taskId: "tsk_1", seq: 2, status: "running" })).toEqual({ taskId: "tsk_1", seq: 2, status: "running" });
	});

	it("error envelope", () => {
		expect(wire.ApiErrorBody.parse({ error: { code: "clock_skew", message: "m", details: { serverTime: 1 } } }).error.details).toEqual({ serverTime: 1 });
		expect(wire.ApiErrorBody.safeParse({ error: { code: "x" } }).success).toBe(false);
		expect(wire.ApiErrorBody.safeParse({ message: "x" }).success).toBe(false);
	});
});
