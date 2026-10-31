import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { findBrowserExecutable, type DiscoveryEnv } from "../src/browser/executable.ts";
import { computeViewport, describeRemoteObject, keyEventParams } from "../src/browser/emulation.ts";
import { parseInstallProgress } from "../src/browser/installer.ts";
import { PortDiscovery, executableName, extractTitle, hintFromCommand, mergeListeners, parseLsof, parseNetstat, parsePsComm, parsePsCommands, parseSs, probeWeb, urlFor } from "../src/browser/ports.ts";
import { isPermittedLocation, normalizeBrowserUrl, type UrlPolicy } from "../src/browser/url.ts";

function env(over: Partial<DiscoveryEnv> & { files?: string[]; dirs?: Record<string, string[]> }): DiscoveryEnv {
	const files = new Set(over.files ?? []);
	return {
		env: over.env ?? {},
		platform: over.platform ?? "darwin",
		home: over.home ?? "/Users/me",
		dataDir: over.dataDir ?? "/data/clam",
		exists: (f) => files.has(f),
		list: (d) => over.dirs?.[d] ?? [],
	};
}

describe("browser executable discovery", () => {
	const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
	const PW_ROOT = "/Users/me/Library/Caches/ms-playwright";

	it("prefers CLAM_BROWSER_PATH over everything else", () => {
		const found = findBrowserExecutable(env({ files: ["/opt/mybrowser", CHROME], env: { CLAM_BROWSER_PATH: "/opt/mybrowser" } }));
		expect(found).toEqual({ path: "/opt/mybrowser", name: "mybrowser", source: "env" });
	});

	it("ignores CLAM_BROWSER_PATH when the file does not exist and falls through to installed browsers (Chrome before Brave)", () => {
		const found = findBrowserExecutable(env({ files: [BRAVE, CHROME], env: { CLAM_BROWSER_PATH: "/nope" } }));
		expect(found).toMatchObject({ path: CHROME, name: "Google Chrome", source: "system" });
		expect(findBrowserExecutable(env({ files: [BRAVE] }))).toMatchObject({ path: BRAVE, name: "Brave", source: "system" });
	});

	it("finds Chrome/Chromium/Edge/Brave per OS (linux PATH, snap skipped; windows program files)", () => {
		expect(findBrowserExecutable(env({ platform: "linux", files: ["/usr/bin/chromium"], env: { PATH: "/usr/local/bin:/usr/bin" } }))).toMatchObject({ path: "/usr/bin/chromium", name: "Chromium", source: "system" });
		expect(findBrowserExecutable(env({ platform: "linux", files: ["/snap/bin/chromium"], env: { PATH: "/snap/bin" } }))).toBeNull();
		expect(findBrowserExecutable(env({ platform: "win32", files: ["C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"], env: { PROGRAMFILES: "C:\\Program Files" } }))).toMatchObject({ name: "Microsoft Edge", source: "system" });
	});

	it("falls back to Playwright's cache (newest revision, full browser before the headless shell), then to the one-click install", () => {
		const full = `${PW_ROOT}/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
		const old = `${PW_ROOT}/chromium-1100/chrome-mac/Chromium.app/Contents/MacOS/Chromium`;
		const shell = `${PW_ROOT}/chromium_headless_shell-1200/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
		const dirs = { [PW_ROOT]: ["chromium-1100", "chromium-1200", "chromium_headless_shell-1200", "ffmpeg-1011"], [`${PW_ROOT}/chromium_headless_shell-1200`]: ["chrome-headless-shell-mac-arm64"] };
		expect(findBrowserExecutable(env({ files: [old, full, shell], dirs }))).toMatchObject({ path: full, source: "playwright" });
		expect(findBrowserExecutable(env({ files: [old, shell], dirs }))).toMatchObject({ path: old, source: "playwright" });
		expect(findBrowserExecutable(env({ files: [shell], dirs }))).toMatchObject({ path: shell, source: "playwright" });

		const installedRoot = "/data/clam/browsers";
		const installed = `${installedRoot}/chromium-1300/chrome-mac/Chromium.app/Contents/MacOS/Chromium`;
		expect(findBrowserExecutable(env({ files: [installed], dirs: { [installedRoot]: ["chromium-1300"] } }))).toMatchObject({ path: installed, source: "installed" });
		// the Playwright cache wins over the installed copy; an installed copy never beats an installed Chrome
		expect(findBrowserExecutable(env({ files: [installed, old], dirs: { [installedRoot]: ["chromium-1300"], ...dirs } }))?.source).toBe("playwright");
		expect(findBrowserExecutable(env({ files: [installed, CHROME], dirs: { [installedRoot]: ["chromium-1300"] } }))?.source).toBe("system");
	});

	it("honours PLAYWRIGHT_BROWSERS_PATH and the Linux cache location; none installed → null", () => {
		const custom = "/srv/pw/chromium-1/chrome-linux/chrome";
		expect(findBrowserExecutable(env({ platform: "linux", files: [custom], dirs: { "/srv/pw": ["chromium-1"] }, env: { PLAYWRIGHT_BROWSERS_PATH: "/srv/pw" } }))).toMatchObject({ path: custom, source: "playwright" });
		const cache = "/Users/me/.cache/ms-playwright/chromium-7/chrome-linux64/chrome";
		expect(findBrowserExecutable(env({ platform: "linux", files: [cache], dirs: { "/Users/me/.cache/ms-playwright": ["chromium-7"] } }))).toMatchObject({ path: cache });
		expect(findBrowserExecutable(env({}))).toBeNull();
	});
});

describe("browser URL normalization and policy", () => {
	const root = mkdtempSync(path.join(tmpdir(), "clam-browser-url-"));
	const project = realpathSync(root);
	mkdirSync(path.join(project, "site"));
	writeFileSync(path.join(project, "site", "index.html"), "<p>hi</p>");
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const policy: UrlPolicy = { home: "/Users/me", isProjectFile: (file) => !path.relative(project, file).startsWith("..") && !path.isAbsolute(path.relative(project, file)) };
	const ok = (input: string): string => {
		const verdict = normalizeBrowserUrl(input, policy);
		if (!verdict.ok) throw new Error(`expected ${input} to be allowed: ${verdict.message}`);
		return verdict.url;
	};

	it("turns bare host:port and ports into http URLs", () => {
		expect(ok("localhost:1234")).toBe("http://localhost:1234/");
		expect(ok("  localhost:3000/app?x=1 ")).toBe("http://localhost:3000/app?x=1");
		expect(ok("127.0.0.1:5173")).toBe("http://127.0.0.1:5173/");
		expect(ok("[::1]:8080")).toBe("http://[::1]:8080/");
		expect(ok(":3000")).toBe("http://localhost:3000/");
		expect(ok("8080")).toBe("http://localhost:8080/");
		expect(ok("myserver.local:9000")).toBe("http://myserver.local:9000/");
		expect(ok("devbox")).toBe("http://devbox/");
	});

	it("uses https for other bare hosts and keeps explicit schemes", () => {
		expect(ok("example.com")).toBe("https://example.com/");
		expect(ok("example.com/a b".replace(" ", "%20"))).toBe("https://example.com/a%20b");
		expect(ok("http://example.com")).toBe("http://example.com/");
		expect(ok("https://localhost:8443/x")).toBe("https://localhost:8443/x");
		expect(ok("about:blank")).toBe("about:blank");
	});

	it("refuses empty/garbage input and browser-internal or script schemes", () => {
		for (const input of ["", "   ", "two words", "http://", "https:///"]) expect(normalizeBrowserUrl(input, policy).ok, input).toBe(false);
		for (const input of ["chrome://settings", "chrome:version", "devtools://devtools/bundled/inspector.html", "chrome-extension://abc/x.html", "view-source:http://localhost:1/", "javascript:alert(1)", "data:text/html,<b>x</b>", "ftp://example.com", "about:config", "blob:http://x/1"]) {
			const verdict = normalizeBrowserUrl(input, policy);
			expect(verdict.ok, input).toBe(false);
			if (!verdict.ok) expect(verdict.code, input).toBe("blocked");
		}
	});

	it("allows file:// only inside project folders (absolute paths, file URLs, ~/ paths, symlink-proof)", () => {
		const inside = path.join(project, "site", "index.html");
		expect(ok(inside)).toBe(pathToFileURL(inside).href);
		expect(ok(pathToFileURL(inside).href)).toBe(pathToFileURL(inside).href);
		for (const outside of ["/etc/passwd", pathToFileURL("/etc/hosts").href, "file:///etc/passwd", "~/.ssh/id_rsa", path.join(project, "..", "elsewhere.txt"), path.join(project, "site", "..", "..", "x")]) {
			const verdict = normalizeBrowserUrl(outside, policy);
			expect(verdict.ok, outside).toBe(false);
			if (!verdict.ok) expect(verdict.code, outside).toBe("blocked");
		}
	});

	it("checks where a page ended up (redirects, location changes)", () => {
		expect(isPermittedLocation("http://localhost:1/x", policy)).toBe(true);
		expect(isPermittedLocation("about:blank", policy)).toBe(true);
		expect(isPermittedLocation("chrome-error://chromewebdata/", policy)).toBe(true);
		expect(isPermittedLocation("chrome://settings/", policy)).toBe(false);
		expect(isPermittedLocation("devtools://devtools/x", policy)).toBe(false);
		expect(isPermittedLocation("file:///etc/passwd", policy)).toBe(false);
	});
});

const LSOF = `COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
rapportd    620 congle    8u  IPv4 0x9e0c4c8f6e1a6b0c      0t0  TCP *:49152 (LISTEN)
rapportd    620 congle    9u  IPv6 0x1c3e4f0d5a2b7c9d      0t0  TCP *:49152 (LISTEN)
node      41234 congle   21u  IPv6 0x4a5b6c7d8e9f0a1b      0t0  TCP [::1]:5173 (LISTEN)
node      41234 congle   22u  IPv4 0x2b3c4d5e6f708192      0t0  TCP 127.0.0.1:5173 (LISTEN)
Google\\x20Chrome  777 congle   40u  IPv4 0x1111111111111111      0t0  TCP 127.0.0.1:9222 (LISTEN)
python3   50001 congle    4u  IPv4 0xabcdef0123456789      0t0  TCP 192.168.1.20:8000 (LISTEN)
postgres  1200 congle    7u  IPv4 0x2222222222222222      0t0  TCP 127.0.0.1:5432 (LISTEN)
node      41234 congle   23u  IPv4 0x3333333333333333      0t0  TCP 127.0.0.1:4317 (LISTEN)
garbage line
`;
const SS = `LISTEN 0      511          127.0.0.1:5173       0.0.0.0:*    users:(("node",pid=4123,fd=19))
LISTEN 0      511              [::1]:5173          [::]:*    users:(("node",pid=4123,fd=20))
LISTEN 0      4096           0.0.0.0:8080       0.0.0.0:*    users:(("python3",pid=999,fd=3))
LISTEN 0      128               [::]:22              [::]:*
LISTEN 0      4096     127.0.0.53%lo:53         0.0.0.0:*
LISTEN 0      511                  *:3000              *:*    users:(("next-server (v1",pid=5000,fd=22))
ESTAB  0      0         127.0.0.1:5173     127.0.0.1:50000
`;
const NETSTAT = `Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1004
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       8712
  TCP    [::]:445               [::]:0                 LISTENING       4
  TCP    127.0.0.1:5173         127.0.0.1:50122        ESTABLISHED     8712
`;

describe("listening port discovery", () => {
	it("parses lsof -iTCP -sTCP:LISTEN -nP output (IPv4/IPv6/wildcard, escaped names)", () => {
		const parsed = parseLsof(LSOF);
		expect(parsed).toContainEqual({ port: 5173, address: "::1", pid: 41234, process: "node" });
		expect(parsed).toContainEqual({ port: 5173, address: "127.0.0.1", pid: 41234, process: "node" });
		expect(parsed).toContainEqual({ port: 49152, address: "*", pid: 620, process: "rapportd" });
		expect(parsed).toContainEqual({ port: 9222, address: "127.0.0.1", pid: 777, process: "Google Chrome" });
		expect(parsed).toContainEqual({ port: 8000, address: "192.168.1.20", pid: 50001, process: "python3" });
		expect(parsed).toHaveLength(8);
	});

	it("parses ss -ltnpH output", () => {
		const parsed = parseSs(SS);
		expect(parsed).toContainEqual({ port: 5173, address: "127.0.0.1", pid: 4123, process: "node" });
		expect(parsed).toContainEqual({ port: 8080, address: "*", pid: 999, process: "python3" });
		expect(parsed).toContainEqual({ port: 22, address: "*", pid: null, process: null });
		expect(parsed).toContainEqual({ port: 53, address: "127.0.0.53", pid: null, process: null });
		expect(parsed).toContainEqual({ port: 3000, address: "*", pid: 5000, process: "next-server (v1" });
		expect(parsed.some((l) => l.port === 50000)).toBe(false);
	});

	it("parses Windows netstat -ano output (listeners only)", () => {
		expect(parseNetstat(NETSTAT)).toEqual([
			{ port: 135, address: "*", pid: 1004, process: null },
			{ port: 5173, address: "127.0.0.1", pid: 8712, process: null },
			{ port: 445, address: "*", pid: 4, process: null },
		]);
	});

	it("merges IPv4/IPv6 twins, preferring the address that answers localhost, and builds the address to type", () => {
		const merged = mergeListeners(parseLsof(LSOF));
		const vite = merged.find((l) => l.port === 5173)!;
		expect(vite.address).toBe("127.0.0.1");
		expect(urlFor(vite)).toBe("localhost:5173");
		expect(urlFor(merged.find((l) => l.port === 8000)!)).toBe("192.168.1.20:8000");
		expect(urlFor({ port: 80, address: "fe80::1", pid: null, process: null })).toBe("[fe80::1]:80");
		expect(merged.filter((l) => l.port === 49152)).toHaveLength(1);
	});

	it("names well-known dev servers from their command line", () => {
		expect(hintFromCommand("/usr/local/bin/node /app/node_modules/.bin/vite --port 5173")).toBe("vite");
		expect(hintFromCommand("node /app/node_modules/next/dist/bin/next dev")).toBe("next");
		expect(hintFromCommand("python3 -m http.server 8000")).toBe("http.server");
		expect(hintFromCommand("/usr/bin/postgres -D /var/lib")).toBeNull();
	});

	it("names a process by its executable (ps), never by the thread name or the cut name lsof prints", async () => {
		// lsof reports the task that holds the socket: a Node server is `MainThrea` (a thread), Chrome helpers are cut at 9 characters
		const ps = `41234 Sat Nov  1 01:00:00 2026 /usr/local/bin/node /app/server.js --port 4000
  620 Sat Nov  1 00:10:00 2026 /System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter
50001 Sat Nov  1 02:00:00 2026 python3 -m http.server 8000
`;
		const comm = `41234 /usr/local/bin/node
  620 /System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter
50001 python3
60002 /Applications/My Dev Server.app/Contents/MacOS/My Dev Server
`;
		expect([...parsePsCommands(ps)]).toEqual([
			[41234, { command: "/usr/local/bin/node /app/server.js --port 4000", startedAt: new Date("Sat Nov  1 01:00:00 2026").toISOString() }],
			[620, { command: "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter", startedAt: new Date("Sat Nov  1 00:10:00 2026").toISOString() }],
			[50001, { command: "python3 -m http.server 8000", startedAt: new Date("Sat Nov  1 02:00:00 2026").toISOString() }],
		]);
		expect(parsePsComm(comm).get(60002)).toBe("/Applications/My Dev Server.app/Contents/MacOS/My Dev Server");
		expect(executableName(parsePsComm(comm).get(41234) ?? null, "/usr/local/bin/node /app/server.js")).toBe("node");
		expect(executableName("/Applications/My Dev Server.app/Contents/MacOS/My Dev Server", "/Applications/My Dev Server.app/Contents/MacOS/My Dev Server --x")).toBe("My Dev Server");
		expect(executableName("python3", "python3 -m http.server 8000")).toBe("python3");
		// Linux cuts comm at 15 characters; the command line completes it
		expect(executableName("my-long-service-", "/opt/bin/my-long-service-name --serve")).toBe("my-long-service-name");
		expect(executableName("short", "short --serve")).toBe("short");
		// no comm: the first word of the command line
		expect(executableName(null, "node server.js")).toBe("node");
		expect(executableName(null, "   ")).toBeNull();

		const discovery = new PortDiscovery({
			selfPorts: () => [],
			selfPids: () => [],
			read: async () => [
				{ port: 4000, address: "127.0.0.1", pid: 41234, process: "MainThrea" },
				{ port: 7000, address: "*", pid: 620, process: "ControlCe" },
				{ port: 9000, address: "*", pid: 70000, process: "MainThrea" },
			],
			commands: async () =>
				new Map([
					[41234, { command: "/usr/local/bin/node /app/server.js", startedAt: null, executable: "node" }],
					[620, { command: "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter", startedAt: null, executable: "ControlCenter" }],
				]),
			probe: async () => ({ web: true, title: null, clam: false }),
		});
		const list = await discovery.list();
		// resolved through ps: `node`; a system daemon is still recognised by either name
		expect(list.find((p) => p.port === 4000)?.process).toBe("node");
		expect(list.map((p) => p.port)).not.toContain(7000);
		// ps knew nothing of this pid: the process is whatever lsof said (nothing better is available)
		expect(list.find((p) => p.port === 9000)?.process).toBe("MainThrea");
	});

	it("lists only web servers (title, newest first), without this node's ports, CL Agent Mesh servers or system daemons; caches probes", async () => {
		const probed: number[] = [];
		const extra = [{ port: 5188, address: "127.0.0.1", pid: 60000, process: "node" }, { port: 3000, address: "*", pid: 60001, process: "node" }, { port: 7000, address: "*", pid: 680, process: "ControlCe" }];
		const discovery = new PortDiscovery({
			selfPorts: () => [4317],
			selfPids: () => [777],
			read: async () => [...parseLsof(LSOF), ...extra],
			commands: async () =>
				new Map([
					[41234, { command: "node /app/node_modules/.bin/vite", startedAt: "2026-11-01T01:00:00.000Z", executable: "node" }],
					[50001, { command: "python3 -m http.server 8000", startedAt: "2026-11-01T02:00:00.000Z", executable: "python3" }],
					[60001, { command: "node server.js", startedAt: "2026-11-01T01:30:00.000Z", executable: "node" }],
				]),
			probe: async (_host, port) => {
				probed.push(port);
				if (port === 5173) return { web: true, title: "Todo demo", clam: false };
				if (port === 8000) return { web: true, title: null, clam: false };
				if (port === 3000) return { web: true, title: "API", clam: false };
				if (port === 5188) return { web: true, title: "CL Agent Mesh", clam: true };
				return { web: false, title: null, clam: false };
			},
		});
		const list = await discovery.list();
		expect(list.map((p) => p.port)).toEqual([8000, 3000, 5173]); // newest process first
		expect(list[2]).toMatchObject({ port: 5173, process: "node", hint: "vite", likelyHttp: true, title: "Todo demo", url: "localhost:5173", startedAt: "2026-11-01T01:00:00.000Z" });
		expect(list[0]).toMatchObject({ hint: "http.server", title: null, url: "192.168.1.20:8000" });
		// never probed: system daemons, databases; never listed: the browser's own process, this node, other CL Agent Mesh nodes
		expect(probed).not.toContain(5432);
		expect(probed).not.toContain(49152);
		expect(probed).not.toContain(7000);
		expect(list.map((p) => p.port)).not.toContain(9222);
		expect(list.map((p) => p.port)).not.toContain(4317);
		expect(list.map((p) => p.port)).not.toContain(5188);
		const before = probed.length;
		await discovery.list();
		expect(probed.length).toBe(before);
	});

	it("probes real HTTP servers: HTML and JSON are web, plain/closed are not, CL Agent Mesh is recognised", async () => {
		const servers: Server[] = [];
		const listen = async (handler: Parameters<typeof createServer>[1]): Promise<number> => {
			const server = createServer(handler);
			servers.push(server);
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			return (server.address() as AddressInfo).port;
		};
		try {
			const html = await listen((_q, r) => (r.writeHead(200, { "content-type": "text/html; charset=utf-8" }), r.end("<!doctype html><title>  Todo &amp; demo \n</title><body>x")));
			const json = await listen((_q, r) => (r.writeHead(200, { "content-type": "application/json" }), r.end('{"ok":true}')));
			const plain = await listen((_q, r) => (r.writeHead(403, { "content-type": "text/plain" }), r.end("Forbidden")));
			const slow = await listen(() => undefined);
			const wire = await listen((q, r) => {
				if (q.url === "/api/v1/node/info") (r.writeHead(200, { "content-type": "application/json" }), r.end('{"protocolVersions":["1"],"nodeId":"n"}'));
				else (r.writeHead(404, { "content-type": "application/json" }), r.end('{"error":{"code":"not_found"}}'));
			});
			const ui = await listen((q, r) => {
				if (q.url === "/api/local/node") (r.writeHead(200, { "content-type": "application/json" }), r.end('{"fingerprint":"abc"}'));
				else (r.writeHead(200, { "content-type": "text/html" }), r.end("<title>CL Agent Mesh</title>"));
			});
			expect(await probeWeb("127.0.0.1", html)).toEqual({ web: true, title: "Todo & demo", clam: false });
			expect(await probeWeb("127.0.0.1", json)).toEqual({ web: true, title: null, clam: false });
			expect(await probeWeb("127.0.0.1", plain)).toMatchObject({ web: false });
			expect(await probeWeb("127.0.0.1", slow, 150)).toMatchObject({ web: false });
			expect(await probeWeb("127.0.0.1", wire)).toMatchObject({ web: true, clam: true });
			expect(await probeWeb("127.0.0.1", ui)).toMatchObject({ web: true, clam: true });
			expect(await probeWeb("127.0.0.1", 1)).toMatchObject({ web: false });
			expect(extractTitle("<html><TITLE>Hi</TITLE>")).toBe("Hi");
			expect(extractTitle("<p>none</p>")).toBeNull();
		} finally {
			for (const server of servers) server.closeAllConnections(), server.close();
		}
	});
});

describe("viewport emulation and input mapping", () => {
	it("computes the emulated viewport for each device mode (DPR capped at 2)", () => {
		expect(computeViewport({ width: 1000.4, height: 700, dpr: 3, device: "fit" })).toEqual({ width: 1000, height: 700, deviceScale: 2, mobile: false, device: "fit" });
		expect(computeViewport({ width: 900, height: 600, dpr: 1, device: "desktop" })).toEqual({ width: 1440, height: 960, deviceScale: 1, mobile: false, device: "desktop" });
		expect(computeViewport({ width: 390, height: 700, dpr: 3, device: "iphone" })).toEqual({ width: 440, height: 956, deviceScale: 2, mobile: true, device: "iphone" });
	});

	it("maps viewer key events: printable keys carry text, chords are raw with editing commands, Enter types a return", () => {
		const key = (over: Record<string, unknown>) => ({ type: "key" as const, action: "down" as const, key: "a", code: "KeyA", keyCode: 65, location: 0, modifiers: 0, repeat: false, ...over });
		expect(keyEventParams(key({}))).toMatchObject({ type: "keyDown", text: "a", windowsVirtualKeyCode: 65 });
		expect(keyEventParams(key({ key: "A", modifiers: 8 }))).toMatchObject({ type: "keyDown", text: "A" });
		expect(keyEventParams(key({ key: "Enter", code: "Enter", keyCode: 13 }))).toMatchObject({ type: "keyDown", text: "\r" });
		expect(keyEventParams(key({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }))).toMatchObject({ type: "rawKeyDown" });
		expect(keyEventParams(key({ modifiers: 4 }))).toMatchObject({ type: "rawKeyDown", commands: ["selectAll"] });
		expect(keyEventParams(key({ key: "z", modifiers: 2 | 8 }))).toMatchObject({ type: "rawKeyDown", commands: ["redo"] });
		expect(keyEventParams(key({ key: "€", modifiers: 2 | 1 }))).toMatchObject({ type: "keyDown", text: "€" }); // AltGr
		expect(keyEventParams(key({ action: "up" }))).toMatchObject({ type: "keyUp" });
	});

	it("describes console arguments", () => {
		expect(describeRemoteObject({ type: "string", value: "hello" })).toBe("hello");
		expect(describeRemoteObject({ type: "number", value: 42 })).toBe("42");
		expect(describeRemoteObject({ type: "undefined" })).toBe("undefined");
		expect(describeRemoteObject({ type: "object", subtype: "null" })).toBe("null");
		expect(describeRemoteObject({ type: "object", description: "Object", preview: { properties: [{ name: "a", type: "number", value: "1" }, { name: "b", type: "string", value: "x" }] } })).toBe('{a: 1, b: "x"}');
		expect(describeRemoteObject({ type: "object", subtype: "array", description: "Array(2)", preview: { properties: [{ name: "0", type: "number", value: "1" }, { name: "1", type: "number", value: "2" }] } })).toBe("[1, 2]");
		expect(describeRemoteObject({ type: "object", subtype: "error", description: "Error: boom\n    at x" })).toBe("Error: boom\n    at x");
	});

	it("reads the installer's progress", () => {
		expect(parseInstallProgress("|■■■■■■■■        |  42% of 150.3 MiB")).toBe(42);
		expect(parseInstallProgress("\r 10%\r 55%\r 97%")).toBe(97);
		expect(parseInstallProgress("Downloading Chromium")).toBeNull();
	});
});
