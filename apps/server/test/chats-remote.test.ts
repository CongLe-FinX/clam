import { request } from "node:http";
import type { AgentSession, FileEntry, Project } from "@clam/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "./full-harness.ts";
import { PASSWORD, PUBLIC_HOST, PUBLIC_ORIGIN, cookiePair, raw, remoteNode, type RemoteNode } from "./remote-helpers.ts";

/** The file routes of a chat folder, driven the way a browser on the node's public domain does: owner cookie, public Origin. */

let rn: RemoteNode;
let cookie: string;
let project: Project;
const bytes = Buffer.from("0123456789abcdefghij");

/** One request with a binary body to the PUBLIC listener. */
function send(method: string, path: string, body: Buffer, headers: Record<string, string>): Promise<{ status: number; text: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string }>();
	const req = request({ host: "127.0.0.1", port: rn.port, method, path, headers: { Host: PUBLIC_HOST, "Content-Length": String(body.length), ...headers }, agent: false }, (res) => {
		const chunks: Buffer[] = [];
		res.on("data", (c: Buffer) => chunks.push(c));
		res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
	});
	req.on("error", reject);
	req.end(body);
	return promise;
}

beforeAll(async () => {
	rn = await remoteNode();
	expect((await api(rn.n).put("/access/password", { password: PASSWORD })).status).toBe(200);
	expect((await api(rn.n).patch("/access", { remoteUiEnabled: true })).status).toBe(200);
	const login = await raw(rn.port, { method: "POST", path: "/api/local/access/login", origin: PUBLIC_ORIGIN, ip: "203.0.113.77", body: { password: PASSWORD } });
	expect(login.status, login.text).toBe(200);
	cookie = cookiePair(login.cookies.find((c) => c.startsWith("__Host-clam_session=")) as string);
	const session = await raw<AgentSession>(rn.port, { method: "POST", path: "/api/local/sessions", origin: PUBLIC_ORIGIN, cookie, body: { title: "Remote chat" } });
	expect(session.status, session.text).toBe(201);
	project = (await api(rn.n).get<Project>(`/projects/${session.json?.projectId}`)).body;
});
afterAll(async () => rn.cleanup());

describe("chat files through the node's public domain", () => {
	it("uploads need the owner session and the public origin; with them the bytes are stored", async () => {
		const path = `/api/local/projects/${project.id}/upload?path=${encodeURIComponent("media/clip.mp4")}`;
		const headers = { "Content-Type": "video/mp4" };
		expect((await send("POST", path, bytes, { ...headers, Origin: PUBLIC_ORIGIN })).status).toBe(401);
		expect((await send("POST", path, bytes, { ...headers, Cookie: cookie, Origin: "https://evil.example" })).status).toBe(403);
		expect((await send("POST", path, bytes, { ...headers, Cookie: cookie })).status).toBe(403);
		const ok = await send("POST", path, bytes, { ...headers, Cookie: cookie, Origin: PUBLIC_ORIGIN });
		expect(ok.status, ok.text).toBe(201);
		expect((JSON.parse(ok.text) as FileEntry).size).toBe(bytes.length);
		expect((await send("POST", path, bytes, { ...headers, Cookie: cookie, Origin: PUBLIC_ORIGIN })).status).toBe(409);
	});

	it("serves raw bytes and ranges to the signed-in owner with the file's own policy, and nothing to anybody else", async () => {
		const path = `/api/local/projects/${project.id}/raw?path=${encodeURIComponent("media/clip.mp4")}`;
		expect((await raw(rn.port, { path })).status).toBe(401);
		const full = await raw(rn.port, { path, cookie, headers: { "accept-encoding": "gzip" } });
		expect(full.status).toBe(200);
		expect(full.text).toBe(bytes.toString());
		expect(full.headers["content-type"]).toBe("video/mp4");
		expect(full.headers["content-encoding"]).toBeUndefined();
		expect(full.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
		expect(full.headers["x-content-type-options"]).toBe("nosniff");
		const part = await raw(rn.port, { path, cookie, headers: { range: "bytes=5-9" } });
		expect(part.status).toBe(206);
		expect(part.headers["content-range"]).toBe(`bytes 5-9/${bytes.length}`);
		expect(part.text).toBe("56789");
		// the SPA page itself may play media and frame previews from this origin
		const page = await raw(rn.port, { path: "/" });
		expect(page.headers["content-security-policy"]).toContain("media-src 'self' blob:");
		expect(page.headers["content-security-policy"]).toContain("frame-src 'self'");
	});
});
