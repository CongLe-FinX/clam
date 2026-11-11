import { type AppUsage, type I18nMessage, type SystemAlert, type SystemBattery, type SystemDisk, type SystemMemoryPressure, i18nMsg } from "@clam/contracts";

/** Pure parsers and thresholds behind the System page; the OS-touching sampler is `system-monitor.ts`. */

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** Memory/CPU/disk thresholds. */
export const THRESHOLDS = {
	memory: { warning: 90, critical: 95 },
	cpu: { warning: 85, critical: 95 },
	/** Free space of a volume: warning below 10 % or 10 GB, critical below 5 % or 3 GB. */
	disk: { warningPercent: 10, warningBytes: 10 * GB, criticalPercent: 5, criticalBytes: 3 * GB },
} as const;

export interface CpuTimes {
	idle: number;
	total: number;
}

/** Sum of `os.cpus()` times over all cores. */
export function sumCpuTimes(cpus: ReadonlyArray<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>): CpuTimes {
	let idle = 0;
	let total = 0;
	for (const { times } of cpus) {
		idle += times.idle;
		total += times.user + times.nice + times.sys + times.idle + times.irq;
	}
	return { idle, total };
}

/** Busy percent (0–100) between two snapshots; 0 when no time passed. */
export function cpuPercent(prev: CpuTimes, cur: CpuTimes): number {
	const total = cur.total - prev.total;
	if (total <= 0) return 0;
	const idle = cur.idle - prev.idle;
	return Math.min(100, Math.max(0, (1 - idle / total) * 100));
}

export interface MemoryReading {
	total: number;
	used: number;
	available: number;
}

/** `vm_stat` (macOS): used = active + wired + occupied by the compressor; available = total − used. */
export function parseVmStat(output: string, totalBytes: number): MemoryReading | null {
	const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
	if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
	const pages = (label: string): number => Number(new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(output)?.[1] ?? Number.NaN);
	const active = pages("Pages active");
	const wired = pages("Pages wired down");
	const compressed = pages("Pages occupied by compressor");
	if (!Number.isFinite(active) || !Number.isFinite(wired)) return null;
	const used = Math.min(totalBytes, (active + wired + (Number.isFinite(compressed) ? compressed : 0)) * pageSize);
	return { total: totalBytes, used, available: totalBytes - used };
}

const SWAP_UNIT: Record<string, number> = { K: 1024, M: MB, G: GB, T: 1024 * GB };

/** `sysctl -n vm.swapusage` → `total = 2048.00M  used = 1051.25M  free = 996.75M  (encrypted)`. */
export function parseSwapUsage(output: string): { total: number; used: number } | null {
	const read = (label: string): number | null => {
		const m = new RegExp(`${label}\\s*=\\s*([\\d.]+)\\s*([KMGT])`, "i").exec(output);
		return m ? Number(m[1]) * (SWAP_UNIT[m[2]!.toUpperCase()] ?? 1) : null;
	};
	const total = read("total");
	const used = read("used");
	return total === null || used === null ? null : { total, used };
}

/** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. */
export function parsePressureLevel(output: string): SystemMemoryPressure | null {
	switch (output.trim()) {
		case "1":
			return "normal";
		case "2":
			return "warning";
		case "4":
			return "critical";
		default:
			return null;
	}
}

/** `/proc/meminfo` (Linux): MemAvailable and swap. */
export function parseMeminfo(text: string): (MemoryReading & { swapTotal: number; swapUsed: number }) | null {
	const kb = (key: string): number | null => {
		const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
		return m ? Number(m[1]) * 1024 : null;
	};
	const total = kb("MemTotal");
	const available = kb("MemAvailable");
	if (total === null || available === null) return null;
	const swapTotal = kb("SwapTotal") ?? 0;
	const swapFree = kb("SwapFree") ?? 0;
	return { total, available, used: Math.max(0, total - available), swapTotal, swapUsed: Math.max(0, swapTotal - swapFree) };
}

/**
 * `pmset -g batt` (macOS):
 *   Now drawing from 'AC Power'
 *    -InternalBattery-0 (id=6357091)	4%; charging; 20:00 remaining present: true
 * States are `charging`, `finishing charge`, `discharging`, `charged`, `AC attached` (held below full); the estimate may read
 * `(no estimate)`. Null without an internal battery (desktop Macs) or when it is not present.
 */
export function parsePmsetBatt(output: string): SystemBattery | null {
	const m = /-InternalBattery-\d+[^\n]*?\s(\d{1,3})%;\s*([^;\n]+);([^\n]*)/.exec(output);
	if (!m || /present:\s*false/i.test(m[0])) return null;
	const state = m[2]!.trim().toLowerCase();
	const charging = state === "charging" || state === "finishing charge";
	const time = /(\d+):(\d{2})\s+remaining/.exec(m[3]!);
	const minutes = time ? Number(time[1]) * 60 + Number(time[2]) : 0;
	return {
		percent: Math.min(100, Number(m[1])),
		charging,
		pluggedIn: /'AC Power'/.test(output) || charging || state === "charged" || state === "ac attached",
		// `0:00 remaining` is what pmset prints when there is nothing to estimate (full, or held on AC).
		minutesRemaining: minutes > 0 ? minutes : null,
	};
}

/** A battery of `/sys/class/power_supply` (Linux): `capacity` (0–100) and `status` (Charging, Discharging, Full, Not charging). */
export function batteryFromSysfs(capacity: string, status: string, acOnline: boolean | null): SystemBattery | null {
	const percent = Number.parseInt(capacity.trim(), 10);
	if (!Number.isFinite(percent)) return null;
	const s = status.trim().toLowerCase();
	const charging = s === "charging";
	return { percent: Math.max(0, Math.min(100, percent)), charging, pluggedIn: acOnline ?? (charging || s === "full" || s === "not charging"), minutesRemaining: null };
}

/** Space figures of a volume from `fs.statfs` (blocks of `bsize`; `bavail` is what a non-root user can still use). */
export function diskFromStatfs(path: string, s: { blocks: number; bsize: number; bfree: number; bavail: number }): SystemDisk {
	const total = s.blocks * s.bsize;
	const free = s.bavail * s.bsize;
	const used = Math.max(0, (s.blocks - s.bfree) * s.bsize);
	// Like `df`: percent of what a user can occupy (used + available), so a full volume reads 100 %.
	const usable = used + free;
	return { path, total, used, free, percent: usable > 0 ? Math.min(100, (used / usable) * 100) : 0 };
}

// ─── processes ────────────────────────────────────────────────────────────────────────────

/** A bundle directory (`X.app`, `X.xpc`, `X.appex`) at the start of an absolute path; the option guard keeps `/bin/foo --arg /Applications/Y.app` from matching. */
const BUNDLE = /^(\/.*?)\.(?:app|xpc|appex)(?=\/|$)/;
const OPTION_IN_PREFIX = /\s--?[A-Za-z]/;

/**
 * A display name from a process's command line, WITHOUT leaking arguments (they can hold secrets). macOS: the
 * outermost `X.app` bundle name (Chrome's helpers fold into "Google Chrome"); otherwise the basename of the
 * executable, taken as the first whitespace-separated token (a path with spaces that is not inside a bundle is cut at
 * its first space: the two cases cannot be told apart without touching the disk).
 */
export function appNameOf(args: string): string {
	const text = args.trim();
	const bundle = BUNDLE.exec(text);
	if (bundle && !OPTION_IN_PREFIX.test(bundle[1]!)) {
		const name = bundle[1]!.slice(bundle[1]!.lastIndexOf("/") + 1);
		if (name) return name;
	}
	if (text.startsWith("[")) {
		// Linux kernel thread: "[kworker/0:1H-events]" → "kworker".
		return /^\[([^\]/:\-\s]+)/.exec(text)?.[1] ?? "kernel";
	}
	const exe = text.split(/\s+/, 1)[0] ?? "";
	const base = exe.slice(exe.lastIndexOf("/") + 1).replace(/^-+/, "").replace(/:$/, "");
	return base || "unknown";
}

export interface PsRow {
	pid: number;
	cpu: number;
	/** KiB. */
	rss: number;
	args: string;
}

const PS_LINE = /^\s*(\d+)\s+([\d.,]+)\s+(\d+)\s+(.*)$/;

/** One line of `ps -Ao pid=,pcpu=,rss=,args=`. */
export function parsePsLine(line: string): PsRow | null {
	const m = PS_LINE.exec(line);
	if (!m) return null;
	const cpu = Number(m[2]!.replace(",", "."));
	return Number.isFinite(cpu) ? { pid: Number(m[1]), cpu, rss: Number(m[3]), args: m[4]!.trim() } : null;
}

/** The sampling `ps` itself is not an app the user runs. */
export const isSamplingPs = (args: string): boolean => /^(?:\S*\/)?ps\s/.test(args) && args.includes("pid=,pcpu=,rss=,args=");

export const TOP_APPS = 12;
const MAX_PIDS = 5;

/** Group `ps` output by app name: cpu and memory summed, the heaviest processes' ids kept. */
export function groupProcesses(output: string): AppUsage[] {
	const rows = output
		.split("\n")
		.map(parsePsLine)
		.filter((r): r is PsRow => r !== null && !isSamplingPs(r.args))
		.sort((a, b) => b.rss - a.rss);
	const groups = new Map<string, { processes: number; cpu: number; rss: number; pids: number[] }>();
	for (const r of rows) {
		const name = appNameOf(r.args);
		const g = groups.get(name) ?? { processes: 0, cpu: 0, rss: 0, pids: [] };
		g.processes++;
		g.cpu += r.cpu;
		g.rss += r.rss;
		if (g.pids.length < MAX_PIDS) g.pids.push(r.pid);
		groups.set(name, g);
	}
	return [...groups].map(([name, g]) => ({ name, processes: g.processes, cpu: Math.round(g.cpu * 10) / 10, memBytes: g.rss * 1024, pids: g.pids }));
}

export function topApps(apps: AppUsage[]): { byCpu: AppUsage[]; byMemory: AppUsage[] } {
	return {
		byCpu: [...apps].sort((a, b) => b.cpu - a.cpu || b.memBytes - a.memBytes).slice(0, TOP_APPS),
		byMemory: [...apps].sort((a, b) => b.memBytes - a.memBytes).slice(0, TOP_APPS),
	};
}

// ─── alerts ───────────────────────────────────────────────────────────────────────────────

const gbText = (bytes: number): string => `${(bytes / GB).toFixed(bytes >= 100 * GB ? 0 : 1)} GB`;

export function diskLevel(d: Pick<SystemDisk, "total" | "free">): "warning" | "critical" | null {
	if (d.total <= 0) return null;
	const t = THRESHOLDS.disk;
	const freePercent = (d.free / d.total) * 100;
	if (freePercent < t.criticalPercent || d.free < t.criticalBytes) return "critical";
	if (freePercent < t.warningPercent || d.free < t.warningBytes) return "warning";
	return null;
}

export interface AlertInput {
	memoryPercent: number;
	pressure: SystemMemoryPressure | null;
	/** Mean CPU percent over the last ~30 s; null while too few samples exist. */
	cpuAverage: number | null;
	disks: SystemDisk[];
}

function alertOf(kind: SystemAlert["kind"], level: SystemAlert["level"], percent: number, m: I18nMessage): SystemAlert {
	return { kind, level, percent, message: m.text, ...(m.i18n && { i18n: m.i18n }) };
}

/** Active alerts, worst first. CPU alerts use the 30 s average so a single spike never raises one. */
export function computeAlerts(input: AlertInput): SystemAlert[] {
	const alerts: SystemAlert[] = [];

	const mem = input.memoryPercent;
	const memLevel = mem >= THRESHOLDS.memory.critical || input.pressure === "critical" ? "critical" : mem >= THRESHOLDS.memory.warning || input.pressure === "warning" ? "warning" : null;
	if (memLevel) {
		const percent = Math.round(mem);
		alerts.push(alertOf("memory", memLevel, percent, memLevel === "critical" ? i18nMsg("Memory is almost out · {percent}%", { percent }) : i18nMsg("Memory is running low · {percent}%", { percent })));
	}

	const cpu = input.cpuAverage;
	if (cpu !== null && cpu >= THRESHOLDS.cpu.warning) {
		const percent = Math.round(cpu);
		const level = cpu >= THRESHOLDS.cpu.critical ? "critical" : "warning";
		alerts.push(alertOf("cpu", level, percent, level === "critical" ? i18nMsg("CPU is maxed out · {percent}%", { percent }) : i18nMsg("CPU is under heavy load · {percent}%", { percent })));
	}

	let worst: { disk: SystemDisk; level: "warning" | "critical" } | null = null;
	for (const disk of input.disks) {
		const level = diskLevel(disk);
		if (!level) continue;
		if (!worst || (level === "critical" && worst.level === "warning") || (level === worst.level && disk.free < worst.disk.free)) worst = { disk, level };
	}
	if (worst) {
		const free = gbText(worst.disk.free);
		alerts.push(
			alertOf(
				"disk",
				worst.level,
				Math.round(worst.disk.percent),
				worst.level === "critical" ? i18nMsg("Disk is almost full · {free} free", { free }) : i18nMsg("Disk is getting full · {free} free", { free }),
			),
		);
	}

	return alerts.sort((a, b) => Number(b.level === "critical") - Number(a.level === "critical"));
}
