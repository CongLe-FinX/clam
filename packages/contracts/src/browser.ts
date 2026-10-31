import { z } from "zod";
import { IsoDate } from "./common.ts";

/**
 * The machine's own Browser: a real headless Chromium-family browser running ON this machine (so `localhost:1234` is the
 * machine's own loopback), driven over the Chrome DevTools Protocol (an inherited pipe, never a TCP port) and streamed to the
 * web UI as screencast frames. It exists on the machine's own UI only: it is never reachable through the mesh `/api/v1`.
 *
 * Access: always on the loopback UI; through the domain it needs `AccessStatus.remoteBrowserEnabled` (403 `tool_disabled`).
 *
 * REST (under `/api/local`, see `routes.browser*`) + one WebSocket per viewed tab: `routes`-less path `/ws/browser/:tabId`
 * (see `browserSocketPath`). Binary frames server → client are screencast JPEGs (`BROWSER_FRAME_HEADER_BYTES` header, then
 * the JPEG); every text frame is JSON (`BrowserServerMessage` / `BrowserClientMessage`).
 */

export const BrowserExecutableSource = z.enum(["env", "system", "playwright", "installed"]);
export type BrowserExecutableSource = z.infer<typeof BrowserExecutableSource>;

export const BrowserExecutable = z.object({
	path: z.string(),
	/** "Google Chrome", "Chromium", "Microsoft Edge", "Brave", "Chromium (Playwright)". */
	name: z.string(),
	source: BrowserExecutableSource,
});
export type BrowserExecutable = z.infer<typeof BrowserExecutable>;

export const BrowserInstallState = z.object({
	state: z.enum(["idle", "running", "done", "failed"]),
	/** 0–100 while the installer reports it, else null. */
	progress: z.number().nullable(),
	/** Last lines of the installer's output. */
	log: z.array(z.string()),
	error: z.string().nullable(),
});
export type BrowserInstallState = z.infer<typeof BrowserInstallState>;

export const BrowserStatus = z.object({
	/** A browser executable was found (see `executable`); false → the UI shows install guidance. */
	available: z.boolean(),
	executable: BrowserExecutable.nullable(),
	/** The browser process: started lazily on first use, closed after `idleMinutes` with no viewer. */
	state: z.enum(["stopped", "starting", "running", "failed"]),
	error: z.string().nullable(),
	tabCount: z.number().int(),
	idleMinutes: z.number(),
	/** The one-click "Install Chromium" is possible on this machine (`npx` found, no browser installed yet). */
	canInstall: z.boolean(),
	install: BrowserInstallState,
	/** Where downloads land on the machine. */
	downloadsDir: z.string(),
});
export type BrowserStatus = z.infer<typeof BrowserStatus>;

export const BrowserTab = z.object({
	id: z.string(),
	title: z.string(),
	url: z.string(),
	/** A small `data:` image (≤ 32 KB) or null: the page's icon, fetched by the machine's browser so the viewer never needs to reach the page's origin. */
	faviconUrl: z.string().nullable(),
	loading: z.boolean(),
	/** 0..1 while loading. */
	progress: z.number(),
	canGoBack: z.boolean(),
	canGoForward: z.boolean(),
});
export type BrowserTab = z.infer<typeof BrowserTab>;

export const BrowserDevice = z.enum(["fit", "desktop", "iphone"]);
export type BrowserDevice = z.infer<typeof BrowserDevice>;
/** Emulated viewports: `desktop` is 1440 CSS px wide (height follows the viewer's aspect); `iphone` is an iPhone 16 Pro Max (440×956, touch + mobile UA). */
export const DESKTOP_VIEWPORT_WIDTH = 1440;
export const IPHONE_VIEWPORT = { width: 440, height: 956 } as const;

export const OpenTabBody = z.object({ url: z.string().max(4096).optional() });
export const NavigateBody = z.object({ url: z.string().min(1).max(4096) });

export const ListeningPort = z.object({
	port: z.number().int(),
	/** The bound address: "127.0.0.1", "::1", "*" (every interface) or a specific IP. */
	address: z.string(),
	pid: z.number().int().nullable(),
	/** Process name ("node", "python3", …). */
	process: z.string().nullable(),
	/** A recognised tool from the command line ("vite", "next", "webpack", "http.server", …). */
	hint: z.string().nullable(),
	/** Only web servers are listed: the port answered a plain HTTP GET with an HTML or JSON response. Always true in `GET browserPorts`. */
	likelyHttp: z.boolean(),
	/** The `<title>` of the page the port serves (null for JSON/untitled responses): the chip label. */
	title: z.string().nullable(),
	/** When the listening process started (ISO), null when unknown: lists are sorted newest first. */
	startedAt: IsoDate.nullable(),
	/** What to type in the address bar to reach it from this machine's browser. */
	url: z.string(),
});
export type ListeningPort = z.infer<typeof ListeningPort>;

export const BrowserDownload = z.object({
	/** File name inside the downloads directory (served by `routes.browserDownload(name)`). */
	name: z.string(),
	size: z.number().int(),
	state: z.enum(["inProgress", "completed", "canceled"]),
	/** Bytes received so far (when still in progress). */
	received: z.number().int(),
	startedAt: IsoDate,
	sourceUrl: z.string(),
});
export type BrowserDownload = z.infer<typeof BrowserDownload>;

export const BrowserConsoleEntry = z.object({
	id: z.number().int(),
	kind: z.enum(["console", "exception", "network", "log"]),
	level: z.enum(["log", "info", "warn", "error", "debug"]),
	text: z.string(),
	/** Source location or the failing request URL. */
	url: z.string().nullable(),
	line: z.number().int().nullable(),
	/** Epoch milliseconds. */
	ts: z.number(),
});
export type BrowserConsoleEntry = z.infer<typeof BrowserConsoleEntry>;

export const BrowserDialog = z.object({
	kind: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
	message: z.string(),
	defaultPrompt: z.string(),
	url: z.string(),
});
export type BrowserDialog = z.infer<typeof BrowserDialog>;

export const BrowserViewport = z.object({
	/** CSS pixels of the emulated page viewport; frames show exactly this area (mouse/touch coordinates are in these units). */
	width: z.number(),
	height: z.number(),
	deviceScale: z.number(),
	mobile: z.boolean(),
	device: BrowserDevice,
});
export type BrowserViewport = z.infer<typeof BrowserViewport>;

// ── WebSocket `/ws/browser/:tabId` ───────────────────────────────────────────────────────────────────────────────

/** Path of a tab's socket (the whole `/ws` namespace is session-gated + Origin-checked on the public listener). */
export const browserSocketPath = (tabId: string): string => `/ws/browser/${encodeURIComponent(tabId)}`;
/** Binary frame: u32 LE seq · u16 LE viewport width · u16 LE viewport height (CSS px at capture time) · JPEG bytes. */
export const BROWSER_FRAME_HEADER_BYTES = 8;
/** WebSocket close codes: 4401 = session ended / tool switched off (same as `/ws`), 4404 = no such tab, 4503 = browser unavailable. */

const Modifiers = z.number().int().min(0).max(15); // Alt=1 Ctrl=2 Meta=4 Shift=8 (CDP bitmask)
const Point = z.object({ x: z.number(), y: z.number() });

export const BrowserClientMessage = z.discriminatedUnion("type", [
	/** Size of the viewer area in CSS px + its device pixel ratio + the chosen device mode; the server emulates a matching viewport and restarts the screencast at the right size. Send again on resize. */
	z.object({ type: z.literal("viewer"), width: z.number().min(50).max(8192), height: z.number().min(50).max(8192), dpr: z.number().min(1).max(8), device: BrowserDevice }),
	/** The viewer is visible (true) or hidden/backgrounded (false): the screencast runs only while visible. */
	z.object({ type: z.literal("visible"), visible: z.boolean() }),
	z.object({
		type: z.literal("mouse"),
		action: z.enum(["move", "down", "up", "wheel"]),
		x: z.number(),
		y: z.number(),
		button: z.enum(["none", "left", "middle", "right", "back", "forward"]).default("none"),
		/** Bitmask of buttons currently held (left=1, right=2, middle=4). */
		buttons: z.number().int().min(0).max(31).default(0),
		clickCount: z.number().int().min(0).max(5).default(1),
		deltaX: z.number().default(0),
		deltaY: z.number().default(0),
		modifiers: Modifiers.default(0),
	}),
	/** Touch points in page CSS px (use in `mobile` viewports; on desktop viewports translate taps to mouse events and drags to wheel). */
	z.object({ type: z.literal("touch"), action: z.enum(["start", "move", "end", "cancel"]), points: z.array(Point.extend({ id: z.number().int() })).max(10), modifiers: Modifiers.default(0) }),
	z.object({
		type: z.literal("key"),
		action: z.enum(["down", "up"]),
		/** `KeyboardEvent.key` / `.code` / `.keyCode` of the viewer's event. */
		key: z.string().max(32),
		code: z.string().max(32).default(""),
		keyCode: z.number().int().default(0),
		location: z.number().int().min(0).max(3).default(0),
		modifiers: Modifiers.default(0),
		repeat: z.boolean().default(false),
	}),
	/** Committed text (IME composition end, mobile soft-keyboard `input`, paste) inserted at the caret. */
	z.object({ type: z.literal("text"), text: z.string().max(1_000_000) }),
	/** Ask for the page's selected text (answered by `clipboard`). */
	z.object({ type: z.literal("copy") }),
	z.object({ type: z.literal("navigate"), url: z.string().min(1).max(4096) }),
	z.object({ type: z.literal("history"), action: z.enum(["back", "forward", "reload", "stop"]) }),
	z.object({ type: z.literal("dialog"), accept: z.boolean(), promptText: z.string().max(10_000).optional() }),
	/** Answer a `file-chooser` message: `uploadId` refers to files previously PUT with `routes.browserUpload`; none = cancel. */
	z.object({ type: z.literal("file-chooser-done"), uploadId: z.string().max(64).optional() }),
	z.object({ type: z.literal("console-clear") }),
	z.object({ type: z.literal("ping"), t: z.number() }),
]);
export type BrowserClientMessage = z.infer<typeof BrowserClientMessage>;

export type BrowserServerMessage =
	/** First message: this tab, every tab, pending dialog/chooser and the console buffer. */
	| { type: "hello"; tab: BrowserTab; tabs: BrowserTab[]; viewport: BrowserViewport | null; dialog: BrowserDialog | null; fileChooser: { multiple: boolean; uploadId: string } | null; console: BrowserConsoleEntry[]; downloads: BrowserDownload[] }
	/** Tab list or any tab's title/url/loading state changed (always the full list). */
	| { type: "tabs"; tabs: BrowserTab[] }
	| { type: "viewport"; viewport: BrowserViewport }
	| { type: "dialog"; dialog: BrowserDialog | null }
	| { type: "file-chooser"; fileChooser: { multiple: boolean; uploadId: string } | null }
	| { type: "console"; entry: BrowserConsoleEntry }
	| { type: "console-cleared" }
	| { type: "download"; download: BrowserDownload }
	| { type: "clipboard"; text: string }
	| { type: "pong"; t: number }
	/** The viewed tab was closed (by the page, another viewer, or the browser exiting). */
	| { type: "closed"; reason: string }
	| { type: "error"; message: string };
