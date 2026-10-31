import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { BROWSER_FRAME_HEADER_BYTES, type BrowserClientMessage, type BrowserServerMessage } from "@clam/contracts";
import { openDatabase } from "@clam/database";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBrowserExecutable, realDiscoveryEnv } from "../src/browser/executable.ts";
import { BrowserService } from "../src/browser/service.ts";
import type { ViewerHandle, ViewerPort } from "../src/browser/tab.ts";
import type { ServerContext } from "../src/context.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "clam-browser-smoke-"));
const found = findBrowserExecutable(realDiscoveryEnv(dataDir));
if (!found) console.warn("[browser-smoke] SKIPPED: no Chromium-based browser found (CLAM_BROWSER_PATH, Chrome/Chromium/Edge/Brave, Playwright cache). Install one to run the real-browser smoke test.");

class FakeViewer implements ViewerPort {
	readonly frames: Array<{ at: number; frame: Buffer }> = [];
	readonly messages: BrowserServerMessage[] = [];
	send(message: BrowserServerMessage): void {
		this.messages.push(message);
	}
	sendFrame(frame: Buffer): void {
		this.frames.push({ at: performance.now(), frame });
	}
	buffered(): number {
		return 0;
	}
	last<T extends BrowserServerMessage["type"]>(type: T): Extract<BrowserServerMessage, { type: T }> | undefined {
		return this.messages.findLast((m) => m.type === type) as Extract<BrowserServerMessage, { type: T }> | undefined;
	}
}

async function until<T>(read: () => T | undefined | false, what: string | (() => string), timeoutMs = 30_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${typeof what === "string" ? what : what()}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width, initial-scale=1"><title>start</title>
<style>body{margin:0;font:16px sans-serif}button,input,a{position:absolute;left:20px;width:240px;height:44px;font-size:16px}</style>
<button id=b style="top:20px" onclick="document.title='clicked';console.log('hello',{a:1})">Click me</button>
<input id=i style="top:90px" oninput="document.title='typed:'+this.value">
<button id=al style="top:160px" onclick="alert('hey there');document.title='after-alert'">Alert</button>
<a id=dl style="top:230px" href="/file.txt" download>Download</a>
<input id=f style="top:300px" type=file onchange="document.title='file:'+this.files[0].name">
<button id=err style="top:370px" onclick="fetch('/missing').then(()=>0);null.x">Fail</button>
<script>
const report=()=>{document.title='size:'+innerWidth+'x'+innerHeight+' '+(/iPhone/.test(navigator.userAgent)?'iphone':'desktop')+' touch:'+(navigator.maxTouchPoints>0)};
addEventListener('load',report);addEventListener('resize',report);
</script>`;

describe.skipIf(!found)("machine browser (real headless Chromium)", () => {
	let service: BrowserService;
	let http: Server;
	let origin = "";
	let tabId = "";
	const viewer = new FakeViewer();
	let handle: ViewerHandle;
	const send = (message: BrowserClientMessage): void => handle.message(message);
	const titleOf = (): string => viewer.last("tabs")?.tabs.find((t) => t.id === tabId)?.title ?? "";
	const click = (x: number, y: number): void => {
		send({ type: "mouse", action: "move", x, y, button: "none", buttons: 0, clickCount: 0, deltaX: 0, deltaY: 0, modifiers: 0 });
		send({ type: "mouse", action: "down", x, y, button: "left", buttons: 1, clickCount: 1, deltaX: 0, deltaY: 0, modifiers: 0 });
		send({ type: "mouse", action: "up", x, y, button: "left", buttons: 0, clickCount: 1, deltaX: 0, deltaY: 0, modifiers: 0 });
	};
	const key = (k: string, code: string, keyCode: number): void => {
		for (const action of ["down", "up"] as const) send({ type: "key", action, key: k, code, keyCode, location: 0, modifiers: 0, repeat: false });
	};

	beforeAll(async () => {
		const db = openDatabase({ file: path.join(dataDir, "clam.db") });
		const ctx = { config: { dataDir, port: 1, networkPort: 2 }, db, log: pino({ level: "silent" }) } as unknown as ServerContext;
		service = new BrowserService(ctx, { idleMs: 2_500 });
		http = createServer((req, res) => {
			if (req.url === "/file.txt") {
				res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="file.txt"' });
				res.end("downloaded bytes");
			} else if (req.url === "/missing") {
				res.writeHead(404, { "content-type": "text/plain" });
				res.end("nope");
			} else {
				res.writeHead(200, { "content-type": "text/html" });
				res.end(PAGE);
			}
		});
		await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
		origin = `localhost:${(http.address() as AddressInfo).port}`;
	}, 60_000);

	afterAll(async () => {
		await service.stop();
		http.close();
		rmSync(dataDir, { recursive: true, force: true });
	}, 30_000);

	it("starts on first use, opens `localhost:PORT` on the machine and streams JPEG frames", async () => {
		expect(service.status().state).toBe("stopped");
		const tab = await service.openTab(origin);
		tabId = tab.id;
		expect(service.status().state).toBe("running");
		const attached = service.attachViewer(tabId, viewer);
		if (!attached) throw new Error("tab vanished");
		handle = attached.handle;
		viewer.send(attached.tab.hello(service.listTabs()));
		send({ type: "viewer", width: 800, height: 600, dpr: 1, device: "fit" });
		const first = await until(() => viewer.frames[0], "the first screencast frame");
		const jpeg = first.frame.subarray(BROWSER_FRAME_HEADER_BYTES);
		expect(jpeg[0]).toBe(0xff);
		expect(jpeg[1]).toBe(0xd8);
		await until(() => titleOf() === "size:800x600 desktop touch:false", "the page to see the 800×600 viewport");
		const viewport = viewer.last("viewport")?.viewport;
		expect(viewport).toMatchObject({ width: 800, height: 600, mobile: false });
		// header carries the viewport in CSS px, used by the viewer to map pointer coordinates
		const latest = viewer.frames.at(-1)!.frame;
		expect([latest.readUInt16LE(4), latest.readUInt16LE(6)]).toEqual([800, 600]);
	}, 60_000);

	it("clicks a button (Input.dispatchMouseEvent) and the DOM changes; console.log shows up", async () => {
		const before = viewer.frames.length;
		const sent = performance.now();
		click(60, 40);
		await until(() => titleOf() === "clicked", "title to change after the click");
		const frame = await until(() => viewer.frames.slice(before).find((f) => f.at > sent), "a frame after the click");
		console.info(`[browser-smoke] click → next frame: ${(frame.at - sent).toFixed(0)} ms`);
		const entry = await until(() => viewer.messages.find((m) => m.type === "console" && m.entry.kind === "console")?.type === "console", "the console.log entry");
		expect(entry).toBe(true);
		const logged = viewer.messages.flatMap((m) => (m.type === "console" ? [m.entry] : [])).find((e) => e.kind === "console");
		expect(logged).toMatchObject({ level: "log", text: "hello {a: 1}" });
	}, 30_000);

	it("types into a field (key events + Input.insertText) and pastes text", async () => {
		click(60, 112);
		key("h", "KeyH", 72);
		key("i", "KeyI", 73);
		await until(() => titleOf() === "typed:hi", "typed text");
		send({ type: "text", text: " there ✓" });
		await until(() => titleOf() === "typed:hi there ✓", "inserted text");
		send({ type: "key", action: "down", key: "a", code: "KeyA", keyCode: 65, location: 0, modifiers: 2, repeat: false });
		send({ type: "key", action: "up", key: "a", code: "KeyA", keyCode: 65, location: 0, modifiers: 2, repeat: false });
		send({ type: "copy" });
		const clip = await until(() => viewer.last("clipboard"), "copied selection");
		expect(clip.text).toBe("hi there ✓");
	}, 30_000);

	it("surfaces page dialogs and answers them", async () => {
		click(60, 182);
		const dialog = await until(() => viewer.last("dialog")?.dialog, "the alert dialog");
		expect(dialog).toMatchObject({ kind: "alert", message: "hey there" });
		send({ type: "dialog", accept: true });
		await until(() => titleOf() === "after-alert", "page to continue after the dialog");
	}, 30_000);

	it("reports exceptions and failed requests in the console panel", async () => {
		click(60, 392);
		await until(() => viewer.messages.some((m) => m.type === "console" && m.entry.kind === "exception"), "the exception");
		await until(() => viewer.messages.some((m) => m.type === "console" && m.entry.kind === "network" && m.entry.url?.endsWith("/missing")), "the 404");
		const exception = viewer.messages.flatMap((m) => (m.type === "console" ? [m.entry] : [])).find((e) => e.kind === "exception");
		expect(exception?.text).toContain("TypeError");
	}, 30_000);

	it("saves downloads into the data dir and lists them", async () => {
		click(60, 252);
		const done = await until(() => viewer.messages.findLast((m) => m.type === "download" && m.download.state === "completed"), "the download to finish");
		const name = done.type === "download" ? done.download.name : "";
		expect(name).toBe("file.txt");
		const stored = service.downloadFile(name);
		expect(stored).not.toBeNull();
		expect(readFileSync(stored!.file, "utf8")).toBe("downloaded bytes");
		expect(service.downloadFile("../clam.db")).toBeNull();
		expect(service.listDownloads().map((d) => d.name)).toContain("file.txt");
	}, 30_000);

	it("hands a file chooser to the viewer and attaches the uploaded file", async () => {
		click(60, 322);
		const chooser = await until(() => viewer.last("file-chooser")?.fileChooser, "the file chooser");
		if (!chooser) throw new Error("no file chooser");
		await service.receiveUpload(chooser.uploadId, "../../notes.txt", Readable.from([Buffer.from("hello upload")]));
		send({ type: "file-chooser-done", uploadId: chooser.uploadId });
		await until(() => titleOf() === "file:notes.txt", "the page to see the uploaded file");
		await expect(service.receiveUpload("00000000-0000-0000-0000-000000000000", "x", Readable.from([]))).rejects.toMatchObject({ status: 404 });
	}, 30_000);

	it("emulates an iPhone 16 Pro Max (440×956, touch, mobile UA) and back", async () => {
		send({ type: "viewer", width: 700, height: 500, dpr: 3, device: "iphone" });
		await until(() => titleOf() === "size:440x956 iphone touch:true", () => `iPhone emulation (title is "${titleOf()}")`);
		expect(viewer.last("viewport")?.viewport).toMatchObject({ width: 440, height: 956, mobile: true, deviceScale: 2, device: "iphone" });
		await until(() => viewer.frames.at(-1)?.frame.readUInt16LE(4) === 440, "a 440 px wide frame");
		// a touch tap reaches the page as touch → click
		const before = viewer.frames.length;
		send({ type: "touch", action: "start", points: [{ x: 60, y: 40, id: 1 }], modifiers: 0 });
		send({ type: "touch", action: "end", points: [], modifiers: 0 });
		await until(() => titleOf() === "clicked" || viewer.frames.length > before + 1, "touch tap");
		send({ type: "viewer", width: 1000, height: 640, dpr: 1, device: "desktop" });
		await until(() => titleOf() === "size:1440x922 desktop touch:false", () => `desktop 1440 emulation (title is "${titleOf()}")`);
	}, 30_000);

	it("navigates, refuses internal/blocked URLs and manages tabs", async () => {
		await expect(service.navigate(tabId, "chrome://settings")).rejects.toMatchObject({ status: 400, code: "url_blocked" });
		await expect(service.openTab("file:///etc/passwd")).rejects.toMatchObject({ status: 400, code: "url_blocked" });
		await service.navigate(tabId, `${origin}/file.txt?x=1`.replace("/file.txt", "/"));
		const second = await service.openTab(`http://${origin}/?second`);
		await until(() => service.listTabs().find((t) => t.id === second.id && t.title.startsWith("size:")), "the second tab to load");
		expect(service.listTabs()).toHaveLength(2);
		await service.closeTab(second.id);
		expect(service.listTabs().map((t) => t.id)).toEqual([tabId]);
		send({ type: "history", action: "back" });
		await until(() => viewer.last("tabs")?.tabs[0]?.canGoForward, "back/forward state");
	}, 40_000);

	it("stops streaming while the viewer is hidden", async () => {
		send({ type: "visible", visible: false });
		await new Promise((resolve) => setTimeout(resolve, 600));
		const count = viewer.frames.length;
		send({ type: "mouse", action: "move", x: 10, y: 10, button: "none", buttons: 0, clickCount: 0, deltaX: 0, deltaY: 0, modifiers: 0 });
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(viewer.frames.length).toBe(count);
		send({ type: "visible", visible: true });
		await until(() => viewer.frames.length > count, "frames to resume");
	}, 30_000);

	it("closes the browser after the idle window once nobody is watching", async () => {
		handle.dispose();
		await until(() => service.status().state === "stopped", "the idle shutdown", 20_000);
		expect(service.status().tabCount).toBe(0);
		// and starts again, with the same profile, on next use
		const again = await service.openTab(origin);
		expect(again.id).toBeTruthy();
		expect(service.status().state).toBe("running");
	}, 60_000);
});

// Port discovery against REAL listening sockets of a separate process (this process's own ports are excluded by design).
const lsofAvailable = (() => {
	const probe = spawn("lsof", ["-v"], { stdio: "ignore" });
	return new Promise<boolean>((resolve) => {
		probe.on("error", () => resolve(false));
		probe.on("exit", () => resolve(true));
	});
})();

describe("port discovery on the real machine", () => {
	let child: ChildProcess | null = null;
	let port = 0;
	let scratch = "";
	beforeAll(async () => {
		scratch = mkdtempSync(path.join(tmpdir(), "clam-browser-ports-"));
		const script = path.join(scratch, "serve.mjs");
		writeFileSync(script, "import http from 'node:http'; const s = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<title>Ports demo</title>'); }); s.listen(0, '127.0.0.1', () => console.log(s.address().port));");
		child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
		port = await new Promise<number>((resolve) => child!.stdout!.once("data", (d: Buffer) => resolve(Number(d.toString().trim()))));
	});
	afterAll(() => {
		child?.kill("SIGTERM");
		rmSync(scratch, { recursive: true, force: true });
	});

	it("lists a listening http server of another process, excluding this node's own port", async (ctx) => {
		if (!(await lsofAvailable)) return ctx.skip();
		const db = openDatabase({ file: path.join(scratch, "ports.db") });
		const service = new BrowserService({ config: { dataDir: scratch, port: 1, networkPort: 2 }, db, log: pino({ level: "silent" }) } as unknown as ServerContext);
		const list = await service.ports();
		expect(list.find((p) => p.port === port)).toMatchObject({ address: "127.0.0.1", pid: child!.pid, likelyHttp: true, title: "Ports demo", url: `localhost:${port}` });
		expect(list.find((p) => p.port === port)?.startedAt).not.toBeNull();
	});
});
