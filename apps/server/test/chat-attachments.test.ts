import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentSession, FileEntry, Peer, Project, SharedAttachment, SharedMessage, SharedSession } from "@clam/contracts";
import type { SharedOptions } from "../src/shared/hub.ts";
import { afterEach, describe, expect, it } from "vitest";
import { api, type FullHarness } from "./full-harness.ts";
import { eventually, pair, signedRequest, startNode } from "./net-helpers.ts";
import { detailOn, grantShare, sharedOn, transcriptTexts, waitForShared, whenSettled } from "./shared-fixtures.ts";

/**
 * Plain chats (no project, no git) between two real in-process nodes with files in the group chat: upload → message →
 * replicated metadata → bytes fetched by every member (sha-256 verified; eagerly up to a limit, otherwise when opened), copied
 * into each agent's working folder when the message reaches it, and `mesh_share_file` from an agent.
 */

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const QUIET = "\n@@fake-sh true";

interface Chat {
	a: FullHarness;
	b: FullHarness;
	aId: string;
	bId: string;
	sessionA: string;
	shared: SharedSession;
	/** Agent of node A / B (for explicit addressing). */
	agentA: { nodeId: string; agentId: string };
	agentB: { nodeId: string; agentId: string };
	sessionB: string;
	projectA: Project;
	projectB: Project;
	root: { b: { dataDir: string; netPort: number; secrets: FullHarness["ctx"]["secrets"] } | null };
}

let chat: Chat | undefined;
let extraDirs: string[] = [];
afterEach(async () => {
	if (chat) {
		await chat.a.cleanup();
		if (chat.root.b) rmSync(chat.root.b.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		else await chat.b.cleanup();
		chat = undefined;
	}
	for (const dir of extraDirs) rmSync(dir, { recursive: true, force: true });
	extraDirs = [];
});

/** Two paired nodes, a chat started on A with NO project (so A and B both get a chat folder), B joined and briefed. */
async function startChat(timingsB: Partial<SharedOptions> = {}): Promise<Chat> {
	const a = await startNode("node-a");
	const b = await startNode("node-b", { sharedTimings: timingsB });
	await pair(a, b);
	const aId = a.ctx.identity.nodeId;
	const bId = b.ctx.identity.nodeId;
	await grantShare(a, bId, b);
	await grantShare(b, aId, a);
	const auto = await api(b).patch<Peer>(`/network/peers/${aId}`, { autoAcceptTasks: true });
	expect(auto.status).toBe(200);
	const session = await api(a).post<AgentSession>("/sessions", { title: "Research chat" });
	expect(session.status, JSON.stringify(session.body)).toBe(201);
	const added = await api(a).post<SharedSession>(`/sessions/${session.body.id}/participants`, { nodeId: bId });
	expect(added.status, JSON.stringify(added.body)).toBe(201);
	const onB = await waitForShared(b, added.body.id, (s) => s.localRole === "participant" && s.mirrorSessionId !== null && s.localProjectId !== null, "B joined");
	await waitForShared(a, added.body.id, (s) => s.participants.some((p) => p.nodeId === bId && p.state === "active"), "A sees B active");
	const shared = await sharedOn(a, added.body.id);
	const part = (s: SharedSession, nodeId: string) => s.participants.find((p) => p.nodeId === nodeId) as SharedSession["participants"][number];
	const sessionB = part(onB, bId).agentSessionId as string;
	await eventually(async () => (await transcriptTexts(b, sessionB)).some((t) => t.startsWith("FAKE: # Shared session")), "B's agent to acknowledge the briefing");
	await whenSettled(b, sessionB);
	const projectA = (await api(a).get<Project>(`/projects/${session.body.projectId}`)).body;
	const projectB = (await api(b).get<Project>(`/projects/${onB.localProjectId}`)).body;
	return {
		a,
		b,
		aId,
		bId,
		sessionA: session.body.id,
		shared,
		agentA: { nodeId: aId, agentId: part(shared, aId).agentId as string },
		agentB: { nodeId: bId, agentId: part(shared, bId).agentId as string },
		sessionB,
		projectA,
		projectB,
		root: { b: null },
	};
}

async function uploadTo(node: FullHarness, sharedId: string, name: string, bytes: Buffer, type = "application/octet-stream"): Promise<SharedAttachment> {
	const res = await fetch(`${node.url}/api/local/shared/${sharedId}/attachments?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": type }, body: bytes });
	expect(res.status, await res.clone().text()).toBe(201);
	return (await res.json()) as SharedAttachment;
}

async function post(node: FullHarness, sharedId: string, body: Record<string, unknown>): Promise<{ status: number; body: SharedMessage }> {
	return api(node).post<SharedMessage>(`/shared/${sharedId}/messages`, body);
}

const messageWith = async (node: FullHarness, sharedId: string, attachmentId: string): Promise<SharedMessage | undefined> =>
	(await detailOn(node, sharedId)).messages.find((m) => m.attachments.some((a) => a.id === attachmentId));

const fetchBytes = async (node: FullHarness, sharedId: string, attachmentId: string, init: RequestInit = {}) => {
	const res = await fetch(`${node.url}/api/local/shared/${sharedId}/attachments/${attachmentId}`, init);
	return { res, bytes: Buffer.from(await res.arrayBuffer()) };
};

const projectOf = async (node: FullHarness, sessionId: string): Promise<Project> => {
	const session = (await api(node).get<AgentSession>(`/sessions/${sessionId}`)).body;
	return (await api(node).get<Project>(`/projects/${session.projectId}`)).body;
};

const blobsOf = (node: FullHarness): string[] => (existsSync(path.join(node.dataDir, "attachments")) ? readdirSync(path.join(node.dataDir, "attachments")).filter((n) => !n.startsWith(".")) : []);

describe("a plain chat between two nodes: no project, no git", () => {
	it("both sides get a chat folder (origin chat) for the shared session", async () => {
		chat = await startChat();
		expect(chat.projectA).toMatchObject({ origin: "chat", managed: true, vcs: "none" });
		expect(chat.projectB).toMatchObject({ origin: "chat", managed: true, vcs: "none" });
		expect(chat.shared).toMatchObject({ vcs: "files", repo: null });
	});

	it("a file posted by a human replicates (metadata with the message, bytes verified by sha-256) and is copied into BOTH agents' folders", async () => {
		const c = (chat = await startChat());
		const bytes = Buffer.from("quarterly numbers\n".repeat(200));
		const uploaded = await uploadTo(c.a, c.shared.id, "report.txt", bytes, "text/plain");
		expect(uploaded).toMatchObject({ name: "report.txt", mimeType: "text/plain", size: bytes.length, sha256: sha(bytes), originNodeId: c.aId, available: true });
		expect(readFileSync(path.join(c.a.dataDir, "attachments", sha(bytes)))).toEqual(bytes);

		const posted = await post(c.a, c.shared.id, { text: `please read it${QUIET}`, to: { mode: "all", agents: [] }, attachmentIds: [uploaded.id] });
		expect(posted.status, JSON.stringify(posted.body)).toBe(201);
		expect(posted.body.attachments).toMatchObject([{ id: uploaded.id, name: "report.txt", sha256: sha(bytes) }]);

		// B: metadata with the message, bytes fetched eagerly and verified
		const onB = await eventually(async () => {
			const m = await messageWith(c.b, c.shared.id, uploaded.id);
			return m?.attachments[0]?.available ? m : undefined;
		}, "the file to arrive on B");
		expect(onB.attachments[0]).toMatchObject({ name: "report.txt", size: bytes.length, sha256: sha(bytes), originNodeId: c.aId, available: true });
		expect(onB.text).toContain("please read it");
		expect(blobsOf(c.b)).toEqual([sha(bytes)]);
		const served = await fetchBytes(c.b, c.shared.id, uploaded.id);
		expect(served.res.status).toBe(200);
		expect(served.bytes.equals(bytes)).toBe(true);
		expect(readdirSync(path.join(c.b.dataDir, "attachments", ".tmp"))).toEqual([]);

		// the message reached each agent with the folder-relative path, and the file is in that folder
		for (const [node, session, project] of [
			[c.b, c.sessionB, c.projectB],
			[c.a, c.sessionA, c.projectA],
		] as const) {
			await eventually(() => existsSync(path.join(project.path, "attachments", "report.txt")), `report.txt in the agent folder of ${project.id}`);
			expect(readFileSync(path.join(project.path, "attachments", "report.txt")).equals(bytes)).toBe(true);
			await eventually(async () => (await transcriptTexts(node, session)).some((t) => t.includes("attachments/report.txt")), "the agent prompt to name the copied file");
		}
		expect((await transcriptTexts(c.b, c.sessionB)).join("\n")).toContain("mesh_share_file");

		// the same name again is never overwritten
		const second = await uploadTo(c.a, c.shared.id, "report.txt", Buffer.from("second version"), "text/plain");
		await post(c.a, c.shared.id, { text: `again${QUIET}`, to: { mode: "all", agents: [] }, attachmentIds: [second.id] });
		await eventually(() => existsSync(path.join(c.projectB.path, "attachments", "report (2).txt")), "the second file under a suffixed name");
		expect(readFileSync(path.join(c.projectB.path, "attachments", "report.txt")).equals(bytes)).toBe(true);
		expect(readFileSync(path.join(c.projectB.path, "attachments", "report (2).txt"), "utf8")).toBe("second version");
	});

	it("a file with no text is a valid message; attachments are checked (unknown, already posted, no text and no file)", async () => {
		const c = (chat = await startChat());
		const file = await uploadTo(c.a, c.shared.id, "only.bin", Buffer.from([1, 2, 3]));
		const only = await post(c.a, c.shared.id, { text: "", attachmentIds: [file.id], to: { mode: "agents", agents: [] } });
		expect(only.status, JSON.stringify(only.body)).toBe(201);
		expect(only.body.text).toBe("");
		await eventually(async () => (await messageWith(c.b, c.shared.id, file.id))?.attachments[0]?.available, "the file-only message on B");
		expect((await post(c.a, c.shared.id, { text: "again", attachmentIds: [file.id] })).status).toBe(400);
		expect((await post(c.a, c.shared.id, { text: "x", attachmentIds: ["att_missing"] })).status).toBe(400);
		expect((await post(c.a, c.shared.id, { text: "" })).status).toBe(400);
		// B cannot post a file A uploaded
		const other = await uploadTo(c.a, c.shared.id, "mine.bin", Buffer.from("a"));
		expect((await post(c.b, c.shared.id, { text: "x", attachmentIds: [other.id] })).status).toBe(400);
	});

	it("above the eager limit the file is fetched when it is opened (streamed through, then stored); ranges wait for the whole file", async () => {
		const c = (chat = await startChat({ attachmentEagerMaxBytes: 64 }));
		const big = Buffer.from(Array.from({ length: 4000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(""));
		const small = Buffer.from("tiny");
		const bigUpload = await uploadTo(c.a, c.shared.id, "big.txt", big, "text/plain");
		const smallUpload = await uploadTo(c.a, c.shared.id, "small.txt", small, "text/plain");
		// addressed to A's own agent only: B's agent is not handed (and does not fetch) the files
		await post(c.a, c.shared.id, { text: "files", to: { mode: "agents", agents: [c.agentA] }, attachmentIds: [bigUpload.id, smallUpload.id] });
		await eventually(async () => (await messageWith(c.b, c.shared.id, smallUpload.id))?.attachments.find((a) => a.id === smallUpload.id)?.available, "the small file to arrive eagerly");
		const meta = (await messageWith(c.b, c.shared.id, bigUpload.id)) as SharedMessage;
		expect(meta.attachments.find((a) => a.id === bigUpload.id)).toMatchObject({ size: big.length, available: false });
		expect(blobsOf(c.b)).toEqual([sha(small)]);

		const first = await fetchBytes(c.b, c.shared.id, bigUpload.id);
		expect(first.res.status).toBe(200);
		expect(first.res.headers.get("content-length")).toBe(String(big.length));
		expect(first.res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(first.bytes.equals(big)).toBe(true);
		await eventually(async () => (await messageWith(c.b, c.shared.id, bigUpload.id))?.attachments.find((a) => a.id === bigUpload.id)?.available, "the opened file to be marked available");
		expect(blobsOf(c.b).sort()).toEqual([sha(big), sha(small)].sort());
		expect(readFileSync(path.join(c.b.dataDir, "attachments", sha(big))).equals(big)).toBe(true);
		const part = await fetchBytes(c.b, c.shared.id, bigUpload.id, { headers: { range: "bytes=100-199" } });
		expect(part.res.status).toBe(206);
		expect(part.bytes.equals(big.subarray(100, 200))).toBe(true);

		// a range into the middle of a file that is not here yet waits for the whole file and answers 206
		const later = await uploadTo(c.a, c.shared.id, "later.txt", Buffer.from("z".repeat(500) + "end"), "text/plain");
		await post(c.a, c.shared.id, { text: "more", to: { mode: "agents", agents: [c.agentA] }, attachmentIds: [later.id] });
		await eventually(async () => await messageWith(c.b, c.shared.id, later.id), "the metadata of the later file on B");
		const mid = await fetchBytes(c.b, c.shared.id, later.id, { headers: { range: "bytes=500-502" } });
		expect(mid.res.status).toBe(206);
		expect(mid.bytes.toString()).toBe("end");
	});

	it("refuses bytes that do not match the announced sha-256: nothing is stored, the file stays unavailable", async () => {
		const c = (chat = await startChat());
		const bytes = Buffer.from("genuine content, 28 bytes!!!");
		const uploaded = await uploadTo(c.a, c.shared.id, "tampered.txt", bytes, "text/plain");
		// the origin's stored copy is damaged (same size, other bytes) before anyone fetched it
		const blob = path.join(c.a.dataDir, "attachments", sha(bytes));
		writeFileSync(blob, Buffer.alloc(bytes.length, 0x58));
		await post(c.a, c.shared.id, { text: "here", to: { mode: "agents", agents: [] }, attachmentIds: [uploaded.id] });
		await eventually(() => messageWith(c.b, c.shared.id, uploaded.id), "the metadata on B");
		// opening it makes B ask A for the bytes: the answer fails verification
		const opened = await fetchBytes(c.b, c.shared.id, uploaded.id);
		expect(opened.res.status).toBeGreaterThanOrEqual(500);
		expect((await messageWith(c.b, c.shared.id, uploaded.id))?.attachments[0]?.available).toBe(false);
		expect(blobsOf(c.b)).toEqual([]);
	});

	it("a node that was offline fetches the file after it restarts (durable: found again from the database)", async () => {
		const c = (chat = await startChat());
		c.root.b = { dataDir: c.b.dataDir, netPort: c.b.netPort, secrets: c.b.ctx.secrets };
		await c.b.cleanup({ keepData: true });
		const bytes = Buffer.from("sent while B was away");
		const uploaded = await uploadTo(c.a, c.shared.id, "away.txt", bytes, "text/plain");
		await post(c.a, c.shared.id, { text: "for B", to: { mode: "agents", agents: [] }, attachmentIds: [uploaded.id] });
		c.b = await startNode("node-b", { dataDir: c.root.b.dataDir, port: c.root.b.netPort, secrets: c.root.b.secrets });
		c.root.b = null;
		const arrived = await eventually(async () => {
			const m = await messageWith(c.b, c.shared.id, uploaded.id);
			return m?.attachments[0]?.available ? m : undefined;
		}, "the file to reach the restarted B", 30_000);
		expect(arrived.attachments[0]?.sha256).toBe(sha(bytes));
		expect((await fetchBytes(c.b, c.shared.id, uploaded.id)).bytes.equals(bytes)).toBe(true);
	});

	it("saves a posted file into a local project folder; a taken name gets a suffix", async () => {
		const c = (chat = await startChat());
		const uploaded = await uploadTo(c.a, c.shared.id, "data.csv", Buffer.from("a,b\n1,2\n"), "text/csv");
		await post(c.a, c.shared.id, { text: "csv", to: { mode: "agents", agents: [] }, attachmentIds: [uploaded.id] });
		await eventually(async () => (await messageWith(c.b, c.shared.id, uploaded.id))?.attachments[0]?.available, "the csv on B");
		const save = (body: unknown) => api(c.b).post<FileEntry>(`/shared/${c.shared.id}/attachments/${uploaded.id}/save`, body);
		const first = await save({ projectId: c.projectB.id });
		expect(first.status, JSON.stringify(first.body)).toBe(201);
		expect(first.body).toMatchObject({ name: "data.csv", path: "attachments/data.csv", kind: "file", size: 8 });
		const again = await save({ projectId: c.projectB.id });
		expect(again.body.path).toBe("attachments/data (2).csv");
		const custom = await save({ projectId: c.projectB.id, path: "inputs/raw/sales.csv" });
		expect(custom.body.path).toBe("inputs/raw/sales.csv");
		expect(readFileSync(path.join(c.projectB.path, "inputs/raw/sales.csv"), "utf8")).toBe("a,b\n1,2\n");
		expect((await save({ projectId: "prj_nope" })).status).toBe(404);
		expect((await save({ projectId: c.projectB.id, path: "../out.csv" })).status).toBe(400);
		expect((await api(c.b).post(`/shared/${c.shared.id}/attachments/att_unknown/save`, { projectId: c.projectB.id })).status).toBe(404);
	});
});

describe("mesh_share_file", () => {
	const call = (node: FullHarness, sessionId: string, args: unknown) =>
		node.ctx.hostTools.execute({ sessionId, toolCallId: "t1", toolName: "mesh_share_file", arguments: args, signal: new AbortController().signal, update() {} });

	it("posts a file of the agent's working folder as an attachment message from that agent, replicated to B", async () => {
		const c = (chat = await startChat());
		mkdirSync(path.join(c.projectA.path, "out"), { recursive: true });
		const bytes = Buffer.from("# Summary\nall done\n");
		writeFileSync(path.join(c.projectA.path, "out", "summary.md"), bytes);
		const result = await call(c.a, c.sessionA, { path: "out/summary.md", caption: "Report ready" });
		expect(result.isError, result.text).toBeFalsy();
		expect(result.text).toContain("summary.md");

		const msg = await eventually(async () => (await detailOn(c.a, c.shared.id)).messages.find((m) => m.attachments.some((a) => a.name === "summary.md")), "the file message on A");
		expect(msg).toMatchObject({ kind: "note", text: "Report ready", author: { kind: "agent", nodeId: c.aId } });
		expect(msg.author.agentId).toBe(c.agentA.agentId);
		expect(msg.attachments[0]).toMatchObject({ mimeType: "text/markdown", size: bytes.length, sha256: sha(bytes), available: true });
		const onB = await eventually(async () => {
			const m = await messageWith(c.b, c.shared.id, msg.attachments[0]?.id as string);
			return m?.attachments[0]?.available ? m : undefined;
		}, "the agent's file on B");
		expect(onB.author).toMatchObject({ kind: "agent", nodeId: c.aId });
		expect((await fetchBytes(c.b, c.shared.id, msg.attachments[0]?.id as string)).bytes.equals(bytes)).toBe(true);
		// the file the agent shared is a snapshot: later edits stay local
		writeFileSync(path.join(c.projectA.path, "out", "summary.md"), "changed");
		expect((await fetchBytes(c.a, c.shared.id, msg.attachments[0]?.id as string)).bytes.equals(bytes)).toBe(true);
		// an absolute path inside the folder works too
		const absolute = await call(c.a, c.sessionA, { path: path.join((await projectOf(c.a, c.sessionA)).path, "out", "summary.md") });
		expect(absolute.isError, absolute.text).toBeFalsy();
	});

	it("an agent can call it in a real turn (host tool round trip through the runtime)", async () => {
		const c = (chat = await startChat());
		await whenSettled(c.a, c.sessionA);
		const res = await post(c.a, c.shared.id, { text: 'make it\n@@fake-sh printf "from the agent" > made.txt\n@@fake-tool mesh_share_file {"path":"made.txt","caption":"made it"}', to: { mode: "lead", agents: [] } });
		expect(res.status).toBe(201);
		const msg = await eventually(async () => (await detailOn(c.b, c.shared.id)).messages.find((m) => m.attachments.some((a) => a.name === "made.txt")), "the agent's file to reach B", 30_000);
		expect(msg).toMatchObject({ text: "made it", author: { kind: "agent", nodeId: c.aId } });
	});

	it("refuses paths outside the folder, folders, missing files, the .git directory and sessions that are not in a shared session", async () => {
		const c = (chat = await startChat());
		const outside = path.join(c.a.dataDir, "outside.txt");
		writeFileSync(outside, "secret");
		extraDirs.push(path.join(c.a.dataDir, "sibling"));
		mkdirSync(path.join(c.projectA.path, ".git"));
		writeFileSync(path.join(c.projectA.path, ".git", "config"), "x");
		mkdirSync(path.join(c.projectA.path, "dir"));
		for (const bad of ["../outside.txt", outside, "dir", "missing.md", ".git/config", ""]) {
			const result = await call(c.a, c.sessionA, { path: bad });
			expect(result.isError, `${bad} should be refused: ${result.text}`).toBe(true);
		}
		const lone = await api(c.a).post<AgentSession>("/sessions", { title: "Alone" });
		writeFileSync(path.join((await projectOf(c.a, lone.body.id)).path, "x.txt"), "x");
		const notShared = await call(c.a, lone.body.id, { path: "x.txt" });
		expect(notShared.isError).toBe(true);
		expect(notShared.text).toContain("shared session");
		expect((await call(c.a, c.sessionA, { path: "x", extra: 1 })).isError).toBe(true);
		const detail = await detailOn(c.a, c.shared.id);
		expect(detail.messages.filter((m) => m.attachments.length > 0)).toEqual([]);
	});
});

describe("the attachment wire route", () => {
	it("serves a stored file to an active member with its digest, refuses unsigned callers, other sessions and unknown ids", async () => {
		const c = (chat = await startChat());
		const bytes = Buffer.from("wire bytes");
		const uploaded = await uploadTo(c.a, c.shared.id, "w.bin", bytes);
		await post(c.a, c.shared.id, { text: "w", to: { mode: "agents", agents: [] }, attachmentIds: [uploaded.id] });
		const ok = await signedRequest(c.b, c.a.netUrl, { path: `/shared/${c.shared.id}/attachments/${uploaded.id}` });
		expect(ok.status).toBe(200);
		expect(ok.text).toBe("wire bytes");
		expect(ok.headers.get("content-digest")).toBe(`sha-256=:${Buffer.from(sha(bytes), "hex").toString("base64")}:`);
		expect((await fetch(`${c.a.netUrl}/api/v1/shared/${c.shared.id}/attachments/${uploaded.id}`)).status).toBeGreaterThanOrEqual(400);
		expect((await signedRequest(c.b, c.a.netUrl, { path: `/shared/${c.shared.id}/attachments/att_unknown` })).status).toBe(404);
		expect((await signedRequest(c.b, c.a.netUrl, { path: `/shared/shs_other/attachments/${uploaded.id}` })).status).toBe(404);
	});
});

describe("images in a group chat reach the model as vision input", () => {
	// A real 1×1 PNG; and bytes that only claim to be one.
	const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
	const fakePrompts = (node: FullHarness): Array<Record<string, any>> =>
		readFileSync(node.fakeLog, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { kind: string; frame?: Record<string, any> })
			.filter((r) => r.kind === "command" && r.frame?.type === "prompt" && String(r.frame.message).includes("Attached files"))
			.map((r) => r.frame as Record<string, any>);

	it("an image posted on A is handed to the agent on B as an image (bytes are local after replication) and by path; fakes and oversize stay path-only", async () => {
		const c = (chat = await startChat());
		const shot = await uploadTo(c.a, c.shared.id, "shot.png", PNG, "image/png");
		const fake = await uploadTo(c.a, c.shared.id, "fake.png", Buffer.from("not an image at all"), "image/png");
		const huge = await uploadTo(c.a, c.shared.id, "huge.png", Buffer.concat([PNG, Buffer.alloc(800 * 1024)]), "image/png");
		const posted = await post(c.a, c.shared.id, { text: `what is in the picture?${QUIET}`, to: { mode: "all", agents: [] }, attachmentIds: [shot.id, fake.id, huge.id] });
		expect(posted.status, JSON.stringify(posted.body)).toBe(201);

		for (const node of [c.b, c.a]) {
			const prompt = await eventually(() => fakePrompts(node)[0], `the injected prompt on ${node === c.a ? "A" : "B"}`);
			expect(prompt.images, "only the real, small image is vision input").toEqual([{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }]);
			expect(prompt.message).toContain("attachments/shot.png (image/png, 70 B; also attached to this message as an image you can see)");
			expect(prompt.message).toMatch(/attachments\/fake\.png \(image\/png, \d+ B\)\n/);
			expect(prompt.message).toMatch(/attachments\/huge\.png \(image\/png, [\d.]+ [KM]i?B\)\n/);
		}
		// the copy in the agent's folder is still there for tools
		expect(readFileSync(path.join(c.projectB.path, "attachments", "shot.png")).equals(PNG)).toBe(true);
	});

	it("an image addressed to one agent is vision input for that agent only, even when its node had to pull the bytes first", async () => {
		const c = (chat = await startChat({ attachmentEagerMaxBytes: 16 }));
		const shot = await uploadTo(c.a, c.shared.id, "late.png", Buffer.concat([PNG, Buffer.alloc(200)]), "image/png");
		await post(c.a, c.shared.id, { text: `look${QUIET}`, to: { mode: "agents", agents: [c.agentB] }, attachmentIds: [shot.id] });
		const prompt = await eventually(() => fakePrompts(c.b)[0], "the injected prompt on B");
		expect(prompt.images).toHaveLength(1);
		expect(prompt.images[0].data).toBe(Buffer.concat([PNG, Buffer.alloc(200)]).toString("base64"));
		expect(fakePrompts(c.a)).toHaveLength(0);
	});
});
