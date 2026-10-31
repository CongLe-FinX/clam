import type { SharedMessage, SharedMessagesPage, SharedSessionDetail } from "@clam/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { api, type FullHarness } from "./full-harness.ts";
import { eventually } from "./net-helpers.ts";
import { startChat, stopChat, type Chat } from "./shared-chat-fixtures.ts";
import { detailOn } from "./shared-fixtures.ts";

/**
 * The group log in pages: `GET /shared/:id/messages?before&limit` and `GET /shared/:id?messageLimit=N`. Pages cover the whole log
 * with no gap and no duplicate, in the order every node shows (hlc, origin node, id), and a cursor keeps pointing at the same
 * place while new messages arrive.
 */

let chat: Chat | undefined;
afterEach(async () => {
	if (chat) await stopChat(chat);
	chat = undefined;
});

const say = async (node: FullHarness, sharedId: string, text: string, extra: Record<string, unknown> = {}): Promise<SharedMessage> => {
	// Addressed to nobody's agent: pure log traffic, no turns
	const res = await api(node).post<SharedMessage>(`/shared/${sharedId}/messages`, { text, to: { mode: "agents", agents: [] }, ...extra });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body;
};

const page = async (node: FullHarness, sharedId: string, query: string): Promise<SharedMessagesPage> => {
	const res = await api(node).get<SharedMessagesPage>(`/shared/${sharedId}/messages${query}`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body;
};

/** Walk back from the newest page to the start of the log; returns the pages newest first. */
async function walk(node: FullHarness, sharedId: string, limit: number): Promise<SharedMessagesPage[]> {
	const pages: SharedMessagesPage[] = [];
	let cursor: string | null = null;
	do {
		const next: SharedMessagesPage = await page(node, sharedId, `?limit=${limit}${cursor ? `&before=${cursor}` : ""}`);
		pages.push(next);
		cursor = next.nextCursor;
	} while (cursor && pages.length < 200);
	return pages;
}

describe("paged group log", () => {
	it("pages cover the whole log without gaps or duplicates, on both nodes, in the order of the full detail", async () => {
		const c = (chat = await startChat());
		for (let i = 0; i < 26; i++) await say(i % 2 === 0 ? c.a : c.b, c.shared.id, `message ${i}`);
		await eventually(async () => (await detailOn(c.a, c.shared.id)).messages.filter((m) => m.text.startsWith("message ")).length === 26 && (await detailOn(c.b, c.shared.id)).messages.filter((m) => m.text.startsWith("message ")).length === 26, "all messages on both nodes");

		for (const node of [c.a, c.b]) {
			const full = (await detailOn(node, c.shared.id)).messages;
			expect(full.length).toBeGreaterThan(26); // plus the join notes
			for (const limit of [1, 7, 10, 200]) {
				const pages = await walk(node, c.shared.id, limit);
				const ids = [...pages].reverse().flatMap((p) => p.messages.map((m) => m.id));
				expect(ids).toEqual(full.map((m) => m.id));
				expect(new Set(ids).size).toBe(ids.length);
				expect(pages.slice(0, -1).every((p) => p.messages.length === limit && p.nextCursor !== null)).toBe(true);
				expect(pages.at(-1)?.nextCursor).toBeNull();
				// each page is ascending inside, and the first page is the newest messages
				expect(pages[0]?.messages.at(-1)?.id).toBe(full.at(-1)?.id);
			}
		}
	});

	it("without a cursor it is the newest page; the default size is 50; an empty-looking log pages cleanly", async () => {
		const c = (chat = await startChat());
		const small = await page(c.a, c.shared.id, "");
		const full = (await detailOn(c.a, c.shared.id)).messages;
		expect(small.messages.map((m) => m.id)).toEqual(full.slice(-50).map((m) => m.id));
		expect(small.nextCursor).toBeNull(); // the whole (short) log fits
		for (let i = 0; i < 55; i++) await say(c.a, c.shared.id, `bulk ${i}`);
		const newest = await page(c.a, c.shared.id, "");
		expect(newest.messages).toHaveLength(50);
		expect(newest.nextCursor).not.toBeNull();
		expect(newest.messages.at(-1)?.text).toBe("bulk 54");
	});

	it("GET /shared/:id?messageLimit=N returns the newest N plus the cursor of the older ones; without it the whole log as before", async () => {
		const c = (chat = await startChat());
		for (let i = 0; i < 15; i++) await say(c.a, c.shared.id, `m${i}`);
		const whole = (await api(c.a).get<SharedSessionDetail>(`/shared/${c.shared.id}`)).body;
		expect(whole.messagesCursor).toBeUndefined();
		const limited = (await api(c.a).get<SharedSessionDetail>(`/shared/${c.shared.id}?messageLimit=6`)).body;
		expect(limited.messages.map((m) => m.id)).toEqual(whole.messages.slice(-6).map((m) => m.id));
		expect(limited.messagesCursor).toEqual(expect.any(String));
		expect(limited.shared.id).toBe(whole.shared.id);
		expect(limited.checkpoints).toEqual(whole.checkpoints);
		// following the cursor yields exactly the rest
		const rest: string[] = [];
		let cursor: string | null = limited.messagesCursor ?? null;
		while (cursor) {
			const next: SharedMessagesPage = await page(c.a, c.shared.id, `?limit=5&before=${cursor}`);
			rest.unshift(...next.messages.map((m) => m.id));
			cursor = next.nextCursor;
		}
		expect([...rest, ...limited.messages.map((m) => m.id)]).toEqual(whole.messages.map((m) => m.id));
		// a limit larger than the log: everything, no cursor
		const all = (await api(c.a).get<SharedSessionDetail>(`/shared/${c.shared.id}?messageLimit=500`)).body;
		expect(all.messages).toHaveLength(whole.messages.length);
		expect(all.messagesCursor).toBeNull();
	});

	it("a cursor stays put when new messages arrive (local and from the other node)", async () => {
		const c = (chat = await startChat());
		for (let i = 0; i < 20; i++) await say(c.a, c.shared.id, `old ${i}`);
		const first = await page(c.a, c.shared.id, "?limit=8");
		const expected = (await page(c.a, c.shared.id, `?limit=8&before=${first.nextCursor}`)).messages.map((m) => m.id);
		for (let i = 0; i < 5; i++) await say(c.a, c.shared.id, `new local ${i}`);
		await say(c.b, c.shared.id, "new from b");
		await eventually(async () => (await detailOn(c.a, c.shared.id)).messages.some((m) => m.text === "new from b"), "B's message on A");
		const second = await page(c.a, c.shared.id, `?limit=8&before=${first.nextCursor}`);
		expect(second.messages.map((m) => m.id)).toEqual(expected);
		const seen = new Set(first.messages.map((m) => m.id));
		expect(second.messages.some((m) => seen.has(m.id))).toBe(false);
		// the newest page now holds the new messages
		const newest = await page(c.a, c.shared.id, "?limit=8");
		expect(newest.messages.map((m) => m.text)).toEqual(expect.arrayContaining(["new local 4", "new from b"]));
	});

	it("pages carry attachments exactly like the detail does", async () => {
		const c = (chat = await startChat());
		const upload = await fetch(`${c.a.url}/api/local/shared/${c.shared.id}/attachments?name=plan.pdf`, { method: "POST", headers: { "content-type": "application/pdf" }, body: Buffer.from("%PDF fake") });
		expect(upload.status).toBe(201);
		const file = (await upload.json()) as { id: string };
		const withFile = await say(c.a, c.shared.id, "the plan", { attachmentIds: [file.id] });
		for (let i = 0; i < 3; i++) await say(c.a, c.shared.id, `after ${i}`);
		const full = (await detailOn(c.a, c.shared.id)).messages;
		const fromDetail = full.find((m) => m.id === withFile.id);
		const pages = await walk(c.a, c.shared.id, 2);
		const fromPage = pages.flatMap((p) => p.messages).find((m) => m.id === withFile.id);
		expect(fromPage).toEqual(fromDetail);
		expect(fromPage?.attachments).toMatchObject([{ id: file.id, name: "plan.pdf", mimeType: "application/pdf", available: true }]);
		// the same on the node that received it
		await eventually(async () => (await detailOn(c.b, c.shared.id)).messages.find((m) => m.id === withFile.id)?.attachments[0]?.available, "the plan on B");
		const onB = (await walk(c.b, c.shared.id, 3)).flatMap((p) => p.messages).find((m) => m.id === withFile.id);
		expect(onB).toEqual((await detailOn(c.b, c.shared.id)).messages.find((m) => m.id === withFile.id));
	});

	it("validates: garbage and foreign cursors, limits out of range, unknown sessions", async () => {
		const c = (chat = await startChat());
		const get = (query: string, id = c.shared.id) => api(c.a).get(`/shared/${id}/messages${query}`);
		expect((await get("?before=not-a-cursor")).status).toBe(400);
		expect((await get(`?before=${Buffer.from("[1,2]").toString("base64url")}`)).status).toBe(400);
		expect((await get(`?before=${Buffer.from('["a","b",3]').toString("base64url")}`)).status).toBe(400);
		expect((await get(`?before=${Buffer.from("{}").toString("base64url")}`)).status).toBe(400);
		expect((await get("?limit=0")).status).toBe(400);
		expect((await get("?limit=201")).status).toBe(400);
		expect((await get("?limit=abc")).status).toBe(400);
		expect((await get("?limit=200")).status).toBe(200);
		expect((await get("", "shs_unknown")).status).toBe(404);
		expect((await api(c.a).get(`/shared/${c.shared.id}?messageLimit=0`)).status).toBe(400);
		// a well-formed cursor that points before everything yields an empty page, not an error
		const before = Buffer.from(JSON.stringify(["000000000000000-00000", "n", "i"])).toString("base64url");
		expect(await page(c.a, c.shared.id, `?before=${before}`)).toEqual({ messages: [], nextCursor: null });
	});
});
