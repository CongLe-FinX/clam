import { execFile, spawn } from "node:child_process";
import { lstat, readdir, readFile, statfs } from "node:fs/promises";
import { cpus, freemem, homedir, hostname, loadavg, platform, totalmem, uptime } from "node:os";
import path from "node:path";
import { type DiskUsageReport, type SystemBattery, type SystemDisk, type SystemMemory, type SystemProcesses, type SystemStatus, i18nMsg } from "@clam/contracts";
import { ApiError } from "../http/errors.ts";
import {
	type CpuTimes,
	batteryFromSysfs,
	computeAlerts,
	cpuPercent,
	diskFromStatfs,
	groupProcesses,
	parseMeminfo,
	parsePmsetBatt,
	parsePressureLevel,
	parseSwapUsage,
	parseVmStat,
	sumCpuTimes,
	topApps,
} from "./system-metrics.ts";

const SAMPLE_MS = 3_000;
/** ~60 s of samples for the sparkline. */
const HISTORY = 20;
/** ~30 s of samples averaged for the CPU alert, and the least needed before one can fire. */
const ALERT_WINDOW = 10;
const ALERT_MIN_SAMPLES = 3;
const STATUS_TTL_MS = 2_000;
const BATTERY_TTL_MS = 10_000;
const POWER_SUPPLY = "/sys/class/power_supply";
const PROCESSES_TTL_MS = 3_000;
const COMMAND_TIMEOUT_MS = 2_500;
const DISK_SCAN_TIMEOUT_MS = 60_000;
const DISK_CACHE_MS = 10 * 60_000;
const DISK_TOP = 15;

function run(file: string, args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout)));
	return promise;
}

/** Memoizes an async producer for `ttl` ms; concurrent callers share one in-flight run. */
function cached<T>(ttl: number, produce: () => Promise<T>): () => Promise<T> {
	let value: { at: number; promise: Promise<T> } | null = null;
	return () => {
		const now = Date.now();
		if (!value || now - value.at >= ttl) {
			const promise = produce();
			value = { at: now, promise };
			promise.catch(() => {
				if (value?.promise === promise) value = null;
			});
		}
		return value.promise;
	};
}

/** Host CPU / memory / disk readings, top apps and the home-folder scan. One instance per server. */
export class SystemMonitor {
	private readonly home = homedir();
	private samples: number[] = [];
	private last: CpuTimes = sumCpuTimes(cpus());
	private timer: NodeJS.Timeout | null = null;
	private diskReport: { at: number; report: DiskUsageReport } | null = null;
	private diskScan: Promise<DiskUsageReport> | null = null;

	constructor(private readonly dataDir: string) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.sample(), SAMPLE_MS);
		this.timer.unref();
	}

	stop(): void {
		clearInterval(this.timer ?? undefined);
		this.timer = null;
	}

	private sample(): void {
		const cur = sumCpuTimes(cpus());
		this.samples.push(cpuPercent(this.last, cur));
		this.last = cur;
		if (this.samples.length > HISTORY) this.samples.shift();
	}

	private cpuSnapshot(): SystemStatus["cpu"] {
		const list = cpus();
		if (this.samples.length === 0) {
			// Nothing sampled yet (just started): average since boot is better than a made-up zero.
			this.samples.push(cpuPercent({ idle: 0, total: 0 }, sumCpuTimes(list)));
		}
		const [l1 = 0, l5 = 0, l15 = 0] = loadavg();
		return {
			percent: round1(this.samples[this.samples.length - 1] ?? 0),
			cores: list.length,
			model: list[0]?.model.trim() ?? "",
			load: [round2(l1), round2(l5), round2(l15)],
			history: this.samples.map(round1),
		};
	}

	private cpuAverage(): number | null {
		const recent = this.samples.slice(-ALERT_WINDOW);
		return recent.length < ALERT_MIN_SAMPLES ? null : recent.reduce((a, b) => a + b, 0) / recent.length;
	}

	private readonly memory = cached(STATUS_TTL_MS, async (): Promise<SystemMemory> => {
		const total = totalmem();
		const os = platform();
		if (os === "darwin") {
			const [vm, swap, level] = await Promise.all([run("vm_stat", []), run("sysctl", ["-n", "vm.swapusage"]), run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])]);
			const reading = (vm ? parseVmStat(vm, total) : null) ?? { total, used: total - freemem(), available: freemem() };
			const swapUsage = swap ? parseSwapUsage(swap) : null;
			return build(reading, swapUsage?.used ?? 0, swapUsage?.total ?? 0, level ? parsePressureLevel(level) : null);
		}
		if (os === "linux") {
			const info = await readFile("/proc/meminfo", "utf8").then(parseMeminfo, () => null);
			if (info) return build(info, info.swapUsed, info.swapTotal, null);
		}
		return build({ total, used: total - freemem(), available: freemem() }, 0, 0, null);
	});

	private readonly disks = cached(STATUS_TTL_MS, async (): Promise<SystemDisk[]> => {
		const out: SystemDisk[] = [];
		const seen = new Set<string>();
		for (const dir of [this.home, this.dataDir]) {
			try {
				const s = await statfs(dir);
				const identity = `${s.blocks}:${s.bsize}`;
				if (s.blocks <= 0 || seen.has(identity)) continue;
				seen.add(identity);
				out.push(diskFromStatfs(dir, s));
			} catch {
				// A volume that cannot be read is simply not listed.
			}
		}
		return out;
	});

	/** The battery changes slowly: one `pmset` (or sysfs read) every 10 s at most, whatever the polling rate of the UI. */
	private readonly battery = cached(BATTERY_TTL_MS, async (): Promise<SystemBattery | null> => {
		const os = platform();
		if (os === "darwin") {
			const out = await run("pmset", ["-g", "batt"]);
			return out ? parsePmsetBatt(out) : null;
		}
		if (os === "linux") return linuxBattery();
		return null;
	});

	async status(): Promise<SystemStatus> {
		const [memory, disks, battery] = await Promise.all([this.memory(), this.disks(), this.battery().catch(() => null)]);
		return {
			cpu: this.cpuSnapshot(),
			memory,
			disks,
			battery,
			uptimeSec: Math.round(uptime()),
			platform: platform(),
			hostname: hostname(),
			alerts: computeAlerts({ memoryPercent: memory.percent, pressure: memory.pressure, cpuAverage: this.cpuAverage(), disks }),
			sampledAt: new Date().toISOString(),
		};
	}

	private readonly apps = cached(PROCESSES_TTL_MS, async (): Promise<SystemProcesses> => {
		const sampledAt = new Date().toISOString();
		const os = platform();
		if (os !== "darwin" && os !== "linux") return { supported: false, byCpu: [], byMemory: [], sampledAt };
		const output = await run("ps", ["-Ao", "pid=,pcpu=,rss=,args="], 8_000);
		if (output === null) return { supported: false, byCpu: [], byMemory: [], sampledAt };
		return { supported: true, ...topApps(groupProcesses(output)), sampledAt };
	});

	processes(): Promise<SystemProcesses> {
		return this.apps();
	}

	/** The cached home-folder report (≤10 min old), or null. */
	cachedDiskUsage(): DiskUsageReport | null {
		return this.diskReport && Date.now() - this.diskReport.at < DISK_CACHE_MS ? this.diskReport.report : null;
	}

	/** Scan the largest top-level entries of the user's home. Concurrent calls share one scan; a fresh scan always re-measures. */
	scanDiskUsage(): Promise<DiskUsageReport> {
		if (platform() === "win32") throw ApiError.unavailable(i18nMsg("Folder sizes cannot be measured on this platform"));
		this.diskScan ??= this.measureHome().finally(() => {
			this.diskScan = null;
		});
		return this.diskScan;
	}

	private async measureHome(): Promise<DiskUsageReport> {
		const { sizes, partial } = await duDepthOne(this.home);
		const sorted = [...sizes].sort((a, b) => b.bytes - a.bytes).slice(0, DISK_TOP * 2);
		const entries: DiskUsageReport["entries"] = [];
		for (const e of sorted) {
			const info = await lstat(path.join(this.home, e.name)).catch(() => null);
			if (info?.isDirectory() && !info.isSymbolicLink()) entries.push(e);
			if (entries.length === DISK_TOP) break;
		}
		const report: DiskUsageReport = { root: this.home, entries, scannedAt: new Date().toISOString(), partial };
		this.diskReport = { at: Date.now(), report };
		return report;
	}
}

function build(reading: { total: number; used: number; available: number }, swapUsed: number, swapTotal: number, pressure: SystemMemory["pressure"]): SystemMemory {
	return { ...reading, percent: round1(reading.total > 0 ? (reading.used / reading.total) * 100 : 0), swapUsed, swapTotal, pressure };
}

/** The first battery under `/sys/class/power_supply`, with the AC adapter's `online` when there is one. */
async function linuxBattery(): Promise<SystemBattery | null> {
	const names = await readdir(POWER_SUPPLY).catch(() => [] as string[]);
	const read = (name: string, file: string) => readFile(path.join(POWER_SUPPLY, name, file), "utf8").catch(() => null);
	let battery: SystemBattery | null = null;
	let acOnline: boolean | null = null;
	for (const name of names) {
		const type = (await read(name, "type"))?.trim();
		if (type === "Mains" || type === "USB") {
			const online = (await read(name, "online"))?.trim();
			if (online !== undefined) acOnline = (acOnline ?? false) || online === "1";
		} else if (type === "Battery" && !battery) {
			const [capacity, status] = await Promise.all([read(name, "capacity"), read(name, "status")]);
			if (capacity !== null) battery = batteryFromSysfs(capacity, status ?? "", null);
		}
	}
	return battery && acOnline !== null ? { ...battery, pluggedIn: acOnline } : battery;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** `du -a -k -x -d 1 <home>`: size of every direct child, streamed so a timeout keeps what finished. */
function duDepthOne(root: string): Promise<{ sizes: Array<{ name: string; bytes: number }>; partial: boolean }> {
	const { promise, resolve } = Promise.withResolvers<{ sizes: Array<{ name: string; bytes: number }>; partial: boolean }>();
	const child = spawn("du", ["-a", "-k", "-x", "-d", "1", root], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	let buffer = "";
	let partial = false;
	const timer = setTimeout(() => {
		partial = true;
		child.kill("SIGKILL");
	}, DISK_SCAN_TIMEOUT_MS);
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => (buffer += chunk));
	const done = (): void => {
		clearTimeout(timer);
		const sizes: Array<{ name: string; bytes: number }> = [];
		for (const line of buffer.split("\n")) {
			const m = /^(\d+)\s+(.+)$/.exec(line);
			if (!m) continue;
			const full = m[2]!;
			if (path.resolve(full) === path.resolve(root)) continue;
			sizes.push({ name: path.basename(full), bytes: Number(m[1]) * 1024 });
		}
		resolve({ sizes, partial });
	};
	child.on("error", () => {
		partial = true;
		done();
	});
	child.on("close", done);
	return promise;
}
