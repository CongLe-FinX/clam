import { randomUUID } from "node:crypto";
import type { BrowserClientMessage, BrowserConsoleEntry, BrowserDialog, BrowserDownload, BrowserServerMessage, BrowserTab, BrowserViewport } from "@clam/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { CdpConnection, CdpEvent } from "./cdp.ts";
import { computeViewport, describeRemoteObject, IPHONE_USER_AGENT, keyEventParams, sameViewport, type ViewerSize } from "./emulation.ts";

/** A connected viewer (one WebSocket). */
export interface ViewerPort {
	send(message: BrowserServerMessage): void;
	/** Queue one screencast frame (header + JPEG). */
	sendFrame(frame: Buffer): void;
	/** Bytes written to the socket but not yet sent: the back-pressure signal. */
	buffered(): number;
}

interface Viewer {
	port: ViewerPort;
	visible: boolean;
	size: ViewerSize | null;
	/** Order in which viewers last sent their size: the latest visible one decides the emulated viewport. */
	sizedAt: number;
}

/** What a socket handler gets back from `Tab.addViewer`. */
export interface ViewerHandle {
	message(message: BrowserClientMessage): void;
	dispose(): void;
}

export interface TabHooks {
	log: FastifyBaseLogger;
	/** The tab's own state changed (title, url, loading…): the service re-broadcasts the tab list. */
	changed(tab: Tab): void;
	/** `Page.navigate` etc. are routed through here so the URL policy stays in one place. */
	navigate(tab: Tab, input: string): Promise<string | null>;
	/** Files the viewer uploaded for a file chooser, as absolute paths; consumes them. */
	takeUploads(uploadId: string): Promise<string[]>;
	/** A page navigated somewhere the policy forbids (called with the URL it landed on). */
	checkLocation(url: string): boolean;
	downloads(): BrowserDownload[];
}

const CONSOLE_LIMIT = 500;
const HIGH_WATER = 384 * 1024;
const QUALITY_STEPS = [35, 50, 65, 80] as const;
const FAVICON_MAX_BYTES = 32 * 1024;
const FAVICON_SCRIPT = `(async () => {
  try {
    const links = [...document.querySelectorAll('link[rel~="icon"]')];
    const href = links.length ? links[links.length - 1].href : location.origin + '/favicon.ico';
    const response = await fetch(href, { credentials: 'omit' });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.size > ${FAVICON_MAX_BYTES} || !blob.type.startsWith('image/')) return null;
    return await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => resolve(null); reader.readAsDataURL(blob); });
  } catch { return null; }
})()`;
/** Pages announce their title through a binding: `Target.targetInfoChanged` does not reliably report title changes of an attached tab. */
const META_BINDING = "__clamMeta";
const META_SCRIPT = `(() => {
  if (window.top !== window || window.__clamMetaOn) return;
  window.__clamMetaOn = true;
  let last = null;
  const announce = () => {
    const title = document.title;
    if (title === last) return;
    last = title;
    try { window.${META_BINDING}(title.slice(0, 500)); } catch {}
  };
  new MutationObserver(announce).observe(document, { subtree: true, childList: true, characterData: true });
  document.addEventListener('DOMContentLoaded', announce);
  window.addEventListener('load', announce);
  announce();
})();`;
const COPY_SCRIPT = `(() => {
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number' && el.selectionStart !== el.selectionEnd) return el.value.substring(el.selectionStart, el.selectionEnd);
  return String(getSelection());
})()`;

/**
 * One browser tab: its CDP session, the viewers watching it, the screencast (running only while a visible viewer exists),
 * the viewport emulation, the console buffer, dialogs and file choosers. Created and owned by `BrowserService`.
 */
export class Tab {
	private title = "";
	private url = "";
	private unreachableUrl: string | null = null;
	private faviconUrl: string | null = null;
	private loading = false;
	private progress = 0;
	private canGoBack = false;
	private canGoForward = false;
	/** The title the page announced for the current document (null until it does). */
	private pageTitle: string | null = null;
	private mainFrameId = "";
	private pendingRequests = 0;
	private finishedRequests = 0;
	private requests = new Map<string, { method: string; url: string }>();
	private dialog: BrowserDialog | null = null;
	private fileChooser: { multiple: boolean; uploadId: string; backendNodeId: number | undefined } | null = null;
	private viewport: BrowserViewport | null = null;
	private screencasting = false;
	private screencastKey = "";
	private quality = 65;
	private frameSeq = 0;
	private qualityWindow = { at: Date.now(), pressure: 0, frames: 0, calm: 0 };
	private consoleSeq = 0;
	private readonly console: BrowserConsoleEntry[] = [];
	private readonly viewers = new Set<Viewer>();
	private sizeCounter = 0;
	private historyTimer: NodeJS.Timeout | null = null;
	private faviconTimer: NodeJS.Timeout | null = null;
	private disposed = false;
	/** Last activity by a viewer (input, navigation): the service's idle timer reads it. */
	lastUsed = Date.now();

	constructor(
		readonly id: string,
		readonly sessionId: string,
		private readonly cdp: CdpConnection,
		private readonly hooks: TabHooks,
	) {}

	// ── setup ───────────────────────────────────────────────────────────────────────────────────

	async enable(): Promise<void> {
		const send = (method: string, params?: Record<string, unknown>): Promise<unknown> => this.cdp.send(method, params, this.sessionId).catch((error: Error) => this.hooks.log.debug({ err: error, method }, "tab setup command failed"));
		await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Log.enable"), send("Network.enable"), send("DOM.enable")]);
		await send("Runtime.addBinding", { name: META_BINDING });
		await Promise.all([
			send("Page.addScriptToEvaluateOnNewDocument", { source: META_SCRIPT }),
			send("Runtime.evaluate", { expression: META_SCRIPT }),
			send("Page.setInterceptFileChooserDialog", { enabled: true }),
			send("Emulation.setFocusEmulationEnabled", { enabled: true }),
			send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }),
		]);
		const tree = (await this.cdp.send<{ frameTree?: { frame?: { id?: string } } }>("Page.getFrameTree", {}, this.sessionId).catch(() => ({}))) as { frameTree?: { frame?: { id?: string } } };
		this.mainFrameId = tree.frameTree?.frame?.id ?? "";
		await this.refreshHistory();
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	// ── state ───────────────────────────────────────────────────────────────────────────────────

	snapshot(): BrowserTab {
		const url = this.unreachableUrl ?? this.url;
		return {
			id: this.id,
			title: this.title || (url && url !== "about:blank" ? safeHost(url) : "New tab"),
			url: url === "about:blank" ? "" : url,
			faviconUrl: this.faviconUrl,
			loading: this.loading,
			progress: this.loading ? this.progress : 0,
			canGoBack: this.canGoBack,
			canGoForward: this.canGoForward,
		};
	}

	hello(tabs: BrowserTab[]): BrowserServerMessage {
		return { type: "hello", tab: this.snapshot(), tabs, viewport: this.viewport, dialog: this.dialog, fileChooser: this.fileChooser ? { multiple: this.fileChooser.multiple, uploadId: this.fileChooser.uploadId } : null, console: [...this.console], downloads: this.hooks.downloads() };
	}

	get pendingUploadId(): string | null {
		return this.fileChooser?.uploadId ?? null;
	}

	sendTabs(tabs: BrowserTab[]): void {
		this.broadcast({ type: "tabs", tabs });
	}

	broadcastDownload(download: BrowserDownload): void {
		this.broadcast({ type: "download", download });
	}

	get hasViewers(): boolean {
		return this.viewers.size > 0;
	}

	private broadcast(message: BrowserServerMessage): void {
		for (const viewer of this.viewers) viewer.port.send(message);
	}

	/** Target info (title, url) pushed by the browser. Returns false when the page landed somewhere the policy forbids. */
	setTargetInfo(info: { title?: string; url?: string }): void {
		let changed = false;
		if (info.url !== undefined && info.url !== this.url) {
			this.url = info.url;
			changed = true;
		}
		// Once the page has announced its own title, the (older, less reliable) target info stops deciding it.
		if (info.title !== undefined && this.pageTitle === null && info.title !== this.title && info.title !== this.url) {
			this.title = info.title;
			changed = true;
		}
		if (info.url !== undefined && !this.hooks.checkLocation(info.url)) {
			this.pushConsole({ kind: "network", level: "error", text: `Blocked navigation to ${info.url.slice(0, 200)}`, url: info.url, line: null });
			void this.cdp.send("Page.navigate", { url: "about:blank" }, this.sessionId).catch(() => undefined);
			return;
		}
		if (changed) this.hooks.changed(this);
	}

	private setTitle(title: string): void {
		if (title === this.title) return;
		this.title = title;
		this.hooks.changed(this);
	}

	private setLoading(loading: boolean, progress: number): void {
		if (this.loading === loading && Math.abs(this.progress - progress) < 0.02) return;
		this.loading = loading;
		this.progress = progress;
		this.hooks.changed(this);
	}

	private scheduleHistoryRefresh(): void {
		if (this.historyTimer || this.disposed) return;
		this.historyTimer = setTimeout(() => {
			this.historyTimer = null;
			void this.refreshHistory();
		}, 80);
	}

	private async refreshHistory(): Promise<void> {
		const history = await this.cdp.send<{ currentIndex: number; entries: unknown[] }>("Page.getNavigationHistory", {}, this.sessionId).catch(() => null);
		if (!history || this.disposed) return;
		const back = history.currentIndex > 0;
		const forward = history.currentIndex < history.entries.length - 1;
		if (back !== this.canGoBack || forward !== this.canGoForward) {
			this.canGoBack = back;
			this.canGoForward = forward;
			this.hooks.changed(this);
		}
	}

	private scheduleFavicon(): void {
		if (this.faviconTimer || this.disposed || !/^https?:/.test(this.url)) return;
		this.faviconTimer = setTimeout(() => {
			this.faviconTimer = null;
			void this.cdp
				.send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression: FAVICON_SCRIPT, awaitPromise: true, returnByValue: true }, this.sessionId, 8_000)
				.then((answer) => {
					const value = answer.result?.value;
					const next = typeof value === "string" && value.startsWith("data:image/") ? value : null;
					if (next !== this.faviconUrl) {
						this.faviconUrl = next;
						this.hooks.changed(this);
					}
				})
				.catch(() => undefined);
		}, 400);
	}

	// ── CDP events ──────────────────────────────────────────────────────────────────────────────

	handleEvent(event: CdpEvent): void {
		const p = event.params as Record<string, any>;
		switch (event.method) {
			case "Page.screencastFrame":
				this.onFrame(p);
				return;
			case "Runtime.bindingCalled":
				if (p.name === META_BINDING && typeof p.payload === "string") {
					this.pageTitle = p.payload;
					this.setTitle(p.payload);
				}
				return;
			case "Page.javascriptDialogOpening":
				this.dialog = { kind: p.type, message: String(p.message ?? ""), defaultPrompt: String(p.defaultPrompt ?? ""), url: String(p.url ?? "") };
				this.broadcast({ type: "dialog", dialog: this.dialog });
				return;
			case "Page.javascriptDialogClosed":
				this.dialog = null;
				this.broadcast({ type: "dialog", dialog: null });
				return;
			case "Page.fileChooserOpened":
				this.fileChooser = { multiple: p.mode === "selectMultiple", uploadId: randomUUID(), backendNodeId: typeof p.backendNodeId === "number" ? p.backendNodeId : undefined };
				this.broadcast({ type: "file-chooser", fileChooser: { multiple: this.fileChooser.multiple, uploadId: this.fileChooser.uploadId } });
				return;
			case "Page.frameStartedLoading":
				if (p.frameId === this.mainFrameId || this.mainFrameId === "") {
					this.pendingRequests = 0;
					this.finishedRequests = 0;
					this.unreachableUrl = null;
					this.setLoading(true, 0.1);
				}
				return;
			case "Page.frameNavigated":
				if (!p.frame?.parentId) {
					this.mainFrameId = p.frame.id;
					this.unreachableUrl = typeof p.frame.unreachableUrl === "string" ? p.frame.unreachableUrl : null;
					this.faviconUrl = null;
					this.pageTitle = null;
					this.scheduleHistoryRefresh();
					this.hooks.changed(this);
				}
				return;
			case "Page.navigatedWithinDocument":
				this.scheduleHistoryRefresh();
				return;
			case "Page.domContentEventFired":
				this.setLoading(true, 0.7);
				return;
			case "Page.loadEventFired":
				this.setLoading(false, 1);
				this.scheduleFavicon();
				return;
			case "Page.frameStoppedLoading":
				if (p.frameId === this.mainFrameId) this.setLoading(false, 1);
				return;
			case "Runtime.consoleAPICalled": {
				const level = p.type === "warning" ? "warn" : ["log", "info", "error", "debug"].includes(p.type) ? p.type : p.type === "assert" ? "error" : "log";
				const args = (p.args ?? []) as Array<Parameters<typeof describeRemoteObject>[0]>;
				const frame = p.stackTrace?.callFrames?.[0];
				this.pushConsole({ kind: "console", level, text: args.map(describeRemoteObject).join(" "), url: frame?.url || null, line: typeof frame?.lineNumber === "number" ? frame.lineNumber + 1 : null });
				return;
			}
			case "Runtime.exceptionThrown": {
				const details = p.exceptionDetails ?? {};
				const text = String(details.exception?.description ?? details.text ?? "Uncaught exception").split("\n").slice(0, 8).join("\n");
				this.pushConsole({ kind: "exception", level: "error", text, url: details.url || null, line: typeof details.lineNumber === "number" ? details.lineNumber + 1 : null });
				return;
			}
			case "Log.entryAdded": {
				const entry = p.entry ?? {};
				if (entry.source === "network") return; // the Network domain reports these with the method and URL
				const level = entry.level === "warning" ? "warn" : entry.level === "error" ? "error" : "info";
				this.pushConsole({ kind: "log", level, text: String(entry.text ?? ""), url: entry.url || null, line: typeof entry.lineNumber === "number" ? entry.lineNumber + 1 : null });
				return;
			}
			case "Network.requestWillBeSent":
				this.pendingRequests++;
				this.requests.set(p.requestId, { method: String(p.request?.method ?? "GET"), url: String(p.request?.url ?? "") });
				if (this.requests.size > 600) this.requests.delete(this.requests.keys().next().value as string);
				return;
			case "Network.responseReceived": {
				const status = Number(p.response?.status ?? 0);
				if (status >= 400 && p.type !== "Ping") {
					const request = this.requests.get(p.requestId);
					this.pushConsole({ kind: "network", level: "error", text: `${request?.method ?? "GET"} ${status} ${p.response?.statusText ?? ""}`.trim(), url: String(p.response?.url ?? request?.url ?? ""), line: null });
				}
				return;
			}
			case "Network.loadingFinished":
				this.requests.delete(p.requestId);
				this.finishedRequests++;
				if (this.loading && this.pendingRequests > 0) this.setLoading(true, Math.min(0.9, 0.1 + 0.8 * (this.finishedRequests / this.pendingRequests)));
				return;
			case "Network.loadingFailed": {
				const request = this.requests.get(p.requestId);
				this.requests.delete(p.requestId);
				this.finishedRequests++;
				if (!p.canceled && p.errorText !== "net::ERR_ABORTED") this.pushConsole({ kind: "network", level: "error", text: `${request?.method ?? "GET"} failed: ${p.errorText ?? "network error"}`, url: request?.url ?? null, line: null });
				return;
			}
			default:
		}
	}

	private pushConsole(entry: Omit<BrowserConsoleEntry, "id" | "ts">): void {
		const full: BrowserConsoleEntry = { id: ++this.consoleSeq, ts: Date.now(), ...entry, text: entry.text.slice(0, 4000) };
		this.console.push(full);
		if (this.console.length > CONSOLE_LIMIT) this.console.shift();
		this.broadcast({ type: "console", entry: full });
	}

	// ── viewers ─────────────────────────────────────────────────────────────────────────────────

	addViewer(port: ViewerPort): ViewerHandle {
		const viewer: Viewer = { port, visible: true, size: null, sizedAt: 0 };
		this.viewers.add(viewer);
		this.lastUsed = Date.now();
		void this.cdp.send("Page.bringToFront", {}, this.sessionId).catch(() => undefined);
		return {
			message: (message) => void this.onViewerMessage(viewer, message),
			dispose: () => {
				this.viewers.delete(viewer);
				void this.syncScreencast();
			},
		};
	}

	private async onViewerMessage(viewer: Viewer, message: BrowserClientMessage): Promise<void> {
		this.lastUsed = Date.now();
		const send = (method: string, params: Record<string, unknown>): void => void this.cdp.send(method, params, this.sessionId).catch((error: Error) => this.hooks.log.debug({ err: error, method }, "browser input failed"));
		try {
			switch (message.type) {
				case "viewer":
					viewer.size = { width: message.width, height: message.height, dpr: message.dpr, device: message.device };
					viewer.sizedAt = ++this.sizeCounter;
					await this.syncScreencast();
					return;
				case "visible":
					viewer.visible = message.visible;
					await this.syncScreencast();
					return;
				case "mouse": {
					const modifiers = message.modifiers;
					if (message.action === "wheel") send("Input.dispatchMouseEvent", { type: "mouseWheel", x: message.x, y: message.y, deltaX: message.deltaX, deltaY: message.deltaY, modifiers });
					else {
						const type = message.action === "move" ? "mouseMoved" : message.action === "down" ? "mousePressed" : "mouseReleased";
						send("Input.dispatchMouseEvent", { type, x: message.x, y: message.y, button: message.action === "move" && message.buttons === 0 ? "none" : message.button, buttons: message.buttons, clickCount: message.action === "move" ? 0 : message.clickCount, modifiers });
					}
					return;
				}
				case "touch": {
					const type = { start: "touchStart", move: "touchMove", end: "touchEnd", cancel: "touchCancel" }[message.action];
					send("Input.dispatchTouchEvent", { type, touchPoints: message.points.map((p) => ({ x: p.x, y: p.y, id: p.id })), modifiers: message.modifiers });
					return;
				}
				case "key":
					send("Input.dispatchKeyEvent", keyEventParams(message));
					return;
				case "text":
					send("Input.insertText", { text: message.text });
					return;
				case "copy": {
					const answer = await this.cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression: COPY_SCRIPT, returnByValue: true }, this.sessionId, 5_000);
					const value = answer.result?.value;
					viewer.port.send({ type: "clipboard", text: typeof value === "string" ? value.slice(0, 1_000_000) : "" });
					return;
				}
				case "navigate": {
					const problem = await this.hooks.navigate(this, message.url);
					if (problem) viewer.port.send({ type: "error", message: problem });
					return;
				}
				case "history":
					await this.history(message.action);
					return;
				case "dialog":
					send("Page.handleJavaScriptDialog", { accept: message.accept, ...(message.promptText !== undefined && { promptText: message.promptText }) });
					return;
				case "file-chooser-done": {
					const chooser = this.fileChooser;
					if (!chooser) return;
					this.fileChooser = null;
					this.broadcast({ type: "file-chooser", fileChooser: null });
					const files = message.uploadId && message.uploadId === chooser.uploadId ? await this.hooks.takeUploads(message.uploadId) : [];
					await this.cdp.send("DOM.setFileInputFiles", { files, ...(chooser.backendNodeId !== undefined && { backendNodeId: chooser.backendNodeId }) }, this.sessionId).catch((error: Error) => viewer.port.send({ type: "error", message: `Could not attach the file: ${error.message}` }));
					return;
				}
				case "console-clear":
					this.console.length = 0;
					this.broadcast({ type: "console-cleared" });
					return;
				case "ping":
					viewer.port.send({ type: "pong", t: message.t });
					return;
			}
		} catch (error) {
			this.hooks.log.debug({ err: error, type: message.type }, "browser viewer message failed");
		}
	}

	async history(action: "back" | "forward" | "reload" | "stop"): Promise<void> {
		if (action === "reload") await this.cdp.send("Page.reload", {}, this.sessionId);
		else if (action === "stop") await this.cdp.send("Page.stopLoading", {}, this.sessionId);
		else {
			const history = await this.cdp.send<{ currentIndex: number; entries: Array<{ id: number }> }>("Page.getNavigationHistory", {}, this.sessionId);
			const target = history.entries[history.currentIndex + (action === "back" ? -1 : 1)];
			if (target) await this.cdp.send("Page.navigateToHistoryEntry", { entryId: target.id }, this.sessionId);
		}
	}

	async navigateTo(url: string): Promise<void> {
		this.lastUsed = Date.now();
		await this.cdp.send("Page.navigate", { url }, this.sessionId);
	}

	// ── viewport + screencast ───────────────────────────────────────────────────────────────────

	private controller(): Viewer | null {
		let best: Viewer | null = null;
		for (const viewer of this.viewers) if (viewer.visible && viewer.size && (!best || viewer.sizedAt > best.sizedAt)) best = viewer;
		return best;
	}

	private syncing: Promise<void> = Promise.resolve();

	/** Viewport + screencast follow the viewers; changes are applied one at a time, in order. */
	private syncScreencast(): Promise<void> {
		this.syncing = this.syncing.then(() => this.applyScreencast());
		return this.syncing;
	}

	private async applyScreencast(): Promise<void> {
		if (this.disposed) return;
		const controller = this.controller();
		if (!controller?.size) {
			await this.stopScreencast();
			return;
		}
		const next = computeViewport(controller.size);
		if (!sameViewport(this.viewport, next)) {
			const previous = this.viewport;
			this.viewport = next;
			// Touch and user agent first: the page reads them when the resize that follows reaches it.
			if (previous?.mobile !== next.mobile) {
				await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: next.mobile, maxTouchPoints: 5 }, this.sessionId).catch(() => undefined);
				await this.cdp.send("Emulation.setUserAgentOverride", { userAgent: next.mobile ? IPHONE_USER_AGENT : "", ...(next.mobile && { platform: "iPhone" }) }, this.sessionId).catch(() => undefined);
			}
			await this.cdp.send("Emulation.setDeviceMetricsOverride", { width: next.width, height: next.height, deviceScaleFactor: next.deviceScale, mobile: next.mobile, screenWidth: next.width, screenHeight: next.height, ...(next.mobile && { screenOrientation: { type: "portraitPrimary", angle: 0 } }) }, this.sessionId).catch(() => undefined);
			this.broadcast({ type: "viewport", viewport: next });
		}
		await this.startScreencast(next);
	}

	private async startScreencast(viewport: BrowserViewport): Promise<void> {
		const key = `${viewport.width}x${viewport.height}@${viewport.deviceScale}/${this.quality}`;
		if (this.screencasting && this.screencastKey === key) return;
		if (this.screencasting) await this.cdp.send("Page.stopScreencast", {}, this.sessionId).catch(() => undefined);
		this.screencasting = true;
		this.screencastKey = key;
		await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: this.quality, maxWidth: Math.ceil(viewport.width * viewport.deviceScale), maxHeight: Math.ceil(viewport.height * viewport.deviceScale), everyNthFrame: 1 }, this.sessionId).catch(() => {
			this.screencasting = false;
		});
	}

	private async stopScreencast(): Promise<void> {
		if (!this.screencasting) return;
		this.screencasting = false;
		this.screencastKey = "";
		await this.cdp.send("Page.stopScreencast", {}, this.sessionId).catch(() => undefined);
	}

	private onFrame(params: Record<string, any>): void {
		const frameSession = params.sessionId as number;
		const ack = (): void => void this.cdp.send("Page.screencastFrameAck", { sessionId: frameSession }, this.sessionId).catch(() => undefined);
		const receivers = [...this.viewers].filter((v) => v.visible);
		if (receivers.length === 0 || !this.screencasting) {
			ack();
			return;
		}
		const jpeg = Buffer.from(String(params.data), "base64");
		const header = Buffer.allocUnsafe(8);
		header.writeUInt32LE(this.frameSeq++ >>> 0, 0);
		header.writeUInt16LE(Math.round(params.metadata?.deviceWidth ?? this.viewport?.width ?? 0), 4);
		header.writeUInt16LE(Math.round(params.metadata?.deviceHeight ?? this.viewport?.height ?? 0), 6);
		const frame = Buffer.concat([header, jpeg]);
		let worst = 0;
		for (const viewer of receivers) {
			worst = Math.max(worst, viewer.port.buffered());
			viewer.port.sendFrame(frame);
		}
		this.adaptQuality(worst);
		// Back-pressure: do not ask the browser for the next frame while a viewer's socket is still backed up.
		if (worst < HIGH_WATER) ack();
		else void this.ackWhenDrained(receivers, ack);
	}

	private async ackWhenDrained(receivers: Viewer[], ack: () => void): Promise<void> {
		const deadline = Date.now() + 2_000;
		while (Date.now() < deadline && !this.disposed && receivers.some((v) => this.viewers.has(v) && v.port.buffered() >= HIGH_WATER / 2)) await new Promise((resolve) => setTimeout(resolve, 25));
		ack();
	}

	/** Lower the JPEG quality while sockets stay backed up (slow link), raise it again after a calm stretch. */
	private adaptQuality(buffered: number): void {
		const w = this.qualityWindow;
		w.frames++;
		if (buffered > 128 * 1024) w.pressure++;
		if (Date.now() - w.at < 3_000) return;
		const index = QUALITY_STEPS.indexOf(this.quality as (typeof QUALITY_STEPS)[number]);
		const pressured = w.pressure > w.frames / 3;
		if (pressured && index > 0) {
			this.quality = QUALITY_STEPS[index - 1]!;
			w.calm = 0;
		} else if (!pressured && w.pressure === 0) {
			w.calm++;
			if (w.calm >= 2 && index < QUALITY_STEPS.length - 1) {
				this.quality = QUALITY_STEPS[index + 1]!;
				w.calm = 0;
			}
		}
		this.qualityWindow = { at: Date.now(), pressure: 0, frames: 0, calm: w.calm };
		if (this.screencasting) void this.syncScreencast();
	}

	// ── teardown ────────────────────────────────────────────────────────────────────────────────

	dispose(reason: string): void {
		if (this.disposed) return;
		this.disposed = true;
		clearTimeout(this.historyTimer ?? undefined);
		clearTimeout(this.faviconTimer ?? undefined);
		this.broadcast({ type: "closed", reason });
		this.viewers.clear();
	}
}

function safeHost(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}
