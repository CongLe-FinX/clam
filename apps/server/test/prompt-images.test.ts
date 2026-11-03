import { existsSync, readFileSync } from "node:fs";
import type { AgentSession, MessagesPage, Project, Workspace } from "@clam/contracts";
import { PROMPT_IMAGES_MAX_BASE64_BYTES, PROMPT_IMAGES_MAX_COUNT } from "@clam/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, connectWs, createFullHarness, type FullHarness, type WsClient } from "./full-harness.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]).toString("base64");

let full: FullHarness;
let http: ReturnType<typeof api>;
let session: AgentSession;
const sockets: WsClient[] = [];

beforeEach(async () => {
	full = await createFullHarness();
	http = api(full);
	const workspace = (await http.post<Workspace>("/workspaces", { name: "W" })).body;
	const project = (await http.post<Project>("/projects", { workspaceId: workspace.id, name: "P", path: full.projectDir })).body;
	session = (await http.post<AgentSession>("/sessions", { projectId: project.id })).body;
});
afterEach(async () => {
	for (const ws of sockets.splice(0)) ws.close();
	await full.cleanup();
});

function fakePrompts(): Array<Record<string, any>> {
	if (!existsSync(full.fakeLog)) return [];
	return readFileSync(full.fakeLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { kind: string; frame?: Record<string, any> })
		.filter((r) => r.kind === "command" && r.frame?.type === "prompt")
		.map((r) => r.frame as Record<string, any>);
}

const prompt = (body: Record<string, unknown>) => http.post<any>(`/sessions/${session.id}/prompt`, { message: "what is this?", clientId: `c${Math.random()}`, ...body });

describe("prompt images (vision input)", () => {
	it("passes the images to the agent as OMP image content and keeps them in the transcript", async () => {
		const ws = await connectWs(full);
		sockets.push(ws);
		ws.send({ type: "subscribe", topics: [`session:${session.id}`] });
		await ws.waitFor((f) => f.type === "subscribed", "subscribed");

		const res = await prompt({ images: [{ mimeType: "image/png", data: PNG }, { mimeType: "image/jpeg", data: JPEG }] });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		await ws.waitFor((f) => f.topic === `session:${session.id}` && f.event.type === "settled", "settled");

		expect(fakePrompts()[0]).toMatchObject({
			message: "what is this?",
			images: [
				{ type: "image", mimeType: "image/png", data: PNG },
				{ type: "image", mimeType: "image/jpeg", data: JPEG },
			],
		});
		const users = ws.frames.filter((f) => f.topic === `session:${session.id}` && f.event.type === "message_start" && f.event.message.role === "user");
		expect(users[0]?.event.message.content.map((b: { type: string }) => b.type)).toEqual(["text", "image", "image"]);
		const page = (await http.get<MessagesPage>(`/sessions/${session.id}/messages`)).body;
		expect(page.messages[0]?.content.map((b) => b.type)).toEqual(["text", "image", "image"]);
		// The page carries no base64: each picture is a URL that serves the original bytes with its type.
		const images = (page.messages[0]?.content ?? []).filter((b) => b.type === "image");
		expect(images.map((b) => b.data)).toEqual(["", ""]);
		for (const [i, [type, data]] of ([["image/png", PNG], ["image/jpeg", JPEG]] as const).entries()) {
			const res = await fetch(`${full.url}${images[i]?.url}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe(type);
			expect(Buffer.from(await res.arrayBuffer()).toString("base64")).toBe(data);
		}
		expect((await fetch(`${full.url}/api/local/sessions/${session.id}/messages/nope/images/1`)).status).toBe(404);
	});

	it("rejects a bad type, too many images, too much data and bytes that are not the announced type", async () => {
		expect((await prompt({ images: [{ mimeType: "image/svg+xml", data: PNG }] })).status).toBe(400);
		expect((await prompt({ images: [{ mimeType: "application/pdf", data: PNG }] })).status).toBe(400);
		expect((await prompt({ images: [{ mimeType: "image/png", data: "not base64!" }] })).status).toBe(400);
		expect((await prompt({ images: [{ mimeType: "image/png", data: "" }] })).status).toBe(400);
		expect((await prompt({ images: Array.from({ length: PROMPT_IMAGES_MAX_COUNT + 1 }, () => ({ mimeType: "image/png", data: PNG })) })).status).toBe(400);
		expect((await prompt({ images: Array.from({ length: PROMPT_IMAGES_MAX_COUNT }, () => ({ mimeType: "image/png", data: PNG })) })).status).toBe(202);

		const oversize = "A".repeat(PROMPT_IMAGES_MAX_BASE64_BYTES / 2 + 4);
		expect((await prompt({ images: [{ mimeType: "image/png", data: oversize }, { mimeType: "image/png", data: oversize }] })).status).toBe(400);
		expect((await prompt({ images: [{ mimeType: "image/png", data: "A".repeat(PROMPT_IMAGES_MAX_BASE64_BYTES + 4) }] })).status).toBe(400);

		const mislabeled = await prompt({ images: [{ mimeType: "image/jpeg", data: PNG }] });
		expect(mislabeled.status).toBe(400);
		expect(mislabeled.body.error.message).toBe("Image 1 is not a valid image/jpeg file");
		expect(mislabeled.body.error.i18n).toEqual({ key: "Image {number} is not a valid {type} file", params: { number: 1, type: "image/jpeg" } });
		// only the accepted prompt reached the agent
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(fakePrompts()).toHaveLength(1);
	});

	it("keeps the images of a steering message sent while the agent is running", async () => {
		const ws = await connectWs(full);
		sockets.push(ws);
		ws.send({ type: "subscribe", topics: [`session:${session.id}`] });
		await ws.waitFor((f) => f.type === "subscribed", "subscribed");
		expect((await prompt({ message: "__slow__" })).status).toBe(202);
		await ws.waitFor((f) => f.topic === `session:${session.id}` && f.event.type === "agent_start", "agent_start");
		const steer = await prompt({ message: "look at this instead", streamingBehavior: "steer", images: [{ mimeType: "image/png", data: PNG }] });
		expect(steer.status, JSON.stringify(steer.body)).toBe(202);
		expect(fakePrompts().map((p) => [p.streamingBehavior, p.images?.length])).toEqual([[undefined, undefined], ["steer", 1]]);
		await http.post(`/sessions/${session.id}/abort`);
	});
});
