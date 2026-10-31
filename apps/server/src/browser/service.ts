import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable, Writable } from "node:stream";
import { Transform } from "node:stream";
import type { BrowserDownload, BrowserExecutable, BrowserStatus, BrowserTab, ListeningPort } from "@clam/contracts";
import { projects } from "@clam/database";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { CdpConnection, type CdpEvent } from "./cdp.ts";
import { findBrowserExecutable, realDiscoveryEnv, type DiscoveryEnv } from "./executable.ts";
import { ChromiumInstaller, locateNpx } from "./installer.ts";
import { PortDiscovery } from "./ports.ts";
import { Tab, type ViewerHandle, type ViewerPort } from "./tab.ts";
import { isPermittedLocation, normalizeBrowserUrl, type UrlPolicy } from "./url.ts";

export const DEFAULT_IDLE_MS = 15 * 60_000;
const MAX_UPLOAD_BYTES = 1024 ** 3;
const START_TIMEOUT_MS = 60_000;
const TAB_BROADCAST_MS = 60;
const MAX_DOWNLOADS_LISTED = 50;

type BrowserContext = Pick<ServerContext, "config" | "db" | "log">;

export interface BrowserServiceOptions {
	/** Close the browser after this long with no viewer and no activity (`CLAM_BROWSER_IDLE_MS`; default 15 minutes). */
	idleMs?: number;
	/** Discovery environment override (tests). */
	discovery?: DiscoveryEnv;
	/** Listing of listening ports override (tests). */
	ports?: () => Promise<ListeningPort[]>;
	npx?: () => string | null;
}

const safeName = (raw: string, fallback: string): string => {
	const base = path.basename(raw.replaceAll("\\", "/")).replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^\.+/, "").trim().slice(0, 180);
	return base || fallback;
};

function uniquePath(dir: string, name: string): string {
	const ext = path.extname(name);
	const stem = name.slice(0, name.length - ext.length);
	let candidate = path.join(dir, name);
	for (let i = 1; existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
	return candidate;
}

interface Running {
	child: ChildProcess;
	cdp: CdpConnection;
}

/**
 * The machine's browser: ONE headless Chromium-family process (dedicated profile, controlled over a private pipe) started on first
 * use and closed after the idle window. Owns the tabs, downloads, uploads and the port discovery; knows nothing about HTTP or who
 * the caller is — the routes enforce access (`AccessService.assertTool`).
 */
export class BrowserService {
	private readonly dataDir: string;
	private readonly idleMs: number;
	private readonly discovery: DiscoveryEnv;
	private readonly installer: ChromiumInstaller;
	private portFinder: PortDiscovery | null = null;
	private readonly tabs = new Map<string, Tab>();
	private readonly bySession = new Map<string, Tab>();
	private readonly attaching = new Map<string, Promise<Tab | null>>();
	private readonly targetInfo = new Map<string, { title: string; url: string; type: string }>();
	private readonly downloadRecords = new Map<string, { guid: string; record: BrowserDownload }>();
	private running: Running | null = null;
	private starting: Promise<Running> | null = null;
	private state: BrowserStatus["state"] = "stopped";
	private error: string | null = null;
	private executableCache: { at: number; value: BrowserExecutable | null } | null = null;
	private idleTimer: NodeJS.Timeout | null = null;
	private broadcastTimer: NodeJS.Timeout | null = null;
	private lastActivity = Date.now();
	private initialBlank: string | null = null;
	private stopping = false;

	constructor(
		private readonly ctx: BrowserContext,
		private readonly options: BrowserServiceOptions = {},
	) {
		this.dataDir = ctx.config.dataDir;
		this.idleMs = options.idleMs ?? (Number(process.env.CLAM_BROWSER_IDLE_MS) || DEFAULT_IDLE_MS);
		this.discovery = options.discovery ?? realDiscoveryEnv(this.dataDir);
		this.installer = new ChromiumInstaller(this.dataDir, () => (this.executableCache = null), options.npx ?? (() => locateNpx()));
	}

	// ── paths & status ──────────────────────────────────────────────────────────────────────────

	get profileDir(): string {
		return path.join(this.dataDir, "browser-profile");
	}
	get downloadsDir(): string {
		return path.join(this.dataDir, "browser-downloads");
	}
	private get uploadsDir(): string {
		return path.join(this.dataDir, "browser-uploads");
	}

	executable(): BrowserExecutable | null {
		if (!this.executableCache || Date.now() - this.executableCache.at > 5_000) this.executableCache = { at: Date.now(), value: findBrowserExecutable(this.discovery) };
		return this.executableCache.value;
	}

	status(): BrowserStatus {
		const executable = this.executable();
		return {
			available: executable !== null,
			executable,
			state: this.state,
			error: this.error,
			tabCount: this.tabs.size,
			idleMinutes: Math.round((this.idleMs / 60_000) * 10) / 10,
			canInstall: executable === null && (this.options.npx ?? (() => locateNpx()))() !== null,
			install: this.installer.snapshot(),
			downloadsDir: this.downloadsDir,
		};
	}

	install(): BrowserStatus {
		if (this.executable()) throw ApiError.conflict("A browser is already available on this machine");
		this.installer.start();
		return this.status();
	}

	// ── policy ──────────────────────────────────────────────────────────────────────────────────

	private policy(): UrlPolicy {
		return {
			home: homedir(),
			isProjectFile: (file) => {
				for (const row of this.ctx.db.select({ path: projects.path }).from(projects).all()) {
					const roots = [row.path];
					try {
						roots.push(realpathSync(row.path));
					} catch {
						// a project folder that is gone allows nothing
					}
					for (const root of roots) {
						const rel = path.relative(root, file);
						if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
					}
				}
				return false;
			},
		};
	}

	/** Verdict of the URL policy for what the owner typed (also used by tests and the chat "open in browser" links). */
	normalize(input: string) {
		return normalizeBrowserUrl(input, this.policy());
	}

	// ── ports ───────────────────────────────────────────────────────────────────────────────────

	async ports(): Promise<ListeningPort[]> {
		this.touch();
		if (this.options.ports) return this.options.ports();
		this.portFinder ??= new PortDiscovery({
			selfPorts: () => [this.ctx.config.port, this.ctx.config.networkPort],
			selfPids: () => [process.pid, ...(this.running?.child.pid ? [this.running.child.pid] : [])],
		});
		return this.portFinder.list();
	}

	// ── lifecycle ───────────────────────────────────────────────────────────────────────────────

	private touch(): void {
		this.lastActivity = Date.now();
	}

	async ensureStarted(): Promise<void> {
		this.touch();
		if (this.starting) {
			await this.starting;
			return;
		}
		if (this.running && !this.running.cdp.isClosed) return;
		this.starting = this.launch().then(
			(running) => {
				this.starting = null;
				return running;
			},
			(error: unknown) => {
				this.starting = null;
				throw error;
			},
		);
		await this.starting;
	}

	private async launch(): Promise<Running> {
		const executable = this.executable();
		if (!executable) throw ApiError.unavailable("No Chromium-based browser was found on this machine. Install Chromium from the Browser page, or set CLAM_BROWSER_PATH.");
		this.state = "starting";
		this.error = null;
		mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
		mkdirSync(this.downloadsDir, { recursive: true, mode: 0o700 });
		rmSync(this.uploadsDir, { recursive: true, force: true });
		mkdirSync(this.uploadsDir, { recursive: true, mode: 0o700 });

		const args = [
			"--headless=new",
			"--remote-debugging-pipe",
			`--user-data-dir=${this.profileDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--password-store=basic",
			"--use-mock-keychain",
			"--disable-features=Translate,MediaRouter,OptimizationHints",
			"--disable-search-engine-choice-screen",
			"--mute-audio",
			"--force-color-profile=srgb",
			"--hide-crash-restore-bubble",
			...(process.platform === "linux" ? ["--disable-dev-shm-usage"] : []),
			...(process.env.CLAM_BROWSER_NO_SANDBOX === "1" || (process.platform === "linux" && process.getuid?.() === 0) ? ["--no-sandbox"] : []),
			"about:blank",
		];
		let stderr = "";
		let child: ChildProcess;
		try {
			child = spawn(executable.path, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
		} catch (error) {
			return this.failed(error instanceof Error ? error.message : String(error));
		}
		child.stderr?.on("data", (d: Buffer) => {
			stderr = (stderr + d.toString("utf8")).slice(-4000);
		});
		const exited = new Promise<never>((_resolve, reject) => {
			child.once("error", (error) => reject(new Error(`Could not start ${executable.name}: ${error.message}`)));
			child.once("exit", (code, signal) => reject(new Error(`${executable.name} exited during start (${signal ?? `code ${code}`})${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`)));
		});
		exited.catch(() => undefined);
		const cdp = new CdpConnection(child.stdio[3] as Writable, child.stdio[4] as Readable);
		const running: Running = { child, cdp };
		cdp.on((event) => this.onEvent(event));
		child.on("exit", (code, signal) => this.onExit(running, code, signal, stderr));
		try {
			await Promise.race([cdp.send("Browser.getVersion", {}, undefined, START_TIMEOUT_MS), exited]);
			this.running = running;
			await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.downloadsDir, eventsEnabled: true });
			await cdp.send("Target.setDiscoverTargets", { discover: true });
			const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string; title: string }> }>("Target.getTargets");
			for (const info of targetInfos) {
				this.targetInfo.set(info.targetId, { title: info.title, url: info.url, type: info.type });
				if (info.type === "page") {
					await this.attachTab(info.targetId);
					this.initialBlank ??= info.targetId;
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			running.cdp.close();
			child.kill("SIGKILL");
			this.running = null;
			return this.failed(message);
		}
		this.state = "running";
		this.armIdleTimer();
		this.ctx.log.info({ browser: executable.name, path: executable.path, pid: child.pid }, "machine browser started");
		return running;
	}

	private failed(message: string): never {
		this.state = "failed";
		this.error = message;
		this.ctx.log.warn({ error: message }, "machine browser failed to start");
		throw ApiError.unavailable(`The browser could not be started: ${message}`);
	}

	private onExit(running: Running, code: number | null, signal: NodeJS.Signals | null, stderr: string): void {
		running.cdp.close();
		if (this.running !== running) return;
		this.running = null;
		for (const tab of this.tabs.values()) tab.dispose("The browser stopped");
		this.tabs.clear();
		this.bySession.clear();
		this.targetInfo.clear();
		this.initialBlank = null;
		clearInterval(this.idleTimer ?? undefined);
		this.idleTimer = null;
		if (this.stopping) {
			this.state = "stopped";
			return;
		}
		this.state = "failed";
		this.error = `The browser exited unexpectedly (${signal ?? `code ${code}`})${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}. It starts again on next use.`;
		this.ctx.log.warn({ code, signal }, "machine browser exited unexpectedly");
	}

	private armIdleTimer(): void {
		clearInterval(this.idleTimer ?? undefined);
		this.idleTimer = setInterval(
			() => {
				const viewed = [...this.tabs.values()].some((t) => t.hasViewers);
				const lastUsed = Math.max(this.lastActivity, ...[...this.tabs.values()].map((t) => t.lastUsed));
				if (!viewed && Date.now() - lastUsed > this.idleMs) {
					this.ctx.log.info("machine browser closed after being idle");
					void this.stop();
				}
			},
			Math.min(30_000, Math.max(100, this.idleMs / 2)),
		);
		this.idleTimer.unref();
	}

	/** Close the browser (idle, shutdown). Only the process this service spawned is ever signalled. */
	async stop(): Promise<void> {
		this.installer.cancel();
		clearInterval(this.idleTimer ?? undefined);
		clearTimeout(this.broadcastTimer ?? undefined);
		const running = this.running;
		if (!running) return;
		this.stopping = true;
		try {
			await running.cdp.send("Browser.close", {}, undefined, 3_000).catch(() => undefined);
			if (running.child.exitCode === null) {
				const gone = Promise.withResolvers<void>();
				running.child.once("exit", () => gone.resolve());
				const timer = setTimeout(() => running.child.kill("SIGKILL"), 3_000);
				await gone.promise;
				clearTimeout(timer);
			}
		} finally {
			this.stopping = false;
			if (this.running === running) this.onExit(running, null, null, "");
			this.state = "stopped";
			this.error = null;
		}
	}

	// ── CDP events ──────────────────────────────────────────────────────────────────────────────

	private onEvent(event: CdpEvent): void {
		if (event.sessionId) {
			this.bySession.get(event.sessionId)?.handleEvent(event);
			return;
		}
		const p = event.params as Record<string, any>;
		switch (event.method) {
			case "Target.targetCreated": {
				const info = p.targetInfo;
				this.targetInfo.set(info.targetId, { title: info.title, url: info.url, type: info.type });
				if (info.type === "page") void this.attachTab(info.targetId);
				return;
			}
			case "Target.targetInfoChanged": {
				const info = p.targetInfo;
				this.targetInfo.set(info.targetId, { title: info.title, url: info.url, type: info.type });
				this.tabs.get(info.targetId)?.setTargetInfo({ title: info.title, url: info.url });
				return;
			}
			case "Target.targetDestroyed":
				this.targetInfo.delete(p.targetId);
				this.removeTab(p.targetId, "This tab was closed");
				return;
			case "Browser.downloadWillBegin": {
				const name = safeName(String(p.suggestedFilename ?? ""), "download");
				const record: BrowserDownload = { name, size: 0, received: 0, state: "inProgress", startedAt: new Date().toISOString(), sourceUrl: String(p.url ?? "").slice(0, 2000) };
				this.downloadRecords.set(p.guid, { guid: p.guid, record });
				this.pushDownload(record);
				return;
			}
			case "Browser.downloadProgress": {
				const entry = this.downloadRecords.get(p.guid);
				if (!entry) return;
				const { record } = entry;
				record.received = Math.round(Number(p.receivedBytes ?? 0));
				record.size = Math.max(record.size, Math.round(Number(p.totalBytes ?? 0)), record.received);
				if (p.state === "completed") {
					const from = path.join(this.downloadsDir, p.guid);
					const to = uniquePath(this.downloadsDir, record.name);
					try {
						renameSync(from, to);
						record.name = path.basename(to);
						record.state = "completed";
					} catch {
						record.state = "canceled";
					}
				} else if (p.state === "canceled") record.state = "canceled";
				this.pushDownload(record);
				if (record.state !== "inProgress") this.downloadRecords.delete(p.guid);
				return;
			}
			default:
		}
	}

	private pushDownload(record: BrowserDownload): void {
		for (const tab of this.tabs.values()) tab.broadcastDownload({ ...record });
	}

	// ── tabs ────────────────────────────────────────────────────────────────────────────────────

	private attachTab(targetId: string): Promise<Tab | null> {
		// A tab is registered before its setup finishes: callers must wait for the setup that is already running.
		const inflight = this.attaching.get(targetId);
		if (inflight) return inflight;
		const known = this.tabs.get(targetId);
		if (known) return Promise.resolve(known);
		const running = this.running;
		const work = (async (): Promise<Tab | null> => {
			if (!running) return null;
			try {
				const { sessionId } = await running.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
				const tab = new Tab(targetId, sessionId, running.cdp, {
					log: this.ctx.log,
					changed: () => this.scheduleTabsBroadcast(),
					navigate: (t, input) => this.navigateTab(t, input),
					takeUploads: (uploadId) => this.takeUploads(uploadId),
					checkLocation: (url) => isPermittedLocation(url, this.policy()),
					downloads: () => this.listDownloads(),
				});
				this.tabs.set(targetId, tab);
				this.bySession.set(sessionId, tab);
				await tab.enable();
				const info = this.targetInfo.get(targetId);
				if (info) tab.setTargetInfo({ title: info.title, url: info.url });
				this.scheduleTabsBroadcast();
				return tab;
			} catch (error) {
				this.ctx.log.debug({ err: error, targetId }, "could not attach to a browser tab");
				return null;
			} finally {
				this.attaching.delete(targetId);
			}
		})();
		this.attaching.set(targetId, work);
		return work;
	}

	private removeTab(targetId: string, reason: string): void {
		const tab = this.tabs.get(targetId);
		if (!tab) return;
		this.tabs.delete(targetId);
		this.bySession.delete(tab.sessionId);
		if (this.initialBlank === targetId) this.initialBlank = null;
		tab.dispose(reason);
		this.scheduleTabsBroadcast();
	}

	private scheduleTabsBroadcast(): void {
		if (this.broadcastTimer) return;
		this.broadcastTimer = setTimeout(() => {
			this.broadcastTimer = null;
			const list = this.listTabs();
			for (const tab of this.tabs.values()) tab.sendTabs(list);
		}, TAB_BROADCAST_MS);
	}

	listTabs(): BrowserTab[] {
		return [...this.tabs.values()].map((tab) => tab.snapshot());
	}

	tab(id: string): Tab | undefined {
		return this.tabs.get(id);
	}

	async openTab(input?: string): Promise<BrowserTab> {
		let url: string | null = null;
		if (input !== undefined && input.trim() !== "") {
			const verdict = this.normalize(input);
			if (!verdict.ok) throw new ApiError(400, verdict.code === "blocked" ? "url_blocked" : "invalid_url", verdict.message);
			url = verdict.url;
		}
		await this.ensureStarted();
		// The page the browser opened with is reused for the first tab instead of leaving a stray blank one behind.
		const blank = this.initialBlank ? this.tabs.get(this.initialBlank) : undefined;
		if (blank && this.tabs.size === 1 && blank.snapshot().url === "") {
			this.initialBlank = null;
			if (url) await blank.navigateTo(url);
			return blank.snapshot();
		}
		const running = this.running;
		if (!running) throw ApiError.unavailable("The browser is not running");
		const { targetId } = await running.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
		const tab = await this.attachTab(targetId);
		if (!tab) throw ApiError.unavailable("The new tab could not be opened");
		if (url) await tab.navigateTo(url);
		return tab.snapshot();
	}

	async closeTab(id: string): Promise<void> {
		const tab = this.tabs.get(id);
		if (!tab || !this.running) throw ApiError.notFound("Tab");
		await this.running.cdp.send("Target.closeTarget", { targetId: id }).catch(() => undefined);
		this.removeTab(id, "This tab was closed");
	}

	async navigate(id: string, input: string): Promise<BrowserTab> {
		const tab = this.tabs.get(id);
		if (!tab) throw ApiError.notFound("Tab");
		const problem = await this.navigateTab(tab, input);
		if (problem) throw new ApiError(400, "url_blocked", problem);
		return tab.snapshot();
	}

	private async navigateTab(tab: Tab, input: string): Promise<string | null> {
		const verdict = this.normalize(input);
		if (!verdict.ok) return verdict.message;
		await tab.navigateTo(verdict.url);
		return null;
	}

	/** Attach a viewer to a tab; null when the tab does not exist (closed, or the browser stopped since). */
	attachViewer(tabId: string, port: ViewerPort): { tab: Tab; handle: ViewerHandle } | null {
		const tab = this.tabs.get(tabId);
		if (!tab) return null;
		this.touch();
		return { tab, handle: tab.addViewer(port) };
	}

	// ── downloads & uploads ─────────────────────────────────────────────────────────────────────

	listDownloads(): BrowserDownload[] {
		const live = [...this.downloadRecords.values()].map((e) => ({ ...e.record }));
		const liveNames = new Set(live.map((d) => d.name));
		const files: BrowserDownload[] = [];
		try {
			for (const name of readdirSync(this.downloadsDir)) {
				if (liveNames.has(name) || /^[0-9A-F-]{36}$/i.test(name)) continue; // in-flight temp files are named by their guid
				const stat = statSync(path.join(this.downloadsDir, name));
				if (stat.isFile()) files.push({ name, size: stat.size, received: stat.size, state: "completed", startedAt: stat.mtime.toISOString(), sourceUrl: "" });
			}
		} catch {
			// no downloads directory yet
		}
		files.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
		return [...live, ...files.slice(0, MAX_DOWNLOADS_LISTED)];
	}

	/** A finished download by name, for the file route; null for anything that is not a plain file in the downloads directory. */
	downloadFile(name: string): { file: string; size: number } | null {
		if (!name || name !== path.basename(name) || name.startsWith(".")) return null;
		const file = path.join(this.downloadsDir, name);
		try {
			const stat = statSync(file);
			return stat.isFile() ? { file, size: stat.size } : null;
		} catch {
			return null;
		}
	}

	/** Receive one file for a pending file chooser. */
	async receiveUpload(uploadId: string, name: string, body: Readable): Promise<void> {
		if (!/^[0-9a-f-]{36}$/i.test(uploadId) || ![...this.tabs.values()].some((t) => t.pendingUploadId === uploadId)) throw ApiError.notFound("Upload");
		this.touch();
		const dir = path.join(this.uploadsDir, uploadId);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const target = uniquePath(dir, safeName(name, `file-${randomUUID().slice(0, 8)}`));
		let total = 0;
		const limit = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				total += chunk.length;
				callback(total > MAX_UPLOAD_BYTES ? new Error("upload too large") : null, chunk);
			},
		});
		try {
			await pipeline(body, limit, createWriteStream(target, { mode: 0o600 }));
		} catch (error) {
			rmSync(target, { force: true });
			throw error instanceof Error && error.message === "upload too large" ? new ApiError(413, "too_large", "That file is too large to upload") : error;
		}
	}

	private async takeUploads(uploadId: string): Promise<string[]> {
		const dir = path.join(this.uploadsDir, uploadId);
		try {
			return readdirSync(dir).map((name) => path.join(dir, name));
		} catch {
			return [];
		}
	}
}
