import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession, FileEntry, Project, Workspace } from "@clam/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, createFullHarness, type FullHarness } from "./full-harness.ts";
import { promptAndWait } from "./shared-fixtures.ts";

/**
 * Chats without a project: a session created with no `projectId` gets a managed working folder (origin `chat`, no git), and
 * that folder's files can be previewed (`projectRaw`: content types, HTTP ranges) and uploaded to (`projectUpload`).
 */

let node: FullHarness;
beforeEach(async () => {
	node = await createFullHarness();
});
afterEach(async () => {
	await node.cleanup();
});

const raw = (project: Project, file: string, init: RequestInit & { download?: boolean } = {}) =>
	fetch(`${node.url}/api/local/projects/${project.id}/raw?path=${encodeURIComponent(file)}${init.download ? "&download=1" : ""}`, init);
const upload = (project: Project, file: string, body: Buffer | string, options: { overwrite?: boolean; type?: string } = {}) =>
	fetch(`${node.url}/api/local/projects/${project.id}/upload?path=${encodeURIComponent(file)}${options.overwrite ? "&overwrite=1" : ""}`, { method: "POST", headers: { "content-type": options.type ?? "application/octet-stream" }, body });

async function newChat(): Promise<{ session: AgentSession; project: Project }> {
	const res = await api(node).post<AgentSession>("/sessions", { title: "Research" });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	const project = (await api(node).get<Project>(`/projects/${res.body.projectId}`)).body;
	return { session: res.body, project };
}

describe("a chat started without a project", () => {
	it("creates a managed chat folder in a default workspace when the node has none, then the session in it", async () => {
		expect((await api(node).get<Workspace[]>("/workspaces")).body).toEqual([]);
		const { session, project } = await newChat();
		expect(project).toMatchObject({ origin: "chat", managed: true, vcs: "none", name: "Research", sessionCount: 1 });
		expect(session.projectId).toBe(project.id);
		const workspaces = (await api(node).get<Workspace[]>("/workspaces")).body;
		expect(workspaces).toHaveLength(1);
		expect(project.workspaceId).toBe(workspaces[0]?.id);
		expect(existsSync(project.path)).toBe(true);
		expect(project.path.startsWith(path.join(realpathSync(node.dataDir), "projects") + path.sep)).toBe(true);
	});

	it("names an untitled chat 'Chat · <date>', uses the oldest workspace and honours an explicit workspaceId", async () => {
		const first = (await api(node).post<Workspace>("/workspaces", { name: "First" })).body;
		const second = (await api(node).post<Workspace>("/workspaces", { name: "Second" })).body;
		const untitled = await api(node).post<AgentSession>("/sessions", {});
		expect(untitled.status).toBe(201);
		const p1 = (await api(node).get<Project>(`/projects/${untitled.body.projectId}`)).body;
		expect(p1).toMatchObject({ origin: "chat", workspaceId: first.id });
		expect(p1.name).toMatch(/^Chat · \d{4}-\d{2}-\d{2}$/);
		const chosen = await api(node).post<AgentSession>("/sessions", { workspaceId: second.id, title: "In second" });
		expect((await api(node).get<Project>(`/projects/${chosen.body.projectId}`)).body.workspaceId).toBe(second.id);
	});

	it("user-created projects keep origin 'user' (a folder created without a path, and one that points at a path)", async () => {
		const ws = (await api(node).post<Workspace>("/workspaces", { name: "W" })).body;
		const managed = await api(node).post<Project>("/projects", { workspaceId: ws.id, name: "managed" });
		const pointed = await api(node).post<Project>("/projects", { workspaceId: ws.id, name: "pointed", path: node.projectDir });
		expect(managed.body).toMatchObject({ managed: true, origin: "user" });
		expect(pointed.body).toMatchObject({ managed: false, origin: "user" });
		await newChat();
		const origins = (await api(node).get<Project[]>("/projects")).body.map((p) => `${p.name}:${p.origin}`).sort();
		expect(origins).toEqual(["Research:chat", "managed:user", "pointed:user"]);
	});

	it("leaves nothing behind when the chat cannot be created (unknown workspace)", async () => {
		const res = await api(node).post("/sessions", { workspaceId: "ws_missing" });
		expect(res.status).toBe(404);
		expect((await api(node).get<Project[]>("/projects")).body).toEqual([]);
		expect(existsSync(path.join(node.dataDir, "projects")) ? readdirSync(path.join(node.dataDir, "projects")) : []).toEqual([]);
	});

	it("an agent in the chat folder writes a file and projectRaw returns it", async () => {
		const { session, project } = await newChat();
		await promptAndWait(node, session.id, "@@fake-sh echo 'hello from the agent' > report.md");
		const res = await raw(project, "report.md");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
		expect(await res.text()).toBe("hello from the agent\n");
	});
});

describe("projectRaw", () => {
	let project: Project;
	const bytes = Buffer.from("0123456789abcdefghij");
	beforeEach(async () => {
		({ project } = await newChat());
		expect((await upload(project, "media/clip.mp4", bytes)).status).toBe(201);
	});

	it("serves content types from the extension and never compresses or sniffs", async () => {
		const res = await raw(project, "media/clip.mp4", { headers: { "accept-encoding": "gzip, br" } });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("video/mp4");
		expect(res.headers.get("accept-ranges")).toBe("bytes");
		expect(res.headers.get("content-length")).toBe(String(bytes.length));
		expect(res.headers.get("content-encoding")).toBeNull();
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
	});

	it("answers ranges with 206 (seeking in video/audio/pdf), suffix and open-ended ranges, and 416 beyond the end", async () => {
		const part = await raw(project, "media/clip.mp4", { headers: { range: "bytes=2-5" } });
		expect(part.status).toBe(206);
		expect(part.headers.get("content-range")).toBe(`bytes 2-5/${bytes.length}`);
		expect(part.headers.get("content-length")).toBe("4");
		expect(await part.text()).toBe("2345");
		const tail = await raw(project, "media/clip.mp4", { headers: { range: "bytes=-4" } });
		expect(tail.status).toBe(206);
		expect(await tail.text()).toBe("ghij");
		const open = await raw(project, "media/clip.mp4", { headers: { range: "bytes=15-" } });
		expect(await open.text()).toBe("fghij");
		const clamped = await raw(project, "media/clip.mp4", { headers: { range: "bytes=18-999" } });
		expect(clamped.headers.get("content-range")).toBe(`bytes 18-19/${bytes.length}`);
		expect(await clamped.text()).toBe("ij");
		const beyond = await raw(project, "media/clip.mp4", { headers: { range: "bytes=500-" } });
		expect(beyond.status).toBe(416);
		expect(beyond.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
	});

	it("download=1 sends an attachment disposition with a safe file name", async () => {
		expect((await upload(project, "Báo cáo \"Q1\".pdf", Buffer.from("%PDF-1.4"))).status).toBe(201);
		const inline = await raw(project, "Báo cáo \"Q1\".pdf");
		expect(inline.headers.get("content-disposition")).toMatch(/^inline; /);
		await inline.arrayBuffer();
		const download = await raw(project, "Báo cáo \"Q1\".pdf", { download: true });
		const disposition = download.headers.get("content-disposition") as string;
		expect(disposition).toMatch(/^attachment; filename="B_o c_o _Q1_\.pdf"; filename\*=UTF-8''B%C3%A1o%20c%C3%A1o%20%22Q1%22\.pdf$/);
		expect(download.headers.get("content-type")).toBe("application/pdf");
		// A framed PDF/preview is allowed for the app's own pages only
		expect(download.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
		await download.arrayBuffer();
	});

	it("serves pages a browser would run inside a script-less sandbox", async () => {
		await upload(project, "page.html", Buffer.from("<script>alert(1)</script>"));
		const res = await raw(project, "page.html");
		expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(res.headers.get("content-security-policy")).toMatch(/^sandbox; default-src 'none'/);
		await res.arrayBuffer();
	});

	it("refuses traversal, absolute paths, symlinks that leave the project, the .git directory, folders and missing files", async () => {
		const outside = mkdtempSync(path.join(tmpdir(), "clam-outside-"));
		try {
			writeFileSync(path.join(outside, "secret.txt"), "secret");
			symlinkSync(path.join(outside, "secret.txt"), path.join(project.path, "link.txt"));
			symlinkSync(outside, path.join(project.path, "linked-dir"));
			mkdirSync(path.join(project.path, ".git"));
			writeFileSync(path.join(project.path, ".git", "config"), "[remote]");
			expect((await raw(project, "../outside.txt")).status).toBe(400);
			expect((await raw(project, "media/../../x")).status).toBe(400);
			expect((await raw(project, outside + "/secret.txt")).status).toBe(400);
			const symlink = await raw(project, "link.txt");
			expect(symlink.status).toBe(403);
			expect(await symlink.text()).not.toContain("secret");
			expect((await raw(project, "linked-dir/secret.txt")).status).toBe(403);
			expect((await raw(project, ".git/config")).status).toBe(403);
			expect((await raw(project, "media")).status).toBe(400);
			expect((await raw(project, "nope.bin")).status).toBe(404);
			expect((await fetch(`${node.url}/api/local/projects/${project.id}/raw`)).status).toBe(400);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("projectUpload", () => {
	let project: Project;
	beforeEach(async () => {
		({ project } = await newChat());
	});

	it("stores raw bytes of any content type intact (a JSON body is still just bytes), creating parent folders", async () => {
		const png = randomBytes(300_000);
		const res = await upload(project, "images/deep/a.png", png, { type: "image/png" });
		expect(res.status).toBe(201);
		const entry = (await res.json()) as FileEntry;
		expect(entry).toMatchObject({ name: "a.png", path: "images/deep/a.png", kind: "file", size: png.length });
		expect(createHash("sha256").update(readFileSync(path.join(project.path, "images/deep/a.png"))).digest("hex")).toBe(createHash("sha256").update(png).digest("hex"));
		const json = Buffer.from('{"not":"parsed"}');
		expect((await upload(project, "data.json", json, { type: "application/json" })).status).toBe(201);
		expect(readFileSync(path.join(project.path, "data.json")).equals(json)).toBe(true);
		expect((await upload(project, "empty.txt", "")).status).toBe(201);
		expect(readFileSync(path.join(project.path, "empty.txt"))).toHaveLength(0);
		// No temporary files are left in the folder
		expect(readdirSync(project.path).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});

	it("never overwrites: 409 when the file exists unless overwrite=1, which replaces it", async () => {
		expect((await upload(project, "notes.md", "one")).status).toBe(201);
		const clash = await upload(project, "notes.md", "two");
		expect(clash.status).toBe(409);
		expect(readFileSync(path.join(project.path, "notes.md"), "utf8")).toBe("one");
		expect(readdirSync(project.path).filter((n) => n.endsWith(".tmp"))).toEqual([]);
		expect((await upload(project, "notes.md", "three", { overwrite: true })).status).toBe(201);
		expect(readFileSync(path.join(project.path, "notes.md"), "utf8")).toBe("three");
		expect((await upload(project, "media", "x")).status).toBe(201);
		expect((await upload(project, "media/inner.txt", "x")).status).toBe(409);
		mkdirSync(path.join(project.path, "folder"));
		expect((await upload(project, "folder", "x", { overwrite: true })).status).toBe(409);
	});

	it("refuses paths that leave the project, symlinked folders that lead outside, and the .git directory", async () => {
		const outside = mkdtempSync(path.join(tmpdir(), "clam-outside-"));
		try {
			symlinkSync(outside, path.join(project.path, "linked-dir"));
			expect((await upload(project, "../escape.txt", "x")).status).toBe(400);
			expect((await upload(project, "a/../../escape.txt", "x")).status).toBe(400);
			expect((await upload(project, "/etc/escape.txt", "x")).status).toBe(400);
			expect((await upload(project, "linked-dir/escape.txt", "x")).status).toBe(403);
			expect(existsSync(path.join(outside, "escape.txt"))).toBe(false);
			expect((await upload(project, ".git/hooks/pre-commit", "x")).status).toBe(403);
			expect((await upload(project, "", "x")).status).toBe(400);
			expect((await fetch(`${node.url}/api/local/projects/prj_missing/upload?path=a.txt`, { method: "POST", body: "x" })).status).toBe(404);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
