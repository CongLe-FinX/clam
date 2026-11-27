import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { QuitAppResult, SystemProcesses, SystemStatus } from "@clam/contracts";
import { afterEach, describe, expect, it } from "vitest";
import systemRoutes from "../src/api/system.ts";
import {
	appNameOf,
	batteryFromSysfs,
	computeAlerts,
	cpuPercent,
	groupProcesses,
	parseMeminfo,
	parsePressureLevel,
	parsePmsetBatt,
	parsePsLine,
	quitPlan,
	parseSwapUsage,
	parseVmStat,
} from "../src/services/system-metrics.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

const GB = 1024 ** 3;

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                3510.
Pages active:                            283560.
Pages inactive:                          279914.
Pages speculative:                         2814.
Pages throttled:                              0.
Pages wired down:                         94536.
Pages purgeable:                          10000.
Pages occupied by compressor:            159262.
`;

describe("memory parsing", () => {
	it("derives used from active + wired + compressor with the page size of the header", () => {
		const total = 16 * GB;
		const r = parseVmStat(VM_STAT, total)!;
		expect(r.used).toBe((283560 + 94536 + 159262) * 16384);
		expect(r.available).toBe(total - r.used);
		expect(parseVmStat("garbage", total)).toBeNull();
	});

	it("reads swap usage, pressure level and /proc/meminfo", () => {
		expect(parseSwapUsage("total = 2048.00M  used = 1051.25M  free = 996.75M  (encrypted)")).toEqual({ total: 2048 * 1024 ** 2, used: 1051.25 * 1024 ** 2 });
		expect(parsePressureLevel("1\n")).toBe("normal");
		expect(parsePressureLevel("2")).toBe("warning");
		expect(parsePressureLevel("4")).toBe("critical");
		expect(parsePressureLevel("x")).toBeNull();
		const info = parseMeminfo("MemTotal: 16000000 kB\nMemFree: 100 kB\nMemAvailable: 4000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 500000 kB\n")!;
		expect(info).toMatchObject({ total: 16000000 * 1024, available: 4000000 * 1024, used: 12000000 * 1024, swapTotal: 2000000 * 1024, swapUsed: 1500000 * 1024 });
	});

	it("computes cpu percent from time deltas", () => {
		expect(cpuPercent({ idle: 100, total: 200 }, { idle: 150, total: 300 })).toBe(50);
		expect(cpuPercent({ idle: 1, total: 1 }, { idle: 1, total: 1 })).toBe(0);
	});
});

describe("battery parsing", () => {
	const pmset = (line: string, source = "AC Power") => `Now drawing from '${source}'\n -InternalBattery-0 (id=6357091)\t${line}\n`;

	it("reads charge, state, power source and the estimate from pmset", () => {
		expect(parsePmsetBatt(pmset("4%; charging; 20:00 remaining present: true"))).toEqual({ percent: 4, charging: true, pluggedIn: true, minutesRemaining: 1200 });
		expect(parsePmsetBatt(pmset("63%; discharging; 3:07 remaining present: true", "Battery Power"))).toEqual({ percent: 63, charging: false, pluggedIn: false, minutesRemaining: 187 });
		// No estimate yet, full, or held below full on AC: no time, plugged in, not charging (except while still charging).
		expect(parsePmsetBatt(pmset("5%; charging; (no estimate) present: true"))).toMatchObject({ charging: true, minutesRemaining: null });
		expect(parsePmsetBatt(pmset("100%; charged; 0:00 remaining present: true"))).toEqual({ percent: 100, charging: false, pluggedIn: true, minutesRemaining: null });
		expect(parsePmsetBatt(pmset("80%; AC attached; not charging present: true"))).toMatchObject({ percent: 80, charging: false, pluggedIn: true });
	});

	it("has no battery on a desktop Mac or when the battery is not present", () => {
		expect(parsePmsetBatt("Now drawing from 'AC Power'\n")).toBeNull();
		expect(parsePmsetBatt(pmset("0%; discharging; (no estimate) present: false", "Battery Power"))).toBeNull();
	});

	it("reads a Linux battery from sysfs, the AC adapter deciding plugged-in when known", () => {
		expect(batteryFromSysfs("57\n", "Discharging\n", false)).toEqual({ percent: 57, charging: false, pluggedIn: false, minutesRemaining: null });
		expect(batteryFromSysfs("100", "Full", null)).toMatchObject({ charging: false, pluggedIn: true });
		expect(batteryFromSysfs("", "Unknown", null)).toBeNull();
	});
});

describe("process grouping", () => {
	it("names apps by the outermost .app bundle and never keeps arguments", () => {
		expect(appNameOf("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/x")).toBe("Google Chrome");
		expect(appNameOf("/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --token=SECRET")).toBe("Google Chrome");
		expect(appNameOf("/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron")).toBe("Visual Studio Code - Insiders");
		expect(appNameOf("/usr/bin/foo --open /Applications/Other.app/Contents/x")).toBe("foo");
		expect(appNameOf("/usr/local/bin/node /home/me/app/server.js --password=hunter2")).toBe("node");
		expect(appNameOf("-zsh")).toBe("zsh");
		expect(appNameOf("[kworker/0:1H-events]")).toBe("kworker");
		expect(appNameOf("/usr/libexec/Some Daemon")).toBe("Some");
	});

	it("parses ps lines, sums per app, sorts and excludes ps itself", () => {
		expect(parsePsLine("  42     1   501  3.5  2048 /bin/zsh -l")).toEqual({ pid: 42, ppid: 1, uid: 501, cpu: 3.5, rss: 2048, args: "/bin/zsh -l" });
		expect(parsePsLine("nonsense")).toBeNull();
		const out = [
			"  11  1 501 10.0 1000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"  12 11 501 20.5 3000 /Applications/Google Chrome.app/Contents/Frameworks/X.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --secret=1",
			"  13  1 501  1.0 5000 /usr/bin/node /srv/run.js --token=abc",
			"  14 13 501  0.0  100 ps -Ao pid=,ppid=,uid=,pcpu=,rss=,args=",
		].join("\n");
		const apps = groupProcesses(out, { uid: 501, pid: 999 });
		expect(apps.map((a) => a.name).sort()).toEqual(["Google Chrome", "node"]);
		const chrome = apps.find((a) => a.name === "Google Chrome")!;
		expect(chrome).toMatchObject({ processes: 2, cpu: 30.5, memBytes: 4000 * 1024, pids: [12, 11], quittable: true, clamProcesses: 0 });
		expect(JSON.stringify(apps)).not.toMatch(/secret|token|abc/);
	});

	it("quits only the user's own processes: never this server or what started it, never a system app; counts what the server started", () => {
		// 1 launchd (root) → 100 Terminal → 101 zsh → 200 node (this server) → 300 omp (agent) ; 400 another user's node; 500 the user's node
		const out = [
			"    1    0   0 0.1  10 /sbin/launchd",
			"  100    1 501 0.1  10 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
			"  101  100 501 0.1  10 -zsh",
			"  200  101 501 5.0  10 /usr/local/bin/node /srv/clam/main.js",
			"  300  200 501 9.0  10 /Users/me/.bun/bin/omp --mode rpc",
			"  301  300 501 1.0  10 /Users/me/.bun/bin/omp --child",
			"  400    1  88 1.0  10 /usr/local/bin/node /other/user.js",
			"  500    1 501 1.0  10 /usr/local/bin/node /dev/server.js",
			"  600    1 501 1.0  10 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow",
		].join("\n");
		const owner = { uid: 501, pid: 200 };
		expect(quitPlan(out, "node", owner)).toEqual({ found: 3, targets: [500], denied: 1, guarded: 1 });
		expect(quitPlan(out, "zsh", owner)).toEqual({ found: 1, targets: [], denied: 0, guarded: 1 });
		expect(quitPlan(out, "Terminal", owner)).toMatchObject({ targets: [], guarded: 1 });
		expect(quitPlan(out, "launchd", owner)).toMatchObject({ targets: [], guarded: 1 });
		expect(quitPlan(out, "loginwindow", owner)).toMatchObject({ targets: [], denied: 1 });
		expect(quitPlan(out, "omp", owner)).toEqual({ found: 2, targets: [300, 301], denied: 0, guarded: 0 });
		expect(quitPlan(out, "nothing", owner).found).toBe(0);
		// root may signal anyone's processes, still never itself or its parents
		expect(quitPlan(out, "node", { uid: 0, pid: 200 }).targets.sort()).toEqual([400, 500]);

		const apps = groupProcesses(out, owner);
		const byName = (n: string) => apps.find((a) => a.name === n)!;
		expect(byName("node")).toMatchObject({ quittable: true, clamProcesses: 0 });
		expect(byName("omp")).toMatchObject({ quittable: true, clamProcesses: 2 });
		expect(byName("zsh").quittable).toBe(false);
		expect(byName("loginwindow").quittable).toBe(false);
		expect(byName("launchd").quittable).toBe(false);
	});
});

describe("alerts", () => {
	const base = { memoryPercent: 40, pressure: null, cpuAverage: 10, disks: [{ path: "/", total: 500 * GB, used: 200 * GB, free: 300 * GB, percent: 40 }] } as const;
	const alerts = (over: Partial<Parameters<typeof computeAlerts>[0]>) => computeAlerts({ ...base, disks: [...base.disks], ...over });

	it("is quiet on a healthy machine", () => {
		expect(alerts({})).toEqual([]);
	});

	it("memory: 90 % or pressure warning → warning; 95 % or pressure critical → critical", () => {
		expect(alerts({ memoryPercent: 90 })[0]).toMatchObject({ kind: "memory", level: "warning" });
		expect(alerts({ memoryPercent: 50, pressure: "warning" })[0]).toMatchObject({ kind: "memory", level: "warning" });
		expect(alerts({ memoryPercent: 95 })[0]).toMatchObject({ kind: "memory", level: "critical", i18n: { key: "Memory is almost out · {percent}%", params: { percent: 95 } } });
		expect(alerts({ memoryPercent: 50, pressure: "critical" })[0]).toMatchObject({ level: "critical" });
	});

	it("cpu: uses the average, needs enough samples", () => {
		expect(alerts({ cpuAverage: 85 })[0]).toMatchObject({ kind: "cpu", level: "warning" });
		expect(alerts({ cpuAverage: 95 })[0]).toMatchObject({ kind: "cpu", level: "critical" });
		expect(alerts({ cpuAverage: 84 })).toEqual([]);
		expect(alerts({ cpuAverage: null })).toEqual([]);
	});

	it("disk: free < 10 % or 10 GB → warning; < 5 % or 3 GB → critical; worst first", () => {
		const disk = (total: number, free: number) => ({ path: "/", total, used: total - free, free, percent: ((total - free) / total) * 100 });
		expect(alerts({ disks: [disk(500 * GB, 49 * GB)] })[0]).toMatchObject({ kind: "disk", level: "warning" });
		expect(alerts({ disks: [disk(100 * GB, 9 * GB)] })[0]).toMatchObject({ kind: "disk", level: "warning" });
		expect(alerts({ disks: [disk(500 * GB, 24 * GB)] })[0]).toMatchObject({ level: "critical" });
		expect(alerts({ disks: [disk(100 * GB, 2.5 * GB)] })[0]).toMatchObject({ level: "critical" });
		expect(alerts({ disks: [disk(500 * GB, 200 * GB)] })).toEqual([]);
		const both = alerts({ memoryPercent: 91, disks: [disk(500 * GB, 10 * GB)].map((d) => ({ ...d, free: 2 * GB })) });
		expect(both.map((a) => a.kind)).toEqual(["disk", "memory"]);
	});
});

describe("GET /api/local/system", () => {
	let harness: TestHarness;
	afterEach(async () => harness.cleanup());

	it("answers sane numbers for this machine", async () => {
		harness = await createTestHarness({ plugins: [systemRoutes] });
		const res = await harness.app.inject({ method: "GET", url: "/api/local/system", headers: { host: "localhost" } });
		expect(res.statusCode).toBe(200);
		const s = res.json() as SystemStatus;
		expect(s.cpu.percent).toBeGreaterThanOrEqual(0);
		expect(s.cpu.percent).toBeLessThanOrEqual(100);
		expect(s.cpu.cores).toBeGreaterThan(0);
		expect(s.cpu.load).toHaveLength(3);
		expect(s.memory.total).toBeGreaterThan(0);
		expect(s.memory.used).toBeGreaterThan(0);
		expect(s.memory.used).toBeLessThanOrEqual(s.memory.total);
		expect(s.memory.percent).toBeGreaterThan(0);
		expect(s.disks.length).toBeGreaterThan(0);
		expect(s.disks[0]!.free).toBeGreaterThan(0);
		expect(s.uptimeSec).toBeGreaterThan(0);

		const procs = (await harness.app.inject({ method: "GET", url: "/api/local/system/processes", headers: { host: "localhost" } })).json() as SystemProcesses;
		if (procs.supported) {
			expect(procs.byMemory.length).toBeGreaterThan(0);
			expect(procs.byMemory.length).toBeLessThanOrEqual(12);
		}
		const cached = await harness.app.inject({ method: "GET", url: "/api/local/system/disk-usage", headers: { host: "localhost" } });
		expect(cached.statusCode).toBe(404);
	});

	it("quits an app by its listed name: its process ends, an unknown name is 404", async () => {
		if (process.platform !== "darwin" && process.platform !== "linux") return;
		harness = await createTestHarness({ plugins: [systemRoutes] });
		// `sleep` under a name no other process has (a link: macOS kills a copied system binary), so nothing else on the machine is touched.
		const dir = mkdtempSync(path.join(tmpdir(), "clam-quit-"));
		const name = `clam-quit-test-${process.pid}`;
		symlinkSync("/bin/sleep", path.join(dir, name));
		const child = spawn(path.join(dir, name), ["300"], { stdio: "ignore" });
		const exited = Promise.withResolvers<NodeJS.Signals | null>();
		child.once("exit", (_code, signal) => exited.resolve(signal));
		try {
			const quit = await harness.app.inject({ method: "POST", url: "/api/local/system/processes/quit", headers: { host: "localhost" }, payload: { name } });
			expect(quit.statusCode, quit.body).toBe(200);
			expect(quit.json() as QuitAppResult).toEqual({ name, stopped: 1, running: 0, denied: 0, guarded: 0 });
			expect(await exited.promise).toBe("SIGTERM");

			const missing = await harness.app.inject({ method: "POST", url: "/api/local/system/processes/quit", headers: { host: "localhost" }, payload: { name } });
			expect(missing.statusCode).toBe(404);
		} finally {
			child.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
