import { z } from "zod";
import { I18nText, IsoDate } from "./common.ts";

/** Live load of the machine this node runs on (the host), polled by the sidebar card and the System page. */

export const SystemAlertKind = z.enum(["cpu", "memory", "disk"]);
export type SystemAlertKind = z.infer<typeof SystemAlertKind>;
export const SystemAlertLevel = z.enum(["warning", "critical"]);
export type SystemAlertLevel = z.infer<typeof SystemAlertLevel>;

export const SystemAlert = z.object({
	kind: SystemAlertKind,
	level: SystemAlertLevel,
	/** Short headline, e.g. "Memory is almost full · 94%". */
	message: z.string(),
	i18n: I18nText.optional(),
	/** Percent of the resource in use (memory/CPU) or of the volume used (disk). */
	percent: z.number(),
});
export type SystemAlert = z.infer<typeof SystemAlert>;

export const SystemCpu = z.object({
	/** 0–100, all cores, over the last sampling window. */
	percent: z.number(),
	cores: z.number().int(),
	model: z.string(),
	/** 1, 5 and 15 minute load averages. */
	load: z.tuple([z.number(), z.number(), z.number()]),
	/** The last ~60 s of `percent` samples, oldest first (sparkline). */
	history: z.array(z.number()),
});
export type SystemCpu = z.infer<typeof SystemCpu>;

export const SystemMemoryPressure = z.enum(["normal", "warning", "critical"]);
export type SystemMemoryPressure = z.infer<typeof SystemMemoryPressure>;

export const SystemMemory = z.object({
	/** Bytes. */
	total: z.number(),
	used: z.number(),
	available: z.number(),
	percent: z.number(),
	swapUsed: z.number(),
	swapTotal: z.number(),
	/** macOS memory pressure; null where the OS does not report one. */
	pressure: SystemMemoryPressure.nullable(),
});
export type SystemMemory = z.infer<typeof SystemMemory>;

export const SystemDisk = z.object({
	path: z.string(),
	/** Bytes. */
	total: z.number(),
	used: z.number(),
	free: z.number(),
	percent: z.number(),
});
export type SystemDisk = z.infer<typeof SystemDisk>;

/** The machine's battery (laptops). */
export const SystemBattery = z.object({
	/** Charge, 0–100. */
	percent: z.number(),
	charging: z.boolean(),
	/** On AC power: charging, full, or held below full by the OS. */
	pluggedIn: z.boolean(),
	/** Minutes to empty while discharging, to full while charging; null when the OS has no estimate yet. */
	minutesRemaining: z.number().nullable(),
});
export type SystemBattery = z.infer<typeof SystemBattery>;

export const SystemStatus = z.object({
	cpu: SystemCpu,
	memory: SystemMemory,
	disks: z.array(SystemDisk),
	/** Null on a machine without a battery, or where it cannot be read. */
	battery: SystemBattery.nullable(),
	uptimeSec: z.number(),
	platform: z.string(),
	hostname: z.string(),
	alerts: z.array(SystemAlert),
	sampledAt: IsoDate,
});
export type SystemStatus = z.infer<typeof SystemStatus>;

/** One application (processes grouped by display name). Never carries command-line arguments. */
export const AppUsage = z.object({
	name: z.string(),
	processes: z.number().int(),
	/** Percent of ONE core, summed over the processes (can exceed 100). */
	cpu: z.number(),
	/** Resident bytes, summed over the processes. */
	memBytes: z.number(),
	/** At most 5 process ids. */
	pids: z.array(z.number().int()).optional(),
});
export type AppUsage = z.infer<typeof AppUsage>;

export const SystemProcesses = z.object({
	supported: z.boolean(),
	byCpu: z.array(AppUsage),
	byMemory: z.array(AppUsage),
	sampledAt: IsoDate,
});
export type SystemProcesses = z.infer<typeof SystemProcesses>;

export const DiskUsageEntry = z.object({ name: z.string(), bytes: z.number() });
export type DiskUsageEntry = z.infer<typeof DiskUsageEntry>;

/** The largest top-level folders of the user's home folder. */
export const DiskUsageReport = z.object({
	root: z.string(),
	entries: z.array(DiskUsageEntry),
	scannedAt: IsoDate,
	/** The scan hit its time limit: the list may miss folders or under-count them. */
	partial: z.boolean(),
});
export type DiskUsageReport = z.infer<typeof DiskUsageReport>;
