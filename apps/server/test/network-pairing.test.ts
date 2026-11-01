import { deriveCodeKey, generatePairingNonce, helloProofParts, pairingProof, publicKeyToWire } from "@clam/agent-network";
import type { DirectoryAgent, Invitation, NodePreview, OutgoingPairing, PairingRequest, Peer, Workspace } from "@clam/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { api, createMemorySecrets, type FullHarness } from "./full-harness.ts";
import { eventually, pair, peerOf, peersOf, startNode } from "./net-helpers.ts";

const nodes: FullHarness[] = [];
async function node(name: string, extra?: Parameters<typeof startNode>[1]): Promise<FullHarness> {
	const n = await startNode(name, extra);
	nodes.push(n);
	return n;
}
afterEach(async () => {
	for (const n of nodes.splice(0)) await n.cleanup();
});

/** A hello straight onto the wire with an arbitrary proof (what a code guesser would send). */
async function wireHello(inviter: FullHarness, joiner: FullHarness, invitationId: string, codeUsedForProof: string) {
	const nonce = generatePairingNonce();
	const identity = joiner.ctx.identity;
	const proof = pairingProof(
		deriveCodeKey(codeUsedForProof, invitationId),
		"hello",
		helloProofParts({ invitationId, inviterId: inviter.ctx.identity.nodeId, joinerId: identity.nodeId, joinerPub: identity.publicKey, nonceJoiner: nonce }),
	);
	const res = await fetch(`${inviter.netUrl}/api/v1/node/pair`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			step: "hello",
			invitationId,
			node: { nodeId: identity.nodeId, name: "guesser", publicKey: publicKeyToWire(identity.publicKey), publicUrl: joiner.netUrl },
			nonce,
			proof,
		}),
	});
	return { status: res.status, body: await res.json() };
}

describe("pairing", () => {
	it("pairs two nodes with an invitation code: keys pinned, workspace shared, members recorded, directories populated, code never stored", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		const { workspace, invitation } = await pair(a, b);
		const [peerOnA] = await peersOf(a);
		const [peerOnB] = await peersOf(b);

		expect(peerOnA).toMatchObject({ id: b.ctx.identity.nodeId, name: "node-b", fingerprint: b.ctx.identity.fingerprint, url: b.netUrl, status: "online", revokedBy: null });
		expect(peerOnB).toMatchObject({ id: a.ctx.identity.nodeId, name: "node-a", fingerprint: a.ctx.identity.fingerprint, url: a.netUrl, status: "online" });
		// A granted B what the user approved; B granted A the defaults, and each side learned what the other granted it.
		expect(peerOnA?.grantedCapabilities.sort()).toEqual(["agents.read", "events.read", "tasks.receive", "tasks.send"]);
		expect(peerOnB?.receivedCapabilities.sort()).toEqual(["agents.read", "events.read", "tasks.receive", "tasks.send"]);
		expect(peerOnA?.receivedCapabilities.sort()).toEqual(["agents.read", "events.read", "tasks.receive", "tasks.send"]);
		expect(peerOnA?.workspaceIds).toEqual([workspace.id]);
		expect(peerOnB?.workspaceIds).toEqual([workspace.id]);

		// The key pinned on each side is the one the other node really has.
		const rowA = a.ctx.db.$client.prepare("select public_key, key_id from peers").get() as { public_key: string; key_id: string };
		expect(rowA.public_key).toBe(b.ctx.identity.publicKey);
		expect(rowA.key_id).toBe(b.ctx.identity.fingerprint.slice(0, 16));

		// B got a local workspace with the SAME id and name; both sides list the other as a member.
		const wsOnB = (await api(b).get<Workspace[]>("/workspaces")).body;
		expect(wsOnB).toEqual([expect.objectContaining({ id: workspace.id, name: "Alpha" })]);
		const memberA = a.ctx.db.$client.prepare("select member_id, role, permissions, granted_by, revoked_at from workspace_members where workspace_id = ? order by member_id").all(workspace.id) as Array<Record<string, unknown>>;
		expect(memberA.map((m) => m.member_id).sort()).toEqual([a.ctx.identity.nodeId, b.ctx.identity.nodeId].sort());
		const remoteOnA = memberA.find((m) => m.member_id === b.ctx.identity.nodeId);
		expect(remoteOnA).toMatchObject({ role: "member", granted_by: a.ctx.identity.nodeId, revoked_at: null });
		expect(JSON.parse(remoteOnA?.permissions as string).sort()).toEqual(["agents.read", "events.read", "tasks.receive", "tasks.send"]);
		const memberB = b.ctx.db.$client.prepare("select member_id, role from workspace_members where workspace_id = ?").all(workspace.id) as Array<{ member_id: string; role: string }>;
		expect(memberB.find((m) => m.member_id === a.ctx.identity.nodeId)?.role).toBe("owner");

		// The invitation is consumed (single use) and reported so.
		const invitations = (await api(a).get<Invitation[]>("/network/invitations")).body;
		expect(invitations[0]).toMatchObject({ id: invitation.id, state: "consumed" });
		expect(invitations[0]?.code).toBeUndefined();
		expect((await api(a).get<PairingRequest[]>("/network/pairing-requests")).body[0]).toMatchObject({ state: "paired", error: null });
		expect((await api(b).get<OutgoingPairing[]>("/network/join")).body[0]).toMatchObject({ state: "paired", workspaceId: workspace.id });

		// Agent Directory: each node lists its own agent and the other node's.
		const dirA = await eventually(async () => {
			const list = (await api(a).get<DirectoryAgent[]>("/network/agents")).body;
			return list.some((d) => d.nodeId === b.ctx.identity.nodeId) ? list : null;
		}, "B's agent in A's directory");
		expect(dirA.map((d) => [d.nodeStatus, d.name]).sort()).toEqual([["online", "OMP Agent"], ["self", "OMP Agent"]]);
		expect(dirA.find((d) => d.nodeId === b.ctx.identity.nodeId)).toMatchObject({ nodeName: "node-b", runtime: "omp", status: "online" });
		const dirB = await eventually(async () => {
			const list = (await api(b).get<DirectoryAgent[]>("/network/agents")).body;
			return list.some((d) => d.nodeId === a.ctx.identity.nodeId) ? list : null;
		}, "A's agent in B's directory");
		expect(dirB).toHaveLength(2);

		// The code (and its derived key) is nowhere in SQLite or in the pending secret entries.
		for (const n of [a, b]) {
			const dump = JSON.stringify(
				["pairing_invitations", "pairing_requests", "pairing_joins", "peers", "settings", "node_events", "network_events"].map((t) => n.ctx.db.$client.prepare(`select * from ${t}`).all()),
			);
			expect(dump).not.toContain(invitation.code?.replace("-", "") ?? "?");
			expect(dump).not.toContain(invitation.code ?? "?");
		}
		expect(await a.ctx.secrets.get(`pairing.codekey.${invitation.id}`)).toBeNull();
		// SecurityInfo reflects reality: loopback peers only, no tunnel => remote API not enabled.
		expect((await api(a).get<{ remoteApiEnabled: boolean }>("/security")).body.remoteApiEnabled).toBe(false);
	});

	it("pairs a previously revoked peer again: the row is reactivated on both sides and both come online", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		await pair(a, b);
		await api(a).post(`/network/peers/${b.ctx.identity.nodeId}/revoke`);
		await eventually(async () => (await peerOf(b, a.ctx.identity.nodeId))?.status === "revoked", "B sees the revocation");
		expect(await peerOf(b, a.ctx.identity.nodeId)).toMatchObject({ revokedBy: "remote" });

		const second = await pair(a, b, { workspaceName: "Beta", capabilities: ["agents.read", "events.read"] });
		expect(second.request.state).toBe("paired");
		const onA = await peerOf(a, b.ctx.identity.nodeId);
		const onB = await peerOf(b, a.ctx.identity.nodeId);
		expect(onA).toMatchObject({ status: "online", revokedAt: null, revokedBy: null });
		expect(onB).toMatchObject({ status: "online", revokedAt: null, revokedBy: null });
		expect(onA?.grantedCapabilities.sort()).toEqual(["agents.read", "events.read"]);
		expect(onA?.workspaceIds).toEqual([second.workspace.id]);
		// Stays online: nothing later flips it back to revoked.
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect((await peerOf(a, b.ctx.identity.nodeId))?.status).toBe("online");
		expect((await peerOf(b, a.ctx.identity.nodeId))?.status).toBe("online");
	});

	it("previews the inviter before any secret is used", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		const preview = await api(b).post<NodePreview>("/network/join/preview", { url: a.netUrl });
		expect(preview.status).toBe(200);
		expect(preview.body).toMatchObject({ nodeId: a.ctx.identity.nodeId, name: "node-a", fingerprint: a.ctx.identity.fingerprint, protocolVersions: [1], version: "0.0.0-test" });
		expect((await api(b).post("/network/join/preview", { url: "https://127.0.0.1:1" })).status).toBe(502);
		expect((await api(b).post("/network/join/preview", { url: "ftp://example.com" })).status).toBe(400);
		expect((await api(b).post("/network/join/preview", { url: "http://example.com" })).status).toBe(400);
	});

	it("answers a wrong proof with a uniform 404, counts the attempt, and locks the invitation after 5", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		const ws = (await api(a).post<Workspace>("/workspaces", { name: "W" })).body;
		const invitation = (await api(a).post<Invitation>("/network/invitations", { workspaceId: ws.id })).body;
		const code = invitation.code as string;

		const unknown = await wireHello(a, b, "inv_doesnotexist000000000000", code);
		expect(unknown.status).toBe(404);
		for (let attempt = 1; attempt <= 5; attempt++) {
			const wrong = await wireHello(a, b, invitation.id, "ZZZZ-ZZZZ");
			expect(wrong.status).toBe(404);
			expect(wrong.body).toEqual({ error: { code: "not_found", message: "Not found", i18n: { key: "Not found" } } });
			const [listed] = (await api(a).get<Invitation[]>("/network/invitations")).body;
			expect(listed?.attempts).toBe(attempt);
			expect(listed?.state).toBe(attempt < 5 ? "pending" : "locked");
		}
		// Locked: even the right code is now indistinguishable from an unknown invitation.
		const correct = await wireHello(a, b, invitation.id, code);
		expect(correct).toEqual({ status: 404, body: { error: { code: "not_found", message: "Not found", i18n: { key: "Not found" } } } });
		expect((await api(a).get<Invitation[]>("/network/invitations")).body[0]?.attempts).toBe(5);
		expect(await a.ctx.secrets.get(`pairing.codekey.${invitation.id}`)).toBeNull();
		// Through the UI the joiner just learns that the code was not accepted.
		const viaUi = await api(b).post<{ error: { code: string } }>("/network/join", { url: a.netUrl, code, expectedFingerprint: a.ctx.identity.fingerprint });
		expect(viaUi.status).toBe(422);
		expect(viaUi.body.error.code).toBe("invitation_rejected");
		expect(await peersOf(a)).toEqual([]);
	});

	it("refuses to pair when the inviter presents another fingerprint than the one the user verified", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		const ws = (await api(a).post<Workspace>("/workspaces", { name: "W" })).body;
		const invitation = (await api(a).post<Invitation>("/network/invitations", { workspaceId: ws.id })).body;
		const wrong = "ab".repeat(32);
		const res = await api(b).post<{ error: { code: string; details: { presented: string } } }>("/network/join", { url: a.netUrl, code: invitation.code, expectedFingerprint: wrong });
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe("fingerprint_mismatch");
		expect(res.body.error.details.presented).toBe(a.ctx.identity.fingerprint);
		// Nothing was sent: no attempt counted, no request, no peer, no join record.
		expect((await api(a).get<Invitation[]>("/network/invitations")).body[0]).toMatchObject({ attempts: 0, state: "pending" });
		expect((await api(a).get<PairingRequest[]>("/network/pairing-requests")).body).toEqual([]);
		expect((await api(b).get<OutgoingPairing[]>("/network/join")).body).toEqual([]);
		// A shortened fingerprint is not accepted either: the whole key hash is compared.
		const short = await api(b).post("/network/join", { url: a.netUrl, code: invitation.code, expectedFingerprint: a.ctx.identity.fingerprint.slice(0, 16) });
		expect(short.status).toBe(400);
		// The right fingerprint, grouped and upper-cased as the UI shows it, works.
		const grouped = a.ctx.identity.fingerprint.toUpperCase().replace(/(.{4})/g, "$1 ").trim();
		const ok = await api(b).post<OutgoingPairing>("/network/join", { url: a.netUrl, code: invitation.code?.toLowerCase().replace("-", " "), expectedFingerprint: grouped });
		expect(ok.status).toBe(201);
		expect(ok.body.state).toBe("awaiting_remote_approval");
	});

	it("treats expired, consumed, revoked and unknown invitations identically (404)", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		const c = await node("node-c");
		const ws = (await api(a).post<Workspace>("/workspaces", { name: "W" })).body;
		const make = async () => (await api(a).post<Invitation>("/network/invitations", { workspaceId: ws.id })).body;
		const expired = await make();
		const revoked = await make();
		a.ctx.db.$client.prepare("update pairing_invitations set expires_at = ? where id = ?").run(new Date(Date.now() - 1000).toISOString(), expired.id);
		expect((await api(a).get<Invitation[]>("/network/invitations")).body.find((i) => i.id === expired.id)?.state).toBe("expired");
		expect((await api(a).del(`/network/invitations/${revoked.id}`)).status).toBe(204);
		expect((await api(a).del(`/network/invitations/${revoked.id}`)).status).toBe(204); // idempotent
		expect((await api(a).del(`/network/invitations/inv_nope`)).status).toBe(404);

		const consumed = await make();
		await api(b).post("/network/join", { url: a.netUrl, code: consumed.code, expectedFingerprint: a.ctx.identity.fingerprint });
		const request = await eventually(async () => (await api(a).get<PairingRequest[]>("/network/pairing-requests")).body.find((r) => r.state === "awaiting_approval"), "request");
		await api(a).post(`/network/pairing-requests/${request.id}/approve`, { capabilities: ["agents.read"] });
		await eventually(async () => (await peerOf(a, b.ctx.identity.nodeId)) !== undefined, "paired");
		expect((await api(a).del(`/network/invitations/${consumed.id}`)).status).toBe(409);

		const outcomes = [] as Array<{ status: number; body: unknown }>;
		for (const invitation of [expired, revoked, consumed]) {
			outcomes.push(await wireHello(a, c, invitation.id, invitation.code as string));
			const viaUi = await api(c).post("/network/join", { url: a.netUrl, code: invitation.code, expectedFingerprint: a.ctx.identity.fingerprint });
			expect(viaUi.status).toBe(422);
		}
		outcomes.push(await wireHello(a, c, "inv_unknown0000000000000000", "ABCD-EFGH"));
		for (const outcome of outcomes) expect(outcome).toEqual({ status: 404, body: { error: { code: "not_found", message: "Not found", i18n: { key: "Not found" } } } });
	});

	it("expires a handshake nobody approved in time on both sides and refuses a late approval", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		const ws = (await api(a).post<Workspace>("/workspaces", { name: "W" })).body;
		const invitation = (await api(a).post<Invitation>("/network/invitations", { workspaceId: ws.id })).body;
		await api(b).post("/network/join", { url: a.netUrl, code: invitation.code, expectedFingerprint: a.ctx.identity.fingerprint });
		const request = await eventually(async () => (await api(a).get<PairingRequest[]>("/network/pairing-requests")).body.find((r) => r.state === "awaiting_approval"), "request");
		const past = new Date(Date.now() - 1000).toISOString();
		a.ctx.db.$client.prepare("update pairing_invitations set expires_at = ?").run(past);
		b.ctx.db.$client.prepare("update pairing_joins set expires_at = ?").run(past);
		await eventually(async () => (await api(a).get<PairingRequest[]>("/network/pairing-requests")).body[0]?.state === "expired", "inviter request expired");
		await eventually(async () => (await api(b).get<OutgoingPairing[]>("/network/join")).body[0]?.state === "expired", "joiner pairing expired");
		expect((await api(a).get<Invitation[]>("/network/invitations")).body[0]?.state).toBe("expired");
		// The housekeeping pass records what the clock already implies.
		await eventually(() => (a.ctx.db.$client.prepare("select state from pairing_invitations").get() as { state: string }).state === "expired", "expiry recorded");
		await eventually(() => (a.ctx.db.$client.prepare("select state from pairing_requests").get() as { state: string }).state === "expired", "request expiry recorded");
		const late = await api(a).post<{ error: { code: string } }>(`/network/pairing-requests/${request.id}/approve`, { capabilities: [] });
		expect(late.status).toBe(409);
		expect(await peersOf(a)).toEqual([]);
	});

	it("lets the inviter's user reject: the joiner learns it, nothing is paired, the invitation is spent", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		const ws = (await api(a).post<Workspace>("/workspaces", { name: "W" })).body;
		const invitation = (await api(a).post<Invitation>("/network/invitations", { workspaceId: ws.id })).body;
		await api(b).post("/network/join", { url: a.netUrl, code: invitation.code, expectedFingerprint: a.ctx.identity.fingerprint });
		const request = await eventually(async () => (await api(a).get<PairingRequest[]>("/network/pairing-requests")).body.find((r) => r.state === "awaiting_approval"), "request");
		expect(request.remote).toMatchObject({ nodeId: b.ctx.identity.nodeId, name: "node-b", fingerprint: b.ctx.identity.fingerprint });
		const rejected = await api(a).post<PairingRequest>(`/network/pairing-requests/${request.id}/reject`);
		expect(rejected.body.state).toBe("rejected");
		await eventually(async () => (await api(b).get<OutgoingPairing[]>("/network/join")).body[0]?.state === "rejected", "joiner sees the rejection");
		expect(await peersOf(a)).toEqual([]);
		expect(await peersOf(b)).toEqual([]);
		expect((await api(a).get<Invitation[]>("/network/invitations")).body[0]?.state).toBe("revoked");
		expect((await api(a).post(`/network/pairing-requests/${request.id}/approve`, { capabilities: [] })).status).toBe(409);
		// The spent invitation cannot be used again.
		const again = await api(b).post("/network/join", { url: a.netUrl, code: invitation.code, expectedFingerprint: a.ctx.identity.fingerprint });
		expect(again.status).toBe(422);
	});

	it("cannot be spoofed: a forged rejection or confirmation without the inviter's signature changes nothing", async () => {
		const a = await node("node-a");
		const b = await node("node-b");
		const ws = (await api(a).post<Workspace>("/workspaces", { name: "W" })).body;
		const invitation = (await api(a).post<Invitation>("/network/invitations", { workspaceId: ws.id })).body;
		await api(b).post("/network/join", { url: a.netUrl, code: invitation.code, expectedFingerprint: a.ctx.identity.fingerprint });
		const forged = (status: "approved" | "rejected") =>
			fetch(`${b.netUrl}/api/v1/node/pair`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ step: "confirm", invitationId: invitation.id, status, capabilities: status === "rejected" ? [] : ["tasks.send"], signature: "A".repeat(86) }),
			});
		expect((await forged("rejected")).status).toBe(401);
		expect((await forged("approved")).status).toBe(401);
		expect((await api(b).get<OutgoingPairing[]>("/network/join")).body[0]?.state).toBe("awaiting_remote_approval");
		expect(await peersOf(b)).toEqual([]);
	});

	it("resumes a handshake across restarts of both nodes and retries an unreachable joiner", async () => {
		const secretsA = createMemorySecrets();
		const secretsB = createMemorySecrets();
		let a = await node("node-a", { secrets: secretsA });
		let b = await node("node-b", { secrets: secretsB });
		const portA = a.netPort;
		const portB = b.netPort;
		const dirA = a.dataDir;
		const dirB = b.dataDir;
		const ws = (await api(a).post<Workspace>("/workspaces", { name: "Shared" })).body;
		const invitation = (await api(a).post<Invitation>("/network/invitations", { workspaceId: ws.id })).body;
		const join = (await api(b).post<OutgoingPairing>("/network/join", { url: a.netUrl, code: invitation.code, expectedFingerprint: a.ctx.identity.fingerprint })).body;
		await eventually(async () => (await api(a).get<PairingRequest[]>("/network/pairing-requests")).body.find((r) => r.state === "awaiting_approval"), "request");

		// Restart the inviter while the request waits for the user.
		await a.cleanup({ keepData: true });
		nodes.splice(nodes.indexOf(a), 1);
		a = await node("node-a", { dataDir: dirA, port: portA, secrets: secretsA });
		const request = (await api(a).get<PairingRequest[]>("/network/pairing-requests")).body.find((r) => r.state === "awaiting_approval");
		expect(request).toBeDefined();

		// Take the joiner down, approve: the pairing stays `confirming` and keeps retrying.
		await b.cleanup({ keepData: true });
		nodes.splice(nodes.indexOf(b), 1);
		const approved = await api(a).post<PairingRequest>(`/network/pairing-requests/${request?.id}/approve`, { capabilities: ["agents.read", "events.read"] });
		expect(approved.status).toBe(200);
		expect(approved.body.state).toBe("confirming");
		expect(approved.body.error).toContain("Could not reach");
		expect(await peersOf(a)).toEqual([]);

		// The joiner returns with its persisted handshake state and the next retry completes the pairing on both sides.
		b = await node("node-b", { dataDir: dirB, port: portB, secrets: secretsB });
		expect((await api(b).get<OutgoingPairing[]>("/network/join")).body[0]).toMatchObject({ id: join.id, state: "awaiting_remote_approval" });
		await eventually(async () => (await api(a).get<PairingRequest[]>("/network/pairing-requests")).body[0]?.state === "paired", "inviter paired after the joiner returned", 15_000);
		await eventually(async () => (await peerOf(b, a.ctx.identity.nodeId))?.status === "online", "joiner paired and online");
		expect((await api(b).get<Workspace[]>("/workspaces")).body).toEqual([expect.objectContaining({ id: ws.id, name: "Shared" })]);
		expect((await peerOf(a, b.ctx.identity.nodeId))?.grantedCapabilities.sort()).toEqual(["agents.read", "events.read"]);
	});

	it("marks a joiner whose hello was interrupted by a restart as failed (the code is gone by design)", async () => {
		const a = await node("node-a");
		let b = await node("node-b");
		const dirB = b.dataDir;
		const portB = b.netPort;
		b.ctx.db.$client
			.prepare(
				"insert into pairing_joins (id, url, invitation_id, remote_node_id, remote_name, remote_public_key, remote_fingerprint, remote_preview, nonce_joiner, granted_capabilities, state, correlation_id, expires_at) values ('join_x', ?, 'inv_x', 'node_x', 'x', 'k', 'f', '{}', 'n', '[]', 'hello_sent', 'c', ?)",
			)
			.run(a.netUrl, new Date(Date.now() + 60_000).toISOString());
		await b.cleanup({ keepData: true });
		nodes.splice(nodes.indexOf(b), 1);
		b = await node("node-b", { dataDir: dirB, port: portB });
		const [row] = (await api(b).get<OutgoingPairing[]>("/network/join")).body;
		expect(row).toMatchObject({ id: "join_x", state: "failed" });
		expect(row?.error).toContain("restart");
	});

	it("validates join, invitation and approval input", async () => {
		const a = await node("node-a");
		const ws = (await api(a).post<Workspace>("/workspaces", { name: "W" })).body;
		expect((await api(a).post("/network/invitations", { workspaceId: "nope" })).status).toBe(404);
		expect((await api(a).post("/network/invitations", { workspaceId: ws.id, ttlMinutes: 11 })).status).toBe(400);
		expect((await api(a).post("/network/invitations", { workspaceId: ws.id, capabilities: ["root"] })).status).toBe(400);
		expect((await api(a).post("/network/join", { url: a.netUrl, code: "12", expectedFingerprint: a.ctx.identity.fingerprint })).status).toBe(400);
		expect((await api(a).post("/network/join", { url: a.netUrl, code: "ABCD-EFGU", expectedFingerprint: a.ctx.identity.fingerprint })).status).toBe(400);
		expect((await api(a).post("/network/pairing-requests/prq_nope/approve", { capabilities: [] })).status).toBe(404);
		expect((await api(a).post("/network/pairing-requests/prq_nope/reject")).status).toBe(404);
		expect((await api(a).get("/network/peers/node_nope")).status).toBe(404);
		expect((await api(a).post("/network/peers/node_nope/revoke")).status).toBe(404);
		// Joining oneself is refused.
		const ownInvitation = (await api(a).post<Invitation>("/network/invitations", { workspaceId: ws.id })).body;
		const self = await api(a).post("/network/join", { url: a.netUrl, code: ownInvitation.code, expectedFingerprint: a.ctx.identity.fingerprint });
		expect(self.status).toBe(400);
	});

	it("refuses http peers unless loopback peers are allowed, and needs a public URL to join", async () => {
		const plain = await (await import("./full-harness.ts")).createFullHarness();
		nodes.push(plain);
		const refused = await api(plain).post<{ error: { message: string } }>("/network/join/preview", { url: "http://127.0.0.1:9" });
		expect(refused.status).toBe(400);
		expect(refused.body.error.message).toContain("https://");
		// Without loopback peers and without a tunnel the node has no address to give the inviter.
		expect(plain.ctx.network.selfUrl()).toBeNull();
		const ws = (await api(plain).post<Workspace>("/workspaces", { name: "W" })).body;
		const invitation = (await api(plain).post<Invitation>("/network/invitations", { workspaceId: ws.id })).body;
		expect(invitation.url).toBeNull();
		const a = await node("node-a");
		const ws2 = (await api(a).post<Workspace>("/workspaces", { name: "W2" })).body;
		const inv2 = (await api(a).post<Invitation>("/network/invitations", { workspaceId: ws2.id })).body;
		const peerless = await api(plain).post("/network/join", { url: a.netUrl, code: inv2.code, expectedFingerprint: a.ctx.identity.fingerprint });
		// Loopback http is refused outright for this node (400) before the missing public URL matters.
		expect(peerless.status).toBe(400);
	});
});
