import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createTunnelManager,
	detectCloudflared,
	type TunnelManager,
	type TunnelRuntimeState,
} from "../src/index.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-cloudflared.mjs");
const ORIGIN = "http://127.0.0.1:4318";
const TOKEN = "eyJhIjoiVE9LRU4tU0VDUkVULVZBTFVFLTEyMzQ1Njc4OTAiLCJ0IjoiMTExMSIsInMiOiJhYmMifQ==";

let root: string;
let fakeDir: string;
let runtimeDir: string;
let managers: TunnelManager[] = [];
let logged: string[] = [];

interface Capture {
	argv: string[];
	env: Record<string, string>;
	tokenFile: string | null;
	tokenMode: string | null;
	token: string | null;
	pid: number;
	spawnedAtMs: number;
}

function capture(n: number): Capture {
	return JSON.parse(readFileSync(join(fakeDir, `capture-${n}.json`), "utf8")) as Capture;
}
function spawnCount(): number {
	const f = join(fakeDir, "count");
	return existsSync(f) ? Number(readFileSync(f, "utf8")) : 0;
}

async function waitFor<T>(fn: () => T | undefined | false | null, ms = 15_000, what = "condition"): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(extra: Partial<Parameters<typeof createTunnelManager>[0]> = {}) {
	const m = createTunnelManager({
		binary: FAKE,
		runtimeDir,
		originUrl: ORIGIN,
		readyPollMs: 40,
		runningPollMs: 60,
		stopGraceMs: 2_000,
		backoffBaseMs: 100,
		log: {
			info: (o, msg) => logged.push(JSON.stringify([o, msg])),
			warn: (o, msg) => logged.push(JSON.stringify([o, msg])),
		},
		...extra,
	});
	managers.push(m);
	return m;
}
function phases(seen: TunnelRuntimeState[]): string[] {
	return seen.map((x) => x.state).filter((st, i, a) => i === 0 || st !== a[i - 1]);
}
function track(m: TunnelManager): TunnelRuntimeState[] {
	const seen: TunnelRuntimeState[] = [];
	m.onChange((s) => seen.push(s));
	return seen;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "clam-tunnel-"));
	fakeDir = join(root, "fake");
	runtimeDir = join(root, "run");
	await (await import("node:fs/promises")).mkdir(fakeDir, { recursive: true });
	await chmod(FAKE, 0o755);
	process.env.FAKE_CF_DIR = fakeDir;
	process.env.TUNNEL_TOKEN = "leaked-parent-env-token";
	managers = [];
	logged = [];
});

afterEach(async () => {
	await Promise.all(managers.map((m) => m.dispose()));
	for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_CF_")) delete process.env[k];
	delete process.env.TUNNEL_TOKEN;
	await rm(root, { recursive: true, force: true });
});

describe("detectCloudflared", () => {
	it("parses the version of an executable", async () => {
		const info = await detectCloudflared({ binary: FAKE });
		expect(info).toEqual({ installed: true, version: "2026.10.5", binaryPath: FAKE });
	});
	it("reports a missing binary", async () => {
		const info = await detectCloudflared({ binary: join(root, "nope") });
		expect(info).toEqual({ installed: false, version: null, binaryPath: null });
	});
	it("reports a non-cloudflared executable as not installed", async () => {
		const bogus = join(root, "bogus");
		await writeFile(bogus, "#!/bin/sh\necho hello\n", { mode: 0o755 });
		const info = await detectCloudflared({ binary: bogus });
		expect(info.installed).toBe(false);
		expect(info.binaryPath).toBe(bogus);
	});
});

describe("quick mode", () => {
	it("extracts the trycloudflare URL (ignoring api.trycloudflare.com) and becomes running", async () => {
		const m = make();
		const seen = track(m);
		const s = await m.start({ mode: "quick" });
		expect(s.state).toBe("running");
		expect(s.mode).toBe("quick");
		expect(s.publicUrl).toBe("https://fake-quick-1.trycloudflare.com");
		expect(s.connections).toBe(4);
		expect(s.pid).toBeGreaterThan(0);
		expect(s.lastError).toBeNull();
		expect(s.startedAt).not.toBeNull();
		expect(phases(seen)).toEqual(["starting", "running"]);

		const c = capture(1);
		expect(c.argv.slice(0, 2)).toEqual(["tunnel", "--no-autoupdate"]);
		expect(c.argv[c.argv.indexOf("--url") + 1]).toBe(ORIGIN);
		expect(c.argv.some((a) => /^127\.0\.0\.1:\d+$/.test(a))).toBe(true);
		expect(c.argv).toContain("--metrics");
		expect(c.argv).not.toContain("--token-file");
		expect(existsSync(join(runtimeDir, "tunnel-token"))).toBe(false);

		const stopped = await m.stop();
		expect(stopped).toMatchObject({ state: "stopped", mode: "off", publicUrl: null, pid: null, connections: 0 });
		expect(() => process.kill(s.pid as number, 0)).toThrow();
	});
});

describe("named mode", () => {
	it("is running with the configured hostname; token only ever in a 0600 file", async () => {
		const m = make();
		const s = await m.start({ mode: "named", token: TOKEN, hostname: "Node-A.Example.com" });
		expect(s).toMatchObject({ state: "running", mode: "named", publicUrl: "https://node-a.example.com", connections: 4 });

		const c = capture(1);
		expect(c.argv).toEqual([
			"tunnel",
			"--no-autoupdate",
			"--metrics",
			c.argv[3],
			"run",
			"--token-file",
			join(runtimeDir, "tunnel-token"),
		]);
		expect(c.argv.join(" ")).not.toContain(TOKEN);
		// token reached the process only through the file
		expect(c.token).toBe(TOKEN);
		expect(c.tokenMode).toBe("600");
		expect(Object.values(c.env).some((v) => v.includes(TOKEN))).toBe(false);
		expect(c.env.TUNNEL_TOKEN).toBeUndefined();
		expect(Object.keys(c.env).some((k) => k.startsWith("TUNNEL_"))).toBe(false);

		expect(statSync(join(runtimeDir, "tunnel-token")).mode & 0o777).toBe(0o600);

		// the fake echoes the token on stderr: it must be scrubbed everywhere we expose output
		expect(logged.some((l) => l.includes("loaded credentials token="))).toBe(true);
		expect(logged.join("\n")).not.toContain(TOKEN);
		expect(logged.join("\n")).toContain("[redacted]");
		expect(JSON.stringify(m.state())).not.toContain(TOKEN);

		await m.stop();
		expect(existsSync(join(runtimeDir, "tunnel-token"))).toBe(false);
	});

	it("rejects invalid configuration", async () => {
		const m = make();
		await expect(m.start({ mode: "named", token: "", hostname: "a.example.com" })).rejects.toThrow(/token/);
		await expect(m.start({ mode: "named", token: "has space", hostname: "a.example.com" })).rejects.toThrow(/token/);
		await expect(m.start({ mode: "named", token: TOKEN, hostname: "https://a.example.com/x" })).rejects.toThrow(
			/hostname/,
		);
		expect(m.state().state).toBe("stopped");
		expect(spawnCount()).toBe(0);
	});

	it("enters error (no restart) on a bad token and never leaks the token", async () => {
		process.env.FAKE_CF_BEHAVIOR = "bad-token";
		const m = make();
		const seen = track(m);
		const s = await m.start({ mode: "named", token: TOKEN, hostname: "a.example.com" });
		expect(s.state).toBe("error");
		expect(s.lastError).toMatch(/token is not valid/i);
		expect(s.publicUrl).toBeNull();
		expect(s.pid).toBeNull();
		await sleep(600);
		expect(spawnCount()).toBe(1);
		expect(m.state().state).toBe("error");
		expect(phases(seen)).toEqual(["starting", "error"]);
		expect(JSON.stringify(seen)).not.toContain(TOKEN);
		expect(existsSync(join(runtimeDir, "tunnel-token"))).toBe(false);
		expect((await m.stop()).state).toBe("stopped");
	});
});

describe("failure handling", () => {
	it("enters error when the binary is missing", async () => {
		const m = make({ binary: join(root, "missing-cloudflared") });
		const s = await m.start({ mode: "quick" });
		expect(s).toMatchObject({ state: "error", mode: "quick", lastError: "cloudflared executable not found" });
	});

	it("restarts after a crash with exponential backoff", async () => {
		process.env.FAKE_CF_BEHAVIOR = "crash-early";
		process.env.FAKE_CF_CRASHES = "3";
		const m = make({ backoffBaseMs: 300 });
		const seen = track(m);
		const first = await m.start({ mode: "quick" });
		// start() settles on the first failed attempt
		expect(first.state).toBe("starting");
		expect(first.lastError).toMatch(/Failed to dial a quic connection/);
		expect(first.pid).toBeNull();

		const s = await waitFor(() => (m.state().state === "running" ? m.state() : null), 20_000, "running after restarts");
		expect(spawnCount()).toBe(4);
		expect(s.publicUrl).toBe("https://fake-quick-4.trycloudflare.com");
		expect(s.lastError).toBeNull();

		// gaps between spawns grow: base*2^0, base*2^1, base*2^2
		const t = [1, 2, 3, 4].map((i) => capture(i).spawnedAtMs);
		const gaps = [t[1]! - t[0]!, t[2]! - t[1]!, t[3]! - t[2]!];
		expect(gaps[0]).toBeGreaterThanOrEqual(300);
		expect(gaps[1]).toBeGreaterThanOrEqual(600);
		expect(gaps[2]).toBeGreaterThanOrEqual(1200);
		expect(gaps[1]! - gaps[0]!).toBeGreaterThan(150);
		expect(seen.some((x) => x.state === "starting" && x.lastError !== null)).toBe(true);
	});

	it("goes running → reconnecting → running when a healthy process crashes", async () => {
		process.env.FAKE_CF_BEHAVIOR = "crash";
		process.env.FAKE_CF_CRASHES = "1";
		const m = make();
		const seen = track(m);
		const first = await m.start({ mode: "named", token: TOKEN, hostname: "a.example.com" });
		expect(first.state).toBe("running");
		await waitFor(() => seen.some((x) => x.state === "reconnecting"), 10_000, "reconnecting");
		const again = await waitFor(
			() => (spawnCount() === 2 && m.state().state === "running" ? m.state() : null),
			10_000,
			"running again",
		);
		expect(again.pid).not.toBe(first.pid);
		const states = seen.map((x) => x.state);
		expect(states.indexOf("running")).toBeLessThan(states.indexOf("reconnecting"));
		expect(states.lastIndexOf("running")).toBeGreaterThan(states.indexOf("reconnecting"));
		// named hostname stays published while reconnecting
		expect(seen.filter((x) => x.state === "reconnecting").every((x) => x.publicUrl === "https://a.example.com")).toBe(true);
		expect(JSON.stringify(seen)).not.toContain(TOKEN);
		expect(statSync(join(runtimeDir, "tunnel-token")).mode & 0o777).toBe(0o600);
	});

	it("stop() prevents any restart, including while waiting out a backoff", async () => {
		process.env.FAKE_CF_BEHAVIOR = "crash-early";
		process.env.FAKE_CF_CRASHES = "100";
		const m = make({ backoffBaseMs: 60_000, backoffMaxMs: 60_000 });
		const first = await m.start({ mode: "quick" });
		expect(first.state).toBe("starting");
		expect(spawnCount()).toBe(1);
		const t0 = Date.now();
		const stopped = await m.stop();
		expect(Date.now() - t0).toBeLessThan(2_000);
		expect(stopped.state).toBe("stopped");
		await sleep(500);
		expect(spawnCount()).toBe(1);
		expect(m.state().state).toBe("stopped");
	});

	it("stop() of a running tunnel terminates it gracefully and does not restart it", async () => {
		const m = make();
		const s = await m.start({ mode: "quick" });
		await m.stop();
		expect(existsSync(join(fakeDir, "term-1"))).toBe(true);
		await sleep(500);
		expect(spawnCount()).toBe(1);
		expect(() => process.kill(s.pid as number, 0)).toThrow();
	});

	it("escalates to SIGKILL when cloudflared ignores SIGTERM", async () => {
		process.env.FAKE_CF_IGNORE_TERM = "1";
		const m = make({ stopGraceMs: 300 });
		const s = await m.start({ mode: "quick" });
		const t0 = Date.now();
		await m.stop();
		expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
		expect(() => process.kill(s.pid as number, 0)).toThrow();
	});

	it("does not report reconnecting while a stop is draining the process", async () => {
		process.env.FAKE_CF_IGNORE_TERM = "1";
		process.env.FAKE_CF_TERM_DRAINS = "1";
		const m = make({ stopGraceMs: 600 });
		const seen = track(m);
		const s = await m.start({ mode: "quick" });
		const stopping = m.stop();
		await sleep(300);
		// Mid-stop the process is alive but draining; the state must not flip to a misleading "reconnecting".
		expect(m.state().state).not.toBe("reconnecting");
		await stopping;
		expect(m.state().state).toBe("stopped");
		expect(phases(seen)).toEqual(["starting", "running", "stopped"]);
		expect(() => process.kill(s.pid as number, 0)).toThrow();
	});

	it("restarts a never-ready attempt after startTimeoutMs", async () => {
		await writeFile(join(fakeDir, "conns"), "0");
		const m = make({ startTimeoutMs: 600 });
		const first = await m.start({ mode: "quick" });
		expect(first.state).toBe("starting");
		expect(first.lastError).toMatch(/timed out/);
		await waitFor(() => spawnCount() >= 2, 10_000, "second attempt");
	});
});

describe("connections", () => {
	it("tracks the ready connection count and reconnecting when it drops to zero", async () => {
		const m = make();
		const seen = track(m);
		const s = await m.start({ mode: "quick" });
		expect(s.connections).toBe(4);

		await writeFile(join(fakeDir, "conns"), "2");
		await waitFor(() => m.state().connections === 2, 5_000, "2 connections");
		expect(m.state().state).toBe("running");

		await writeFile(join(fakeDir, "conns"), "0");
		await waitFor(() => m.state().state === "reconnecting", 5_000, "reconnecting");
		expect(m.state().connections).toBe(0);
		expect(m.state().publicUrl).toBe("https://fake-quick-1.trycloudflare.com");

		await writeFile(join(fakeDir, "conns"), "3");
		await waitFor(() => m.state().state === "running" && m.state().connections === 3, 5_000, "running with 3");
		expect(spawnCount()).toBe(1);
		expect(phases(seen)).toEqual(["starting", "running", "reconnecting", "running"]);
	});
});

describe("lifecycle", () => {
	it("start() replaces a running tunnel; onChange unsubscribe works", async () => {
		const m = make();
		const seen: TunnelRuntimeState[] = [];
		const off = m.onChange((x) => seen.push(x));
		const a = await m.start({ mode: "quick" });
		const b = await m.start({ mode: "named", token: TOKEN, hostname: "b.example.com" });
		expect(b.publicUrl).toBe("https://b.example.com");
		expect(b.pid).not.toBe(a.pid);
		expect(() => process.kill(a.pid as number, 0)).toThrow();
		off();
		const n = seen.length;
		await m.stop();
		expect(seen.length).toBe(n);
	});

	it("dispose() is idempotent, kills the child, removes the token file and blocks further starts", async () => {
		const m = make();
		const s = await m.start({ mode: "named", token: TOKEN, hostname: "a.example.com" });
		await Promise.all([m.dispose(), m.dispose()]);
		await m.dispose();
		expect(() => process.kill(s.pid as number, 0)).toThrow();
		expect(existsSync(join(runtimeDir, "tunnel-token"))).toBe(false);
		expect(m.state().state).toBe("stopped");
		await expect(m.start({ mode: "quick" })).rejects.toThrow(/disposed/);
	});
});
