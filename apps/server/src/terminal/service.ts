import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { TERMINAL_CLOSE, TERMINAL_LIMITS, type CreateTerminalBody, type TerminalInfo, type TerminalServerMessage, type TerminalSession, i18nMsg } from "@clam/contracts";
import { checkoutFolder } from "../services/checkouts.ts";
import type { IPty } from "node-pty";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { newId } from "../services/ids.ts";
import { Scrollback } from "./scrollback.ts";
import { dirExists, shellEnv, shellInfo, shellName } from "./shells.ts";

export interface TerminalOptions {
	maxSessions?: number;
	/** How long a finished terminal stays (read-only, with its last output) before it is removed. */
	exitedTtlMs?: number;
	scrollbackBytes?: number;
}

/** One browser attached to a terminal. The service is transport-agnostic; the WebSocket layer implements this. */
export interface TerminalClient {
	sendBinary(data: Buffer): void;
	sendJson(message: TerminalServerMessage): void;
	/** Bytes queued for this client and not yet written to its socket. */
	buffered(): number;
	close(code: number, reason: string): void;
	/** Drop the connection without a closing handshake (a client that stopped reading). */
	terminate(): void;
}

const REPLAY_FRAME_BYTES = 64 * 1024;
/** Output is held back (the PTY is paused) while any client has more than this queued… */
const HIGH_WATER_BYTES = 1 << 20;
/** …and released once every client is below this. */
const LOW_WATER_BYTES = 256 << 10;
const DRAIN_POLL_MS = 20;
/** A client that has not drained for this long while output waits is dropped, so one dead tab cannot freeze the shell. */
const STALL_LIMIT_MS = 15_000;
const KILL_ESCALATE_MS = 2_000;

/**
 * node-pty's `spawn-helper` must be executable. Package managers that unpack tarballs without the mode bits (pnpm) leave it
 * at 0644 and every spawn then fails with `posix_spawnp failed`; fix the bit once before the first spawn.
 */
let helperChecked = false;
function ensureSpawnHelperExecutable(): void {
	if (helperChecked || process.platform === "win32") return;
	helperChecked = true;
	try {
		const root = path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
		for (const dir of [path.join(root, "build", "Release"), path.join(root, "build", "Debug"), path.join(root, "prebuilds", `${process.platform}-${process.arch}`)]) {
			const helper = path.join(dir, "spawn-helper");
			if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
		}
	} catch {
		// Resolution problems surface as a clear error when the terminal is created.
	}
}

class Terminal {
	readonly clients = new Set<TerminalClient>();
	readonly scrollback: Scrollback;
	readonly createdAt = new Date();
	lastActivityAt = new Date();
	status: "running" | "exited" = "running";
	exitCode: number | null = null;
	signal: number | null = null;
	exitedAt: Date | null = null;
	paused = false;
	pausedSince = 0;
	drainTimer: NodeJS.Timeout | null = null;
	expiry: NodeJS.Timeout | null = null;
	escalation: NodeJS.Timeout | null = null;

	constructor(
		readonly id: string,
		public title: string,
		readonly shell: string,
		readonly cwd: string,
		readonly projectId: string | null,
		public cols: number,
		public rows: number,
		readonly pty: IPty,
		scrollbackBytes: number,
	) {
		this.scrollback = new Scrollback(scrollbackBytes);
	}

	toJSON(): TerminalSession {
		return {
			id: this.id,
			title: this.title,
			shell: this.shell,
			cwd: this.cwd,
			projectId: this.projectId,
			cols: this.cols,
			rows: this.rows,
			status: this.status,
			exitCode: this.exitCode,
			signal: this.signal,
			attached: this.clients.size,
			createdAt: this.createdAt.toISOString(),
			lastActivityAt: this.lastActivityAt.toISOString(),
			exitedAt: this.exitedAt?.toISOString() ?? null,
		};
	}
}

/**
 * The machine's terminals: real PTYs running the owner's shell, kept in this process. A terminal outlives any browser
 * (reattach replays its scrollback) and ends when its shell exits, it is killed, or the server stops.
 * Access control (who may call this) is the routes' / socket's job (`AccessService.assertTool`); this class only runs shells.
 */
export class TerminalService {
	private readonly terminals = new Map<string, Terminal>();
	private readonly maxSessions: number;
	private readonly exitedTtlMs: number;
	private readonly scrollbackBytes: number;
	private stopped = false;
	private ptyModule: Promise<typeof import("node-pty")> | null = null;

	constructor(
		private readonly ctx: Pick<ServerContext, "db" | "log" | "config">,
		options: TerminalOptions = {},
	) {
		this.maxSessions = options.maxSessions ?? TERMINAL_LIMITS.maxSessions;
		this.exitedTtlMs = options.exitedTtlMs ?? 10 * 60_000;
		this.scrollbackBytes = options.scrollbackBytes ?? TERMINAL_LIMITS.scrollbackBytes;
	}

	private loadPty(): Promise<typeof import("node-pty")> {
		this.ptyModule ??= import("node-pty").then((module) => ("default" in module && module.default ? (module.default as typeof import("node-pty")) : module));
		return this.ptyModule;
	}

	// ---------------------------------------------------------------------------------------------- queries

	async info(): Promise<TerminalInfo> {
		const shells = shellInfo();
		let available = true;
		let reason: string | null = null;
		try {
			await this.loadPty();
		} catch (error) {
			available = false;
			reason = `The terminal engine (node-pty) could not be loaded on this machine: ${error instanceof Error ? error.message : String(error)}`;
		}
		return { available, reason, ...shells, maxSessions: this.maxSessions, sessionCount: this.terminals.size };
	}

	list(): TerminalSession[] {
		return [...this.terminals.values()].map((t) => t.toJSON()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	get(id: string): TerminalSession {
		return this.require(id).toJSON();
	}

	has(id: string): boolean {
		return this.terminals.has(id);
	}

	private require(id: string): Terminal {
		const terminal = this.terminals.get(id);
		if (!terminal) throw ApiError.notFound("Terminal");
		return terminal;
	}

	// ---------------------------------------------------------------------------------------------- lifecycle

	async create(body: CreateTerminalBody & { cols: number; rows: number }): Promise<TerminalSession> {
		if (this.stopped) throw ApiError.unavailable(i18nMsg("The server is shutting down"));
		const info = shellInfo();
		const shell = body.shell ?? info.defaultShell;
		if (!info.shells.includes(shell)) throw ApiError.badRequest(i18nMsg('"{shell}" is not an installed shell on this machine', { shell }), { shells: info.shells });
		let cwd = info.home;
		let projectId: string | null = null;
		if (body.projectId) {
			const folder = await checkoutFolder(this.ctx, body.projectId);
			if (!dirExists(folder)) throw new ApiError(409, "project_folder_missing", i18nMsg("That project's folder no longer exists on this machine"));
			cwd = folder;
			projectId = body.projectId;
		}
		if (!dirExists(cwd)) throw new ApiError(409, "cwd_missing", i18nMsg("The folder {path} does not exist", { path: cwd }));
		this.makeRoom();

		ensureSpawnHelperExecutable();
		let pty: IPty;
		try {
			const nodePty = await this.loadPty();
			pty = nodePty.spawn(shell, ["-l"], { name: "xterm-256color", cols: body.cols, rows: body.rows, cwd, env: shellEnv(shell, cwd), encoding: null });
		} catch (error) {
			throw ApiError.unavailable(i18nMsg("Could not start {shell}: {error}", { shell: shellName(shell), error: error instanceof Error ? error.message : String(error) }));
		}
		// `create` awaited the engine: re-check the limit now that other creations may have landed in between.
		if (this.stopped || this.terminals.size >= this.maxSessions) {
			pty.kill("SIGKILL");
			throw this.stopped ? ApiError.unavailable(i18nMsg("The server is shutting down")) : new ApiError(409, "terminal_limit", i18nMsg("At most {count} terminals can be open on this machine", { count: this.maxSessions }));
		}

		const terminal = new Terminal(newId("term"), body.title ?? shellName(shell), shell, cwd, projectId, body.cols, body.rows, pty, this.scrollbackBytes);
		this.terminals.set(terminal.id, terminal);
		pty.onData((data) => this.onData(terminal, typeof data === "string" ? Buffer.from(data, "utf8") : data));
		pty.onExit(({ exitCode, signal }) => this.onExit(terminal, exitCode, signal ?? null));
		this.ctx.log.info({ terminal: terminal.id, shell, cwd, pid: pty.pid }, "terminal opened");
		return terminal.toJSON();
	}

	/** Make room for one more terminal: finished ones go first (oldest first); running ones are never evicted. */
	private makeRoom(): void {
		if (this.terminals.size < this.maxSessions) return;
		const finished = [...this.terminals.values()].filter((t) => t.status === "exited").sort((a, b) => (a.exitedAt?.getTime() ?? 0) - (b.exitedAt?.getTime() ?? 0));
		for (const old of finished) {
			if (this.terminals.size < this.maxSessions) return;
			this.remove(old, TERMINAL_CLOSE.removed, "terminal replaced");
		}
		if (this.terminals.size >= this.maxSessions) throw new ApiError(409, "terminal_limit", i18nMsg("At most {count} terminals can be open on this machine", { count: this.maxSessions }));
	}

	rename(id: string, title: string): TerminalSession {
		const terminal = this.require(id);
		terminal.title = title;
		this.broadcastSession(terminal);
		return terminal.toJSON();
	}

	/** Kill the shell (if running) and remove the terminal; attached browsers are told and disconnected. */
	kill(id: string): TerminalSession {
		const terminal = this.require(id);
		const snapshot = terminal.toJSON();
		this.remove(terminal, TERMINAL_CLOSE.removed, "terminal closed");
		return snapshot;
	}

	/** Stop every shell and detach every browser (server stop). */
	stop(): void {
		this.stopped = true;
		for (const terminal of [...this.terminals.values()]) this.remove(terminal, TERMINAL_CLOSE.shuttingDown, "server shutting down");
	}

	private remove(terminal: Terminal, closeCode: number, reason: string): void {
		this.terminals.delete(terminal.id);
		if (terminal.expiry) clearTimeout(terminal.expiry);
		if (terminal.drainTimer) clearInterval(terminal.drainTimer);
		terminal.drainTimer = null;
		for (const client of [...terminal.clients]) {
			terminal.clients.delete(client);
			client.close(closeCode, reason);
		}
		terminal.scrollback.clear();
		if (terminal.status === "running") this.terminate(terminal);
	}

	/** SIGHUP like a closing terminal window; SIGKILL if the shell ignores it. Only ever signals the process this service spawned. */
	private terminate(terminal: Terminal): void {
		const { pty } = terminal;
		try {
			pty.kill("SIGHUP");
		} catch {
			return;
		}
		terminal.escalation = setTimeout(() => {
			if (terminal.status === "exited") return;
			try {
				pty.kill("SIGKILL");
			} catch {
				// already gone
			}
		}, KILL_ESCALATE_MS);
		terminal.escalation.unref();
	}

	// ---------------------------------------------------------------------------------------------- output

	private onData(terminal: Terminal, data: Buffer): void {
		terminal.lastActivityAt = new Date();
		terminal.scrollback.push(data);
		for (const client of terminal.clients) client.sendBinary(data);
		this.applyBackpressure(terminal);
	}

	/**
	 * A browser that reads slower than the shell writes (`yes`, `cat bigfile`) would make its socket queue grow without bound:
	 * pause the PTY while any client is far behind and resume when they all caught up. A client that never catches up is dropped.
	 */
	private applyBackpressure(terminal: Terminal): void {
		if (terminal.paused || terminal.status !== "running") return;
		let worst = 0;
		for (const client of terminal.clients) worst = Math.max(worst, client.buffered());
		if (worst <= HIGH_WATER_BYTES) return;
		terminal.paused = true;
		terminal.pausedSince = Date.now();
		terminal.pty.pause();
		terminal.drainTimer = setInterval(() => this.checkDrain(terminal), DRAIN_POLL_MS);
		terminal.drainTimer.unref();
	}

	private checkDrain(terminal: Terminal): void {
		const stalled = Date.now() - terminal.pausedSince > STALL_LIMIT_MS;
		let worst = 0;
		for (const client of [...terminal.clients]) {
			const queued = client.buffered();
			if (stalled && queued > LOW_WATER_BYTES) {
				terminal.clients.delete(client);
				client.terminate();
				continue;
			}
			worst = Math.max(worst, queued);
		}
		if (worst > LOW_WATER_BYTES) return;
		this.release(terminal);
	}

	private release(terminal: Terminal): void {
		if (terminal.drainTimer) clearInterval(terminal.drainTimer);
		terminal.drainTimer = null;
		terminal.paused = false;
		if (terminal.status === "running") terminal.pty.resume();
	}

	private onExit(terminal: Terminal, exitCode: number, signal: number | null): void {
		if (terminal.escalation) clearTimeout(terminal.escalation);
		terminal.status = "exited";
		terminal.exitCode = signal ? null : exitCode;
		terminal.signal = signal && signal > 0 ? signal : null;
		terminal.exitedAt = new Date();
		terminal.lastActivityAt = terminal.exitedAt;
		if (terminal.drainTimer) clearInterval(terminal.drainTimer);
		terminal.drainTimer = null;
		this.ctx.log.info({ terminal: terminal.id, exitCode: terminal.exitCode, signal: terminal.signal }, "terminal exited");
		if (!this.terminals.has(terminal.id)) return; // killed through `kill`: already removed and everyone told
		for (const client of terminal.clients) {
			client.sendJson({ type: "exit", exitCode: terminal.exitCode, signal: terminal.signal });
			client.sendJson({ type: "session", session: terminal.toJSON() });
		}
		terminal.expiry = setTimeout(() => {
			if (this.terminals.get(terminal.id) === terminal) this.remove(terminal, TERMINAL_CLOSE.removed, "terminal expired");
		}, this.exitedTtlMs);
		terminal.expiry.unref();
	}

	// ---------------------------------------------------------------------------------------------- clients

	/**
	 * Attach a browser: it gets the session, then the scrollback as binary frames, `live`, and from then on every new byte.
	 * Everything is sent in this one synchronous call, so no output can slip between the replay and the live stream.
	 * Returns the function that detaches it.
	 */
	attach(id: string, client: TerminalClient): { session: TerminalSession; detach: () => void } {
		const terminal = this.require(id);
		const replay = terminal.scrollback.snapshot();
		const replayBytes = replay.reduce((n, chunk) => n + chunk.length, 0);
		terminal.clients.add(client);
		client.sendJson({ type: "attached", session: terminal.toJSON(), replayBytes });
		for (const chunk of replay) {
			for (let offset = 0; offset < chunk.length; offset += REPLAY_FRAME_BYTES) client.sendBinary(chunk.subarray(offset, offset + REPLAY_FRAME_BYTES));
		}
		client.sendJson({ type: "live" });
		if (terminal.status === "exited") client.sendJson({ type: "exit", exitCode: terminal.exitCode, signal: terminal.signal });
		this.broadcastSession(terminal, client);
		this.applyBackpressure(terminal);
		return {
			session: terminal.toJSON(),
			detach: () => {
				if (!terminal.clients.delete(client)) return;
				this.broadcastSession(terminal);
				// The client that held the PTY paused is gone: nobody is behind any more.
				if (terminal.paused && ![...terminal.clients].some((c) => c.buffered() > LOW_WATER_BYTES)) this.release(terminal);
			},
		};
	}

	/** Keystrokes / pasted text from a browser. Ignored once the shell has exited. */
	write(id: string, data: Buffer): void {
		const terminal = this.terminals.get(id);
		if (!terminal || terminal.status !== "running") return;
		terminal.lastActivityAt = new Date();
		terminal.pty.write(data);
	}

	resize(id: string, cols: number, rows: number): void {
		const terminal = this.terminals.get(id);
		if (!terminal || terminal.status !== "running" || (terminal.cols === cols && terminal.rows === rows)) return;
		try {
			terminal.pty.resize(cols, rows);
		} catch {
			return; // the shell ended between the check and the call
		}
		terminal.cols = cols;
		terminal.rows = rows;
		this.broadcastSession(terminal);
	}

	private broadcastSession(terminal: Terminal, except?: TerminalClient): void {
		if (terminal.clients.size === 0) return;
		const message: TerminalServerMessage = { type: "session", session: terminal.toJSON() };
		for (const client of terminal.clients) if (client !== except) client.sendJson(message);
	}
}
