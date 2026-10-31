import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TERMINAL_CLOSE, type AccessStatus, type Project, type TerminalInfo, type TerminalServerMessage, type TerminalSession, type Workspace } from "@clam/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Scrollback } from "../src/terminal/scrollback.ts";
import { api, createFullHarness, type FullHarness } from "./full-harness.ts";
import { PASSWORD, PUBLIC_ORIGIN, cookiePair, raw, remoteNode, wsUpgrade, type RawWs, type RemoteNode } from "./remote-helpers.ts";

const SESSION = "__Host-clam_session";
const TERM_PATH = "/ws/terminal";

/** A fresh HOME so the shells do not read the developer's rc files (prompts, slow plugins). */
let fakeHome: string;
let realHome: string | undefined;
beforeAll(() => {
	realHome = process.env.HOME;
	fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "clam-term-home-")));
	process.env.HOME = fakeHome;
});
afterAll(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(fakeHome, { recursive: true, force: true });
});

const jsonFrames = (ws: RawWs): TerminalServerMessage[] => ws.texts.map((t) => JSON.parse(t) as TerminalServerMessage);
const hasFrame = (ws: RawWs, type: string): boolean => jsonFrames(ws).some((m) => m.type === type);
const closed = (ws: RawWs): boolean => ws.closeCode !== null || ws.ended;

/** Attach to a terminal on the loopback UI (no login there). */
async function attachLoopback(n: FullHarness, id: string): Promise<RawWs> {
	const { status, ws } = await wsUpgrade(n.port, { path: `${TERM_PATH}/${id}`, host: `127.0.0.1:${n.port}` });
	expect(status).toBe(101);
	await ws!.until(() => hasFrame(ws!, "live"), "replay finished");
	return ws!;
}

describe("Scrollback ring", () => {
	it("keeps the newest bytes within the limit, packs small chunks, and restarts the replay at a clean boundary after dropping", () => {
		const ring = new Scrollback(1000);
		for (let i = 0; i < 200; i += 1) ring.push(Buffer.from(`line ${String(i).padStart(3, "0")}\n`));
		const kept = Buffer.concat(ring.snapshot()).toString("utf8");
		expect(ring.size).toBe(1000);
		expect(kept.length).toBeLessThanOrEqual(1000);
		expect(kept.startsWith("line ")).toBe(true); // no half line
		expect(kept.endsWith("line 199\n")).toBe(true);

		const unicode = new Scrollback(10);
		unicode.push(Buffer.from("ééééééééééé")); // 22 bytes: the cut lands inside a 2-byte character
		expect(Buffer.concat(unicode.snapshot()).toString("utf8")).not.toContain("\ufffd");

		const small = new Scrollback(1 << 20);
		for (let i = 0; i < 5000; i += 1) small.push(Buffer.from("x"));
		expect(small.snapshot().length).toBe(1);
		expect(small.size).toBe(5000);
	});
});

describe("Terminal on the loopback UI", () => {
	let n: FullHarness;
	let project: Project;
	beforeAll(async () => {
		n = await createFullHarness({ terminal: { maxSessions: 3, exitedTtlMs: 600 } });
		const ws = (await api(n).post<Workspace>("/workspaces", { name: "W" })).body;
		project = (await api(n).post<Project>("/projects", { workspaceId: ws.id, name: "term-project", path: n.projectDir })).body;
	});
	afterAll(async () => n.cleanup());

	it("reports the machine's shells and works without any login", async () => {
		const info = await api(n).get<TerminalInfo>("/terminal");
		expect(info.status).toBe(200);
		expect(info.body).toMatchObject({ available: true, reason: null, home: fakeHome, maxSessions: 3 });
		expect(info.body.shells).toContain(info.body.defaultShell);
		expect(info.body.user.length).toBeGreaterThan(0);
	});

	it("creates a real PTY shell in the home folder with TERM and COLORTERM set, streams output, takes input and resizes", async () => {
		const created = await api(n).post<TerminalSession>("/terminal/sessions", { cols: 100, rows: 30 });
		expect(created.status).toBe(201);
		const session = created.body;
		expect(session).toMatchObject({ status: "running", cwd: fakeHome, projectId: null, cols: 100, rows: 30, exitCode: null });
		const ws = await attachLoopback(n, session.id);
		const attached = jsonFrames(ws).find((m) => m.type === "attached");
		expect(attached).toMatchObject({ type: "attached", session: { id: session.id } });

		ws.sendBinary("echo env=$TERM/$COLORTERM; stty size; pwd\n");
		await ws.until(() => ws.output.includes("env=xterm-256color/truecolor") && ws.output.includes("30 100") && ws.output.includes(fakeHome), "shell answered");

		ws.send({ type: "resize", cols: 120, rows: 40 });
		await ws.until(() => jsonFrames(ws).some((m) => m.type === "session" && m.session.cols === 120), "resize broadcast");
		ws.sendBinary("stty size\n");
		await ws.until(() => ws.output.includes("40 120"), "pty resized");
		expect((await api(n).get<TerminalSession>(`/terminal/sessions/${session.id}`)).body).toMatchObject({ cols: 120, rows: 40, attached: 1 });

		ws.send({ type: "ping", t: 5 });
		await ws.until(() => jsonFrames(ws).some((m) => m.type === "pong" && m.t === 5), "pong");
		ws.send({ type: "resize", cols: 0, rows: 0 });
		await ws.until(() => hasFrame(ws, "error"), "invalid control frame refused");
		ws.destroy();
		expect((await api(n).del(`/terminal/sessions/${session.id}`)).status).toBe(204);
	});

	it("keeps a terminal alive across browser disconnects and replays the scrollback on reattach", async () => {
		const session = (await api(n).post<TerminalSession>("/terminal/sessions", {})).body;
		const first = await attachLoopback(n, session.id);
		first.sendBinary("echo persisted-$((6*7))\n");
		await first.until(() => first.output.includes("persisted-42"), "first output");
		first.destroy();
		await expect.poll(async () => (await api(n).get<TerminalSession>(`/terminal/sessions/${session.id}`)).body.attached).toBe(0);

		const second = await attachLoopback(n, session.id);
		const attached = jsonFrames(second).find((m) => m.type === "attached");
		expect(attached && attached.type === "attached" ? attached.replayBytes : 0).toBeGreaterThan(0);
		expect(second.output).toContain("persisted-42");
		// Still the same shell process: its state survived.
		second.sendBinary("echo still-here\n");
		await second.until(() => second.output.includes("still-here"), "live after reattach");
		second.destroy();
		await api(n).del(`/terminal/sessions/${session.id}`);
	});

	it("opens in a project folder and shows several browsers the same terminal", async () => {
		const session = (await api(n).post<TerminalSession>("/terminal/sessions", { projectId: project.id, title: "build" })).body;
		expect(session).toMatchObject({ cwd: realpathSync(n.projectDir), projectId: project.id, title: "build" });
		const a = await attachLoopback(n, session.id);
		const b = await attachLoopback(n, session.id);
		a.sendBinary("echo both-see-$((1+1))\n");
		await a.until(() => a.output.includes("both-see-2"), "a sees");
		await b.until(() => b.output.includes("both-see-2"), "b sees");
		expect((await api(n).patch<TerminalSession>(`/terminal/sessions/${session.id}`, { title: "renamed" })).body.title).toBe("renamed");
		await a.until(() => jsonFrames(a).some((m) => m.type === "session" && m.session.title === "renamed"), "rename broadcast");
		a.destroy();
		b.destroy();
		await api(n).del(`/terminal/sessions/${session.id}`);
	});

	it("refuses a missing project, an unknown shell and a body outside the limits", async () => {
		expect((await api(n).post("/terminal/sessions", { projectId: "prj_missing" })).status).toBe(404);
		const shell = await api(n).post<{ error: { code: string } }>("/terminal/sessions", { shell: "/definitely/not/a/shell" });
		expect(shell.status).toBe(400);
		expect((await api(n).post("/terminal/sessions", { cols: 100000 })).status).toBe(400);
		expect((await api(n).get("/terminal/sessions/term_nope")).status).toBe(404);
	});

	it("reports the exit status, keeps the finished terminal readable, then removes it", async () => {
		const session = (await api(n).post<TerminalSession>("/terminal/sessions", {})).body;
		const ws = await attachLoopback(n, session.id);
		ws.sendBinary("echo bye-now; exit 3\n");
		await ws.until(() => jsonFrames(ws).some((m) => m.type === "exit"), "exit frame");
		expect(jsonFrames(ws).find((m) => m.type === "exit")).toMatchObject({ exitCode: 3, signal: null });
		expect((await api(n).get<TerminalSession>(`/terminal/sessions/${session.id}`)).body).toMatchObject({ status: "exited", exitCode: 3 });
		ws.destroy();
		// Reattach to a finished terminal: replay + exit, no shell.
		const again = await attachLoopback(n, session.id);
		expect(again.output).toContain("bye-now");
		await again.until(() => hasFrame(again, "exit"), "exit replayed");
		// Expiry (exitedTtlMs = 600 ms in this harness) closes it and drops the terminal.
		await again.until(() => closed(again), "removed after expiry");
		expect(again.closeCode).toBe(TERMINAL_CLOSE.removed);
		expect((await api(n).get(`/terminal/sessions/${session.id}`)).status).toBe(404);
	});

	it("kills a running terminal with DELETE: attached browsers are disconnected and the shell process is gone", async () => {
		const session = (await api(n).post<TerminalSession>("/terminal/sessions", {})).body;
		const ws = await attachLoopback(n, session.id);
		ws.sendBinary("echo $$\n");
		await ws.until(() => /^\d+\r?$/m.test(ws.output.split("\n").slice(1).join("\n")), "shell pid printed");
		const pid = Number(/^(\d+)\r?$/m.exec(ws.output.split("\n").slice(1).join("\n"))?.[1]);
		expect(pid).toBeGreaterThan(1);
		expect((await api(n).del(`/terminal/sessions/${session.id}`)).status).toBe(204);
		await ws.until(() => closed(ws), "socket closed");
		expect(ws.closeCode).toBe(TERMINAL_CLOSE.removed);
		await expect.poll(() => {
			try {
				process.kill(pid, 0);
				return "alive";
			} catch {
				return "gone";
			}
		}, { timeout: 5_000 }).toBe("gone");
		expect((await api(n).get<TerminalSession[]>("/terminal/sessions")).body.find((s) => s.id === session.id)).toBeUndefined();
	});

	it("enforces the terminal limit", async () => {
		const made: string[] = [];
		for (let i = 0; i < 3; i += 1) made.push((await api(n).post<TerminalSession>("/terminal/sessions", {})).body.id);
		const over = await api(n).post<{ error: { code: string } }>("/terminal/sessions", {});
		expect(over.status).toBe(409);
		expect(over.body.error.code).toBe("terminal_limit");
		for (const id of made) await api(n).del(`/terminal/sessions/${id}`);
	});

	it("pauses the shell while a browser does not read (backpressure) and delivers every byte once it does", async () => {
		const session = (await api(n).post<TerminalSession>("/terminal/sessions", {})).body;
		const ws = await attachLoopback(n, session.id);
		ws.socket.pause(); // a browser tab that stopped reading
		ws.sendBinary("seq -f %.0f 1 1500000; echo flood-done\n");
		// Bracket access to the service's private map: the observable effect of backpressure is the PTY being paused.
		const paused = () => [...(n.ctx.terminals["terminals"] as Map<string, { paused: boolean }>).values()].some((t) => t.paused);
		await expect.poll(paused, { timeout: 15_000, interval: 50 }).toBe(true);
		ws.socket.resume();
		await ws.until(() => ws.tail.includes("\r\nflood-done"), "all output delivered", 30_000);
		expect(ws.tail).toContain("\r\n1500000\r\n");
		expect(paused()).toBe(false);
		ws.destroy();
		await api(n).del(`/terminal/sessions/${session.id}`);
	});

	it("writes audit entries for open, attach and close with via=loopback", async () => {
		const session = (await api(n).post<TerminalSession>("/terminal/sessions", {})).body;
		(await attachLoopback(n, session.id)).destroy();
		await api(n).del(`/terminal/sessions/${session.id}`);
		const rows = n.ctx.db.$client.prepare("select type, payload from node_events where type like 'terminal.%'").all() as Array<{ type: string; payload: string }>;
		const mine = rows.filter((r) => (JSON.parse(r.payload) as { terminal: string }).terminal === session.id);
		expect(mine.map((r) => r.type)).toEqual(["terminal.open", "terminal.attach", "terminal.close"]);
		for (const row of mine) expect(JSON.parse(row.payload)).toMatchObject({ via: "loopback" });
	});

	it("stop() ends every shell and closes the sockets", async () => {
		const session = (await api(n).post<TerminalSession>("/terminal/sessions", {})).body;
		const ws = await attachLoopback(n, session.id);
		n.ctx.terminals.stop();
		await ws.until(() => closed(ws), "socket closed on stop");
		expect(ws.closeCode).toBe(TERMINAL_CLOSE.shuttingDown);
		expect(n.ctx.terminals.list()).toEqual([]);
	});
});

describe("Terminal through the domain (public listener)", () => {
	let rn: RemoteNode;
	let ipCounter = 0;
	const freshIp = (): string => `198.51.100.${++ipCounter}`;
	const http = () => api(rn.n);
	const post = (path: string, body: unknown, cookie?: string, ip = freshIp()) => raw<{ error?: { code: string } } & Partial<AccessStatus> & Partial<TerminalSession>>(rn.port, { method: "POST", path, body, origin: PUBLIC_ORIGIN, ...(cookie ? { cookie } : {}), ip });
	const signIn = async (): Promise<string> => {
		const res = await post("/api/local/access/login", { password: PASSWORD });
		expect(res.status, res.text).toBe(200);
		return cookiePair(res.cookies.find((c) => c.startsWith(`${SESSION}=`))!);
	};
	const stepUp = async (cookie: string): Promise<void> => {
		const res = await post("/api/local/access/step-up", { password: PASSWORD }, cookie);
		expect(res.status, res.text).toBe(200);
	};
	const upgrade = (id: string, o: { cookie?: string; origin?: string | null } = {}) => wsUpgrade(rn.port, { path: `${TERM_PATH}/${id}`, origin: PUBLIC_ORIGIN, ...o });
	const ownerReady = async (): Promise<void> => {
		expect((await http().put("/access/password", { password: PASSWORD })).status).toBe(200);
		expect((await http().patch("/access", { remoteUiEnabled: true })).status).toBe(200);
	};

	beforeAll(async () => {
		rn = await remoteNode();
		await ownerReady();
	});
	afterAll(async () => rn.cleanup());

	it("is off by default: every terminal route and socket answers 403 tool_disabled, and the status says so", async () => {
		const cookie = await signIn();
		const status = (await raw<AccessStatus>(rn.port, { path: "/api/local/access", cookie })).json!;
		expect(status).toMatchObject({ remoteTerminalEnabled: false, remoteBrowserEnabled: false, elevatedUntil: null });
		for (const [method, path] of [["GET", "/api/local/terminal"], ["GET", "/api/local/terminal/sessions"], ["POST", "/api/local/terminal/sessions"], ["DELETE", "/api/local/terminal/sessions/x"]] as const) {
			const res = await raw(rn.port, { method, path, cookie, origin: PUBLIC_ORIGIN, ...(method === "POST" ? { body: {} } : {}) });
			expect(res.status, `${method} ${path}`).toBe(403);
			expect(res.json?.error?.code).toBe("tool_disabled");
		}
		expect((await upgrade("term_x", { cookie })).status).toBe(403);
		// Without a session it is the sign-in wall, not a hint that the tool exists.
		expect((await upgrade("term_x")).status).toBe(401);
		expect((await raw(rn.port, { path: "/api/local/terminal" })).status).toBe(401);
	});

	it("a remote session switches the Terminal on only with the owner password (wrong → 401, missing → 400), never the UI exposure", async () => {
		const cookie = await signIn();
		const patch = (body: unknown) => raw<AccessStatus & { error?: { code: string } }>(rn.port, { method: "PATCH", path: "/api/local/access", body, cookie, origin: PUBLIC_ORIGIN, ip: freshIp() });
		expect((await patch({ remoteTerminalEnabled: true })).status).toBe(400);
		const wrong = await patch({ remoteTerminalEnabled: true, password: "not the password at all" });
		expect(wrong.status).toBe(401);
		expect(wrong.json?.error?.code).toBe("invalid_credentials");
		expect((await http().get<AccessStatus>("/access")).body.remoteTerminalEnabled).toBe(false);
		expect((await patch({ remoteUiEnabled: false })).json?.error?.code).toBe("loopback_only");
		expect((await patch({ sessionTtlHours: 24 })).json?.error?.code).toBe("loopback_only");

		const enabled = await patch({ remoteTerminalEnabled: true, password: PASSWORD });
		expect(enabled.status, enabled.text).toBe(200);
		expect(enabled.json).toMatchObject({ remoteTerminalEnabled: true, remoteBrowserEnabled: false });
		expect(enabled.json?.elevatedUntil).not.toBeNull(); // a password-enable also elevates this session
		// Off again needs no password.
		const off = await patch({ remoteTerminalEnabled: false });
		expect(off.status).toBe(200);
		expect(off.json).toMatchObject({ remoteTerminalEnabled: false });
		const rows = rn.n.ctx.db.$client.prepare("select payload from node_events where type = 'access.remote_toggle'").all() as Array<{ payload: string }>;
		const toggles = rows.map((r) => JSON.parse(r.payload) as { tool: string; enabled: boolean; via: string });
		expect(toggles).toContainEqual({ tool: "terminal", enabled: true, via: "remote" });
		expect(toggles).toContainEqual({ tool: "terminal", enabled: false, via: "remote" });
	});

	it("switched on (from the loopback UI) it still needs a step-up: 403 step_up_required → wrong password refused → right password opens it", async () => {
		expect((await http().patch<AccessStatus>("/access", { remoteTerminalEnabled: true })).body).toMatchObject({ remoteTerminalEnabled: true });
		const cookie = await signIn();
		// Metadata is readable once the tool is on; opening/attaching needs the step-up.
		expect((await raw(rn.port, { path: "/api/local/terminal", cookie })).status).toBe(200);
		const early = await post("/api/local/terminal/sessions", {}, cookie);
		expect(early.status).toBe(403);
		expect(early.json?.error?.code).toBe("step_up_required");

		const wrong = await post("/api/local/access/step-up", { password: "definitely wrong password" }, cookie);
		expect(wrong.status).toBe(403);
		expect((await raw<AccessStatus>(rn.port, { path: "/api/local/access", cookie })).json?.elevatedUntil).toBeNull();
		await stepUp(cookie);
		const status = (await raw<AccessStatus>(rn.port, { path: "/api/local/access", cookie })).json!;
		expect(Date.parse(status.elevatedUntil!) - Date.now()).toBeGreaterThan(9 * 60_000);

		const created = await post("/api/local/terminal/sessions", { cols: 90, rows: 25 }, cookie);
		expect(created.status, created.text).toBe(201);
		const id = created.json!.id!;

		// The socket: cross-origin and sessionless are refused; the owner's gets the shell.
		expect((await upgrade(id, { cookie, origin: "https://evil.example" })).status).toBe(403);
		expect((await upgrade(id, { cookie, origin: null })).status).toBe(403);
		expect((await upgrade(id)).status).toBe(401);
		const other = await signIn(); // another session that did not step up
		const unelevated = await upgrade(id, { cookie: other });
		expect(unelevated.status).toBe(403);

		const { status: code, ws } = await upgrade(id, { cookie });
		expect(code).toBe(101);
		await ws!.until(() => hasFrame(ws!, "live"), "replay");
		ws!.sendBinary("echo remote-$((20+22))\n");
		await ws!.until(() => ws!.output.includes("remote-42"), "remote shell answered");

		// Logging every session out closes the live terminal socket (the shell itself keeps running for the next sign-in).
		expect((await post("/api/local/access/logout-all", {}, cookie)).status).toBe(204);
		await ws!.until(() => closed(ws!), "socket closed by logout-all");
		expect(ws!.closeCode).toBe(TERMINAL_CLOSE.sessionEnded);
		ws!.destroy();
		expect(rn.n.ctx.terminals.has(id)).toBe(true);
		rn.n.ctx.terminals.kill(id);

		const audit = rn.n.ctx.db.$client.prepare("select type, payload from node_events where type like 'terminal.%'").all() as Array<{ type: string; payload: string }>;
		const opened = audit.find((r) => r.type === "terminal.open" && (JSON.parse(r.payload) as { terminal: string }).terminal === id);
		expect(JSON.parse(opened!.payload)).toMatchObject({ via: "remote" });
		expect(audit.some((r) => r.type === "terminal.attach" && JSON.parse(r.payload).via === "remote")).toBe(true);
	});

	it("switching the Terminal off closes its live remote sockets immediately", async () => {
		const cookie = await signIn();
		await stepUp(cookie);
		const id = (await post("/api/local/terminal/sessions", {}, cookie)).json!.id!;
		const { ws } = await upgrade(id, { cookie });
		await ws!.until(() => hasFrame(ws!, "live"), "replay");
		expect((await http().patch("/access", { remoteTerminalEnabled: false })).status).toBe(200);
		await ws!.until(() => closed(ws!), "socket closed by the toggle");
		expect(ws!.closeCode).toBe(TERMINAL_CLOSE.sessionEnded);
		ws!.destroy();
		// Reconnecting is refused outright, and so are the REST routes.
		expect((await upgrade(id, { cookie })).status).toBe(403);
		expect((await raw(rn.port, { path: "/api/local/terminal/sessions", cookie })).status).toBe(403);
		rn.n.ctx.terminals.kill(id);
	});

	it("a single logout closes that session's terminal socket and drops its elevation", async () => {
		expect((await http().patch("/access", { remoteTerminalEnabled: true })).status).toBe(200);
		const cookie = await signIn();
		await stepUp(cookie);
		const id = (await post("/api/local/terminal/sessions", {}, cookie)).json!.id!;
		const { ws } = await upgrade(id, { cookie });
		await ws!.until(() => hasFrame(ws!, "live"), "replay");
		expect((await post("/api/local/access/logout", {}, cookie)).status).toBe(204);
		await ws!.until(() => closed(ws!), "socket closed by logout");
		expect(ws!.closeCode).toBe(TERMINAL_CLOSE.sessionEnded);
		ws!.destroy();
		rn.n.ctx.terminals.kill(id);
	});

	it("has no terminal door on the mesh API: /api/v1 knows no terminal route, whatever the caller presents", async () => {
		const cookie = await signIn();
		for (const [method, path] of [["GET", "/api/v1/terminal"], ["GET", "/api/v1/terminal/sessions"], ["POST", "/api/v1/terminal/sessions"], ["GET", "/api/v1/ws/terminal/x"]] as const) {
			const res = await raw(rn.port, { method, path, cookie, origin: PUBLIC_ORIGIN, ...(method === "POST" ? { body: {} } : {}) });
			expect([401, 404], `${method} ${path} → ${res.status}`).toContain(res.status);
		}
		expect((await wsUpgrade(rn.port, { path: "/api/v1/terminal/x", origin: PUBLIC_ORIGIN, cookie })).status).toBe(0); // the wire listener drops other upgrades unanswered
	});

	it("step-up is for remote sessions only and is throttled like the login", async () => {
		const res = await http().post<{ error: { code: string } }>("/access/step-up", { password: PASSWORD });
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe("step_up_not_required");
		const cookie = await signIn();
		const ip = "203.0.113.250";
		let last = 0;
		for (let i = 0; i < 6; i += 1) last = (await post("/api/local/access/step-up", { password: `wrong password ${i}` }, cookie, ip)).status;
		expect(last).toBe(429);
		expect((await post("/api/local/access/step-up", { password: PASSWORD }, cookie, ip)).status).toBe(429); // locked even for the right one
	});
});

describe("Terminal gate on loopback", () => {
	it("needs no login and no step-up there, and the status reports no elevation", async () => {
		const n = await createFullHarness();
		try {
			const status = (await api(n).get<AccessStatus>("/access")).body;
			expect(status).toMatchObject({ via: "loopback", remoteTerminalEnabled: false, remoteBrowserEnabled: false, elevatedUntil: null });
			const created = await api(n).post<TerminalSession>("/terminal/sessions", {});
			expect(created.status).toBe(201);
			// A foreign Origin is refused on the loopback socket too.
			const cross = await wsUpgrade(n.port, { path: `${TERM_PATH}/${created.body.id}`, host: `127.0.0.1:${n.port}`, origin: "https://evil.example" });
			expect(cross.status).toBe(403);
		} finally {
			await n.cleanup();
		}
	});
});
