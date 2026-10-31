import {
	BROWSER_FRAME_HEADER_BYTES,
	type BrowserClientMessage,
	type BrowserConsoleEntry,
	type BrowserDevice,
	type BrowserDialog,
	type BrowserDownload,
	type BrowserServerMessage,
	type BrowserTab,
	type BrowserViewport,
	browserSocketPath,
} from "@clam/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { browserStats } from "./stats.ts";

export type ConnState = "connecting" | "open" | "reconnecting" | "tab-closed" | "signed-out" | "unavailable";

export interface ViewerParams {
	width: number;
	height: number;
	dpr: number;
	device: BrowserDevice;
}

export interface FileChooserRequest {
	multiple: boolean;
	uploadId: string;
}

export interface ConnSnapshot {
	state: ConnState;
	tab: BrowserTab | null;
	/** Full tab list as last reported by this socket (null before `hello`). */
	tabs: BrowserTab[] | null;
	viewport: BrowserViewport | null;
	dialog: BrowserDialog | null;
	fileChooser: FileChooserRequest | null;
	console: BrowserConsoleEntry[];
	downloads: BrowserDownload[];
}

export interface FrameInfo {
	bytes: number;
	/** Viewport (CSS px) the frame was captured at. */
	viewportWidth: number;
	viewportHeight: number;
}
export type FrameSink = (bitmap: ImageBitmap, info: FrameInfo) => void;

export interface ConnEvents {
	/** The viewed tab is gone (`closed` message or close code 4404). */
	onClosed(tabId: string, reason: string): void;
	onError(message: string): void;
	onDownloadDone(download: BrowserDownload): void;
}

export const EMPTY_SNAPSHOT: ConnSnapshot = { state: "connecting", tab: null, tabs: null, viewport: null, dialog: null, fileChooser: null, console: [], downloads: [] };

const CLOSE_SIGNED_OUT = 4401;
const CLOSE_NO_TAB = 4404;
const CLOSE_UNAVAILABLE = 4503;
const MAX_CONSOLE = 1000;
const PING_MS = 2000;
const CLIPBOARD_TIMEOUT_MS = 3000;

function socketUrl(tabId: string): string {
	const proto = location.protocol === "https:" ? "wss" : "ws";
	return `${proto}://${location.host}${browserSocketPath(tabId)}`;
}

/**
 * One viewer's socket to a tab: reconnects with backoff, decodes screencast frames off the main thread (only the newest
 * pending frame is ever decoded) and exposes the rest of the server state as an external-store snapshot.
 */
export class TabConnection {
	readonly tabId: string;
	private snap: ConnSnapshot = EMPTY_SNAPSHOT;
	private listeners = new Set<() => void>();
	private ws: WebSocket | null = null;
	private viewer: ViewerParams | null;
	private visible: boolean;
	private sink: FrameSink | null = null;
	private attempt = 0;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private pingTimer: ReturnType<typeof setInterval> | undefined;
	private notifyTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private ended = false;
	private decoding = false;
	private pendingFrame: ArrayBuffer | null = null;
	private downloadStates = new Map<string, BrowserDownload["state"]>();
	private clipboardWaiters: Array<(text: string) => void> = [];

	constructor(
		tabId: string,
		private readonly events: ConnEvents,
		initial: { viewer: ViewerParams | null; visible: boolean },
	) {
		this.tabId = tabId;
		this.viewer = initial.viewer;
		this.visible = initial.visible;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	getSnapshot = (): ConnSnapshot => this.snap;

	start(): void {
		this.connect();
	}

	/** Reconnect now (after `unavailable` / `signed-out`, from a Retry button). */
	retry(): void {
		if (this.disposed) return;
		clearTimeout(this.retryTimer);
		this.ended = false;
		this.attempt = 0;
		this.ws?.close();
		this.ws = null;
		this.connect();
	}

	setFrameSink(sink: FrameSink | null): void {
		this.sink = sink;
	}

	setViewer(viewer: ViewerParams): void {
		const prev = this.viewer;
		if (prev && prev.width === viewer.width && prev.height === viewer.height && prev.dpr === viewer.dpr && prev.device === viewer.device) return;
		this.viewer = viewer;
		this.send({ type: "viewer", ...viewer });
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.send({ type: "visible", visible });
	}

	send(msg: BrowserClientMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
	}

	/** Ask the page for its selected text; resolves with the answered `clipboard` text ("" on timeout). */
	copySelection(): Promise<string> {
		// The web app targets lib ES2023, which has no Promise.withResolvers.
		return new Promise<string>((resolve) => {
			const timer = setTimeout(() => finish(""), CLIPBOARD_TIMEOUT_MS);
			const finish = (text: string) => {
				clearTimeout(timer);
				this.clipboardWaiters = this.clipboardWaiters.filter((w) => w !== finish);
				resolve(text);
			};
			this.clipboardWaiters.push(finish);
			this.send({ type: "copy" });
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.send({ type: "visible", visible: false });
		this.disposed = true;
		clearTimeout(this.retryTimer);
		clearTimeout(this.notifyTimer);
		clearInterval(this.pingTimer);
		this.sink = null;
		this.pendingFrame = null;
		for (const w of [...this.clipboardWaiters]) w("");
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
			ws.close(1000);
		}
		this.listeners.clear();
	}

	private connect(): void {
		if (this.disposed || this.ended) return;
		const ws = new WebSocket(socketUrl(this.tabId));
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		ws.onopen = () => {
			this.attempt = 0;
			if (this.viewer) this.send({ type: "viewer", ...this.viewer });
			this.send({ type: "visible", visible: this.visible });
			clearInterval(this.pingTimer);
			this.pingTimer = setInterval(() => this.send({ type: "ping", t: performance.now() }), PING_MS);
			this.send({ type: "ping", t: performance.now() });
			if (this.snap.state !== "open") this.patch({ state: "open" });
		};
		ws.onmessage = (ev: MessageEvent<string | ArrayBuffer>) => {
			if (typeof ev.data === "string") this.onText(ev.data);
			else this.onFrame(ev.data);
		};
		ws.onclose = (ev) => {
			if (this.ws !== ws) return;
			this.ws = null;
			clearInterval(this.pingTimer);
			if (this.disposed || this.ended) return;
			if (ev.code === CLOSE_SIGNED_OUT) {
				this.ended = true;
				this.patch({ state: "signed-out" });
			} else if (ev.code === CLOSE_NO_TAB) {
				this.ended = true;
				this.patch({ state: "tab-closed" });
				this.events.onClosed(this.tabId, "This tab no longer exists.");
			} else if (ev.code === CLOSE_UNAVAILABLE) {
				this.ended = true;
				this.patch({ state: "unavailable" });
			} else {
				this.patch({ state: this.snap.tabs ? "reconnecting" : "connecting" });
				const delay = Math.min(8000, 400 * 1.7 ** this.attempt++);
				this.retryTimer = setTimeout(() => this.connect(), delay);
			}
		};
	}

	private patch(next: Partial<ConnSnapshot>, deferred = false): void {
		this.snap = { ...this.snap, ...next };
		if (deferred) {
			this.notifyTimer ??= setTimeout(() => {
				this.notifyTimer = undefined;
				this.emit();
			}, 80);
			return;
		}
		clearTimeout(this.notifyTimer);
		this.notifyTimer = undefined;
		this.emit();
	}

	private emit(): void {
		for (const l of [...this.listeners]) l();
	}

	private onText(raw: string): void {
		let msg: BrowserServerMessage;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || typeof parsed.type !== "string") return;
			msg = parsed as BrowserServerMessage; // Boundary: server-authored JSON, only `type` is checked per the contract.
		} catch {
			return;
		}
		switch (msg.type) {
			case "hello":
				this.downloadStates = new Map(msg.downloads.map((d) => [d.name, d.state]));
				this.patch({ state: "open", tab: msg.tab, tabs: msg.tabs, viewport: msg.viewport, dialog: msg.dialog, fileChooser: msg.fileChooser, console: msg.console.slice(-MAX_CONSOLE), downloads: msg.downloads });
				break;
			case "tabs":
				this.patch({ tabs: msg.tabs, tab: msg.tabs.find((t) => t.id === this.tabId) ?? this.snap.tab });
				break;
			case "viewport":
				this.patch({ viewport: msg.viewport });
				break;
			case "dialog":
				this.patch({ dialog: msg.dialog });
				break;
			case "file-chooser":
				this.patch({ fileChooser: msg.fileChooser });
				break;
			case "console": {
				const next = this.snap.console.length >= MAX_CONSOLE ? this.snap.console.slice(-(MAX_CONSOLE - 1)) : this.snap.console.slice();
				next.push(msg.entry);
				this.patch({ console: next }, true);
				break;
			}
			case "console-cleared":
				this.patch({ console: [] });
				break;
			case "download": {
				const d = msg.download;
				const prev = this.downloadStates.get(d.name);
				this.downloadStates.set(d.name, d.state);
				const i = this.snap.downloads.findIndex((x) => x.name === d.name);
				const downloads = this.snap.downloads.slice();
				if (i >= 0) downloads[i] = d;
				else downloads.push(d);
				this.patch({ downloads });
				if (d.state === "completed" && prev !== "completed") this.events.onDownloadDone(d);
				break;
			}
			case "clipboard": {
				const waiters = this.clipboardWaiters;
				this.clipboardWaiters = [];
				for (const w of waiters) w(msg.text);
				break;
			}
			case "pong":
				browserStats.roundTrip(performance.now() - msg.t);
				break;
			case "closed":
				this.ended = true;
				this.patch({ state: "tab-closed" });
				this.events.onClosed(this.tabId, msg.reason);
				break;
			case "error":
				this.events.onError(msg.message);
				break;
		}
	}

	private onFrame(buf: ArrayBuffer): void {
		browserStats.bytesReceived(buf.byteLength);
		if (buf.byteLength <= BROWSER_FRAME_HEADER_BYTES) return;
		// Only the newest undecoded frame matters: replace anything still waiting behind the one being decoded.
		this.pendingFrame = buf;
		if (!this.decoding) void this.decodeLoop();
	}

	private takePending(): ArrayBuffer | null {
		const buf = this.pendingFrame;
		this.pendingFrame = null;
		return buf;
	}

	private async decodeLoop(): Promise<void> {
		this.decoding = true;
		try {
			for (let buf = this.takePending(); buf; buf = this.takePending()) {
				const view = new DataView(buf);
				const info: FrameInfo = { bytes: buf.byteLength, viewportWidth: view.getUint16(4, true), viewportHeight: view.getUint16(6, true) };
				let bitmap: ImageBitmap;
				try {
					bitmap = await createImageBitmap(new Blob([new Uint8Array(buf, BROWSER_FRAME_HEADER_BYTES)], { type: "image/jpeg" }));
				} catch {
					continue; // A corrupt frame is dropped; the next one replaces it.
				}
				if (this.disposed || !this.sink) bitmap.close();
				else this.sink(bitmap, info);
			}
		} finally {
			this.decoding = false;
		}
	}
}

const noopSubscribe = (): (() => void) => () => {};
const emptySnapshot = (): ConnSnapshot => EMPTY_SNAPSHOT;

/** Viewer state handed to a new socket so it starts with the right size and visibility. */
export interface ConnInit {
	viewer: ViewerParams | null;
	visible: boolean;
}

/** Open the socket of `tabId` for the lifetime of the component (null = none). */
export function useTabConnection(tabId: string | null, events: ConnEvents, init: () => ConnInit): { conn: TabConnection | null; snapshot: ConnSnapshot } {
	const eventsRef = useRef(events);
	const initRef = useRef(init);
	useEffect(() => {
		eventsRef.current = events;
		initRef.current = init;
	});
	const [conn, setConn] = useState<TabConnection | null>(null);
	useEffect(() => {
		if (!tabId) {
			setConn(null);
			return;
		}
		const stable: ConnEvents = {
			onClosed: (id, reason) => eventsRef.current.onClosed(id, reason),
			onError: (m) => eventsRef.current.onError(m),
			onDownloadDone: (d) => eventsRef.current.onDownloadDone(d),
		};
		const c = new TabConnection(tabId, stable, initRef.current());
		setConn(c);
		c.start();
		return () => c.dispose();
	}, [tabId]);
	const snapshot = useSyncExternalStore(conn ? conn.subscribe : noopSubscribe, conn ? conn.getSnapshot : emptySnapshot, emptySnapshot);
	return { conn, snapshot };
}
