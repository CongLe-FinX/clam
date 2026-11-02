import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SharedMessage } from "@clam/contracts";
import { ATTACHMENT_EAGER_MAX_BYTES } from "@clam/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { api, type FullHarness } from "./full-harness.ts";
import { eventually } from "./net-helpers.ts";
import { startChat, stopChat, type Chat } from "./shared-chat-fixtures.ts";
import { detailOn } from "./shared-fixtures.ts";

/**
 * The files a turn produces in the agent's working folder are attached to the reply the turn posts to the group chat
 * (images, video, audio, PDF, office files, csv/text; at most 10, none above the eager-replication limit, none twice) and
 * replicate to the other node exactly like a person's uploads. The agents are real (fake omp) and run shell directives.
 */

const sha = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
// A sparse file just above the eager limit: it costs no disk and is never read, because the size alone excludes it.
const BIG = ATTACHMENT_EAGER_MAX_BYTES + 1;

let chat: Chat | undefined;
afterEach(async () => {
	if (chat) await stopChat(chat);
	chat = undefined;
});

const repliesOf = async (node: FullHarness, sharedId: string, authorNodeId: string): Promise<SharedMessage[]> =>
	(await detailOn(node, sharedId)).messages.filter((m) => m.kind === "reply" && m.author.nodeId === authorNodeId);

/** A human on A asks the lead agent (A) or B's agent to run shell commands; resolves with the NEW reply that agent posts. */
async function ask(c: Chat, who: "a" | "b", commands: string[]): Promise<SharedMessage> {
	const author = who === "a" ? c.aId : c.bId;
	const known = new Set((await repliesOf(c.a, c.shared.id, author)).map((m) => m.id));
	const to = who === "a" ? { mode: "lead", agents: [] } : { mode: "agents", agents: [c.agentB] };
	const res = await api(c.a).post<SharedMessage>(`/shared/${c.shared.id}/messages`, { text: ["please make files", ...commands.map((x) => `@@fake-sh ${x}`)].join("\n"), to });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return eventually(async () => (await repliesOf(c.a, c.shared.id, author)).find((m) => !known.has(m.id)), `the reply of agent ${who}`, 30_000);
}

describe("files of a turn on the reply posted to the group chat", () => {
	it("an image the agent made becomes an attachment of its reply and replicates to the other node", async () => {
		const c = (chat = await startChat());
		const png = "\u0089PNG fake bytes";
		const reply = await ask(c, "a", [`printf '${png}' > chart.png`]);
		expect(reply.author).toMatchObject({ kind: "agent", nodeId: c.aId });
		expect(reply.attachments).toHaveLength(1);
		expect(reply.attachments[0]).toMatchObject({ name: "chart.png", mimeType: "image/png", originNodeId: c.aId, available: true });
		expect(reply.attachments[0]?.sha256).toBe(sha(Buffer.from(png, "utf8")));
		const onB = await eventually(async () => {
			const m = (await detailOn(c.b, c.shared.id)).messages.find((x) => x.id === reply.id);
			return m?.attachments[0]?.available ? m : undefined;
		}, "the reply and its image on B");
		expect(onB.attachments[0]).toMatchObject({ id: reply.attachments[0]?.id, name: "chart.png", sha256: reply.attachments[0]?.sha256, available: true });
		const served = await fetch(`${c.b.url}/api/local/shared/${c.shared.id}/attachments/${onB.attachments[0]?.id}`);
		expect(served.status).toBe(200);
		expect(Buffer.from(await served.arrayBuffer()).toString("utf8")).toBe(png);
	});

	it("a participant's agent attaches its files too, and they reach the lead's node", async () => {
		const c = (chat = await startChat());
		const reply = await ask(c, "b", ["printf 'col\\n1\\n' > numbers.csv"]);
		expect(reply.author).toMatchObject({ kind: "agent", nodeId: c.bId });
		expect(reply.attachments.map((a) => [a.name, a.mimeType, a.originNodeId])).toEqual([["numbers.csv", "text/csv", c.bId]]);
		await eventually(async () => (await detailOn(c.a, c.shared.id)).messages.find((m) => m.id === reply.id)?.attachments[0]?.available, "B's file on A");
	});

	it("posts at most 10 files, most showable first (images, video, PDF, office, audio, csv/text), none above the replication limit, never archives or code", async () => {
		const c = (chat = await startChat());
		const images = Array.from({ length: 11 }, (_, i) => `img-${String(i + 1).padStart(2, "0")}.png`);
		const reply = await ask(c, "a", [
			`for f in ${images.join(" ")}; do printf "$f" > $f; done`,
			"printf v > clip.mp4",
			"printf z > bundle.zip",
			"printf c > code.ts",
			`dd if=/dev/null of=big.mp4 bs=1 count=0 seek=${BIG} 2>/dev/null`,
		]);
		expect(reply.attachments.map((a) => a.name)).toEqual(images.slice(0, 10));
		// what stayed behind is still in the agent's folder and in the turn's stored outputs (not posted to the group)
		const stored = (await api(c.a).get<{ outputs: Array<{ files: Array<{ name: string }> }> }>(`/sessions/${c.sessionA}/outputs`)).body.outputs.flatMap((o) => o.files.map((f) => f.name));
		expect(stored).toEqual(expect.arrayContaining(["big.mp4", "bundle.zip", "code.ts", "clip.mp4", "img-11.png"]));
	});

	it("orders what is left: image, video, PDF, office, audio, then csv/markdown/text", async () => {
		const c = (chat = await startChat());
		const reply = await ask(c, "a", ["printf d > notes.md", "printf s > sheet.csv", "printf a > voice.mp3", "printf w > report.docx", "printf p > report.pdf", "printf m > clip.webm", "printf i > pic.jpg"]);
		expect(reply.attachments.map((a) => a.name)).toEqual(["pic.jpg", "clip.webm", "report.pdf", "report.docx", "voice.mp3", "notes.md", "sheet.csv"]);
	});

	it("does not post a file twice: the one the agent already shared with mesh_share_file is not repeated on the reply", async () => {
		const c = (chat = await startChat());
		const known = new Set((await repliesOf(c.a, c.shared.id, c.aId)).map((m) => m.id));
		const res = await api(c.a).post(`/shared/${c.shared.id}/messages`, {
			text: ['go', '@@fake-sh printf "same bytes" > made.png', '@@fake-sh printf "other" > extra.png', '@@fake-tool mesh_share_file {"path":"made.png","caption":"shared on purpose"}'].join("\n"),
			to: { mode: "lead", agents: [] },
		});
		expect(res.status).toBe(201);
		const reply = await eventually(async () => (await repliesOf(c.a, c.shared.id, c.aId)).find((m) => !known.has(m.id)), "the reply", 30_000);
		const all = (await detailOn(c.a, c.shared.id)).messages;
		const withMade = all.filter((m) => m.attachments.some((a) => a.name === "made.png"));
		expect(withMade).toHaveLength(1);
		expect(withMade[0]).toMatchObject({ kind: "note", text: "shared on purpose" });
		expect(reply.attachments.map((a) => a.name)).toEqual(["extra.png"]);
	});

	it("does not echo a file of the group back: a group file copied into the folder while the agent works is not re-posted", async () => {
		const c = (chat = await startChat());
		const bytes = Buffer.from("from the human");
		const uploaded = await fetch(`${c.a.url}/api/local/shared/${c.shared.id}/attachments?name=human.png`, { method: "POST", headers: { "content-type": "image/png" }, body: bytes });
		expect(uploaded.status).toBe(201);
		const att = (await uploaded.json()) as { id: string };
		const known = new Set((await repliesOf(c.a, c.shared.id, c.aId)).map((m) => m.id));
		const res = await api(c.a).post(`/shared/${c.shared.id}/messages`, { text: "look at this image", to: { mode: "lead", agents: [] }, attachmentIds: [att.id] });
		expect(res.status).toBe(201);
		const reply = await eventually(async () => (await repliesOf(c.a, c.shared.id, c.aId)).find((m) => !known.has(m.id)), "the reply", 30_000);
		// the copy sits in attachments/ but was there before the turn started anyway; either way it is not part of the reply
		expect(reply.attachments).toEqual([]);
		expect((await detailOn(c.a, c.shared.id)).messages.filter((m) => m.attachments.some((a) => a.name === "human.png"))).toHaveLength(1);
	});

	it("a turn without files posts the same reply as before (no attachments)", async () => {
		const c = (chat = await startChat());
		const reply = await ask(c, "a", ["true"]);
		expect(reply.attachments).toEqual([]);
		expect(reply.text).toContain("FAKE_TOOL_RESULT sh: exit=0");
	});
});

describe("a reply without text but with files", () => {
	// The fake agent always answers with text, so the turn's events are driven by hand on the real services.
	it("still posts; a run that answers nothing for the group forgets its files", async () => {
		const c = (chat = await startChat());
		const outputs = c.a.ctx.turnOutputs as unknown as { onEvent(sessionId: string, event: unknown): void };
		const discussion = c.a.ctx.shared.discussion as unknown as { postReply(sessionId: string, run: { answered: boolean; finalText: string | null; posted: ReadonlySet<string> }): Promise<void> };
		const turn = async (name: string): Promise<void> => {
			outputs.onEvent(c.sessionA, { type: "agent_start" });
			// the start snapshot is a real directory walk without a completion signal; give it a moment before the file appears
			await new Promise((resolve) => setTimeout(resolve, 100));
			writeFileSync(path.join(c.projectA.path, name), `bytes of ${name}`);
			outputs.onEvent(c.sessionA, { type: "agent_end" });
		};
		await turn("silent.png");
		await discussion.postReply(c.sessionA, { answered: false, finalText: null, posted: new Set() });
		expect((await detailOn(c.a, c.shared.id)).messages.filter((m) => m.attachments.some((a) => a.name === "silent.png"))).toEqual([]);
		// nothing of the silent run is left for the next one
		await turn("loud.png");
		await discussion.postReply(c.sessionA, { answered: true, finalText: null, posted: new Set() });
		const posted = (await detailOn(c.a, c.shared.id)).messages.filter((m) => m.attachments.length > 0);
		expect(posted).toHaveLength(1);
		expect(posted[0]).toMatchObject({ kind: "reply", text: "", author: { kind: "agent", nodeId: c.aId } });
		expect(posted[0]?.attachments.map((a) => a.name)).toEqual(["loud.png"]);
		// no text and no showable file: nothing is posted
		const before = (await detailOn(c.a, c.shared.id)).messages.length;
		await discussion.postReply(c.sessionA, { answered: true, finalText: null, posted: new Set() });
		expect((await detailOn(c.a, c.shared.id)).messages).toHaveLength(before);
	});
});

describe("files the reply's markdown points at", () => {
	// Driven on the real services: the fake agent cannot write a markdown final text with images.
	it("are attached even in dot-folders or made before the run, on every reply that shows them", async () => {
		const c = (chat = await startChat());
		const discussion = c.a.ctx.shared.discussion as unknown as { postReply(sessionId: string, run: { answered: boolean; finalText: string | null; posted: ReadonlySet<string> }): Promise<void> };
		const put = (rel: string): void => {
			mkdirSync(path.dirname(path.join(c.projectA.path, rel)), { recursive: true });
			writeFileSync(path.join(c.projectA.path, rel), `bytes of ${rel}`);
		};
		for (const rel of [".dev/shots/flow.png", "docs/old.png", "code.png", "src/main.ts", "out/app.zip"]) put(rel);
		const reply = async (finalText: string): Promise<SharedMessage> => {
			const known = new Set((await detailOn(c.a, c.shared.id)).messages.map((m) => m.id));
			await discussion.postReply(c.sessionA, { answered: true, finalText, posted: new Set() });
			const added = (await detailOn(c.a, c.shared.id)).messages.filter((m) => !known.has(m.id));
			expect(added).toHaveLength(1);
			return added[0] as SharedMessage;
		};
		const text = [
			"1. Flow: ![flow](.dev/shots/flow.png)",
			'2. Old: ![old](./docs/old.png "title"), source in [main](src/main.ts)',
			"Not attached: `![x](code.png)` (code), [bundle](out/app.zip) (archive), [site](https://example.com/a.png), [top](#flow), ![gone](missing.png)",
		].join("\n");
		const first = await reply(text);
		expect(first.attachments.map((a) => a.name)).toEqual(["flow.png", "old.png", "main.ts"]);
		// a later reply that shows the same image again carries it again: the group renders a message's images from its own files
		const again = await reply("Still: ![old](docs/old.png)");
		expect(again.attachments.map((a) => a.name)).toEqual(["old.png"]);
	});
});
