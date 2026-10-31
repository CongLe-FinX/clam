import { type ExecFileException, execFile } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, posix, win32 } from "node:path";
import type { ServerConfig } from "../context.ts";
import {
	type AutostartSpec,
	MAC_LABEL,
	SYSTEMD_UNIT,
	WINDOWS_TASK_NAME,
	buildLaunchAgentPlist,
	buildSystemdUnit,
	buildWindowsTaskXml,
	buildWindowsWrapper,
	readPlistEntry,
	readPlistString,
	readUnitEntry,
	readUnitEnvironment,
	xmlEscape,
} from "./autostart-templates.ts";

/**
 * Start-at-login (FR-01), done with each OS's own mechanism. Enabling writes the login entry only: it never
 * starts a second server now (it takes effect at the next login) and never touches anything outside its own
 * entry. `status()` reports what is really installed, not what was last requested.
 */

export interface AutostartStatus {
	/** True only when an OS login entry for THIS node exists (and, on Linux, is enabled). */
	enabled: boolean;
	/** Where the entry lives and when it takes effect, or why autostart is off. */
	detail: string;
}

export interface AutostartManager {
	status(): Promise<AutostartStatus>;
	/** Install (or refresh) the login entry. Throws `AutostartError`. */
	enable(): Promise<AutostartStatus>;
	/** Remove the login entry; idempotent. Throws `AutostartError` only if removal itself fails. */
	disable(): Promise<AutostartStatus>;
}

export type AutostartErrorCode =
	/** `apps/server/dist/main.js` does not exist: nothing runnable to start at login. */
	| "not_built"
	/** This OS has no supported login mechanism, or its service manager is unavailable. */
	| "unsupported"
	/** The OS refused or a command failed. */
	| "failed";

export class AutostartError extends Error {
	constructor(
		readonly code: AutostartErrorCode,
		message: string,
	) {
		super(message);
		this.name = "AutostartError";
	}
}

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}
export type RunCommand = (command: string, args: string[]) => Promise<CommandResult>;

/** Exit status of a finished `execFile`: numeric when the process ran and failed, 127 when it could not be started. */
function exitCodeOf(error: ExecFileException | null): number {
	if (!error) return 0;
	return typeof error.code === "number" ? error.code : 127;
}

export const runCommand: RunCommand = (command, args) =>
	new Promise((resolve) => {
		execFile(command, args, { timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({ code: exitCodeOf(error), stdout: String(stdout), stderr: String(stderr) || (error ? error.message : "") });
		});
	});

export interface AutostartOptions {
	/** Node data dir / host / port of the running node (read at call time: the port is only known after listen). */
	config: Pick<ServerConfig, "dataDir" | "host" | "port" | "ompBinary">;
	/** Absolute path of the built server entry. */
	entry: string;
	ompBinary: () => string | null;
	/** Extra `CLAM_*` variables worth carrying over (CLAM_OMP_PROFILE, CLAM_LOG_LEVEL, ...). */
	extraEnv?: Record<string, string>;
	platform?: NodeJS.Platform;
	home?: string;
	nodeExecutable?: string;
	/** PATH of the running server; the login entry's PATH is this plus the node and omp directories. */
	pathEnv?: string;
	run?: RunCommand;
}

const SYSTEM_PATHS = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** PATH for a login-started server: launchd/systemd hand it a minimal one, but omp (and bun/node for its shebang) must resolve. */
export function buildLoginPath(input: { ompBinary: string | null; nodeExecutable: string; pathEnv: string; platform: NodeJS.Platform }): string {
	const sep = input.platform === "win32" ? ";" : delimiter;
	const parentDir = (path: string) => (input.platform === "win32" ? win32 : posix).dirname(path);
	const parts = [
		...(input.ompBinary ? [parentDir(input.ompBinary)] : []),
		parentDir(input.nodeExecutable),
		...input.pathEnv.split(sep),
		...(input.platform === "win32" ? [] : SYSTEM_PATHS),
	];
	return [...new Set(parts.map((p) => p.trim()).filter((p) => p.length > 0))].join(sep);
}

/**
 * A login entry should not pin a version-specific install path (`/opt/homebrew/Cellar/node/25.8.0/bin/node` vanishes on the
 * next `brew upgrade`). Prefer the first `node` on PATH that resolves to the very binary running this server.
 */
export function stableNodeExecutable(execPath: string, pathEnv: string, platform: NodeJS.Platform): string {
	const names = platform === "win32" ? ["node.exe"] : ["node"];
	const real = (path: string): string | null => {
		try {
			return realpathSync(path);
		} catch {
			return null;
		}
	};
	const target = real(execPath);
	if (target === null) return execPath;
	for (const dir of pathEnv.split(platform === "win32" ? ";" : delimiter)) {
		if (!dir.trim()) continue;
		for (const name of names) {
			const candidate = join(dir.trim(), name);
			try {
				accessSync(candidate, constants.X_OK);
			} catch {
				continue;
			}
			if (real(candidate) === target) return candidate;
		}
	}
	return execPath;
}

async function writeAtomic(path: string, content: string | Buffer): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, content, { mode: 0o644 });
	await rename(temp, path);
}

export function createAutostartManager(options: AutostartOptions): AutostartManager {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const run = options.run ?? runCommand;
	const pathEnv = () => options.pathEnv ?? process.env.PATH ?? "";
	const nodeExecutable = () => options.nodeExecutable ?? stableNodeExecutable(process.execPath, pathEnv(), platform);

	const dataDir = () => options.config.dataDir;
	const logsDir = () => join(dataDir(), "logs");

	function buildSpec(): AutostartSpec {
		const { host, port } = options.config;
		const ompBinary = options.ompBinary();
		const node = nodeExecutable();
		return {
			nodeExecutable: node,
			entry: options.entry,
			dataDir: dataDir(),
			logsDir: logsDir(),
			env: {
				...options.extraEnv,
				CLAM_HOST: host,
				CLAM_PORT: String(port),
				CLAM_DATA_DIR: dataDir(),
				...(options.config.ompBinary ? { CLAM_OMP_BIN: options.config.ompBinary } : {}),
				PATH: buildLoginPath({ ompBinary, nodeExecutable: node, pathEnv: pathEnv(), platform }),
			},
		};
	}

	function requireBuild(): void {
		if (!existsSync(options.entry)) {
			throw new AutostartError("not_built", `The built server was not found at ${options.entry}. Build the server first: pnpm build`);
		}
	}

	const foreign = (what: string, owner: string) => ({
		enabled: false,
		detail: `${what} exists but belongs to another CL Agent Mesh node (data dir ${owner}); enable autostart here to take it over.`,
	});
	const staleEntry = (entry: string | null) => (entry && !existsSync(entry) ? ` Warning: the server build it points to (${entry}) no longer exists, so it will fail until you rebuild.` : "");

	// ------------------------------------------------------------ macOS

	const macPlist = () => join(home, "Library", "LaunchAgents", `${MAC_LABEL}.plist`);

	const mac: AutostartManager = {
		async status() {
			const plist = await readFile(macPlist(), "utf8").catch(() => null);
			if (plist === null) return { enabled: false, detail: "No LaunchAgent installed." };
			const owner = readPlistString(plist, "CLAM_DATA_DIR");
			if (owner !== dataDir()) return foreign(`LaunchAgent ${macPlist()}`, owner ?? "unknown");
			return {
				enabled: true,
				detail: `LaunchAgent ${macPlist()} starts CL Agent Mesh at your next login (it is not started now).${staleEntry(readPlistEntry(plist))}`,
			};
		},
		async enable() {
			requireBuild();
			const content = buildLaunchAgentPlist(buildSpec());
			await mkdir(logsDir(), { recursive: true });
			await writeAtomic(macPlist(), content);
			const lint = await run("plutil", ["-lint", macPlist()]);
			if (lint.code !== 0 && lint.code !== 127) {
				await rm(macPlist(), { force: true });
				throw new AutostartError("failed", `The generated LaunchAgent is not a valid property list: ${(lint.stdout + lint.stderr).trim()}`);
			}
			return mac.status();
		},
		async disable() {
			// Never delete another node's entry.
			const plist = await readFile(macPlist(), "utf8").catch(() => null);
			if (plist !== null && readPlistString(plist, "CLAM_DATA_DIR") === dataDir()) await rm(macPlist(), { force: true });
			return mac.status();
		},
	};

	// ------------------------------------------------------------ Linux (systemd --user)

	const unitPath = () => join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
	const systemctl = (...args: string[]) => run("systemctl", ["--user", ...args]);

	const linux: AutostartManager = {
		async status() {
			const unit = await readFile(unitPath(), "utf8").catch(() => null);
			if (unit === null) return { enabled: false, detail: "No systemd user unit installed." };
			const owner = readUnitEnvironment(unit, "CLAM_DATA_DIR");
			if (owner !== dataDir()) return foreign(`systemd user unit ${unitPath()}`, owner ?? "unknown");
			const enabled = await systemctl("is-enabled", SYSTEMD_UNIT);
			if (enabled.code !== 0 || enabled.stdout.trim() !== "enabled") {
				return { enabled: false, detail: `systemd user unit ${unitPath()} is installed but not enabled (${(enabled.stdout || enabled.stderr).trim() || "systemctl unavailable"}).` };
			}
			return {
				enabled: true,
				detail: `systemd user unit ${unitPath()} is enabled: CL Agent Mesh starts when you log in (it is not started now).${staleEntry(readUnitEntry(unit))}`,
			};
		},
		async enable() {
			requireBuild();
			const probe = await systemctl("--version");
			if (probe.code !== 0) {
				throw new AutostartError("unsupported", `Autostart on Linux needs systemd user services, but \`systemctl --user\` is not available: ${probe.stderr.trim() || "systemctl not found"}`);
			}
			const content = buildSystemdUnit(buildSpec());
			await mkdir(logsDir(), { recursive: true });
			await writeAtomic(unitPath(), content);
			const reload = await systemctl("daemon-reload");
			const enable = reload.code === 0 ? await systemctl("enable", SYSTEMD_UNIT) : reload;
			if (enable.code !== 0) {
				await rm(unitPath(), { force: true });
				await systemctl("daemon-reload");
				throw new AutostartError("failed", `systemctl --user could not enable ${SYSTEMD_UNIT}: ${(enable.stderr || enable.stdout).trim()}`);
			}
			return linux.status();
		},
		async disable() {
			const unit = await readFile(unitPath(), "utf8").catch(() => null);
			// Never touch another node's unit.
			if (unit !== null && readUnitEnvironment(unit, "CLAM_DATA_DIR") === dataDir()) {
				const disable = await systemctl("disable", SYSTEMD_UNIT);
				if (disable.code !== 0) {
					// "Not loaded / already disabled" is fine; leaving an enabled link behind is not.
					const still = await systemctl("is-enabled", SYSTEMD_UNIT);
					if (still.code === 0 && still.stdout.trim() === "enabled") {
						throw new AutostartError("failed", `systemctl --user could not disable ${SYSTEMD_UNIT}: ${(disable.stderr || disable.stdout).trim()}`);
					}
				}
				await rm(unitPath(), { force: true });
				await systemctl("daemon-reload");
			}
			return linux.status();
		},
	};

	// ------------------------------------------------------------ Windows (Task Scheduler)

	const wrapperPath = () => join(dataDir(), "autostart", "start-server.cmd");
	const taskXmlPath = () => join(dataDir(), "autostart", "task.xml");
	const schtasks = (...args: string[]) => run("schtasks", args);

	const windows: AutostartManager = {
		async status() {
			const query = await schtasks("/Query", "/TN", WINDOWS_TASK_NAME, "/XML");
			if (query.code !== 0) return { enabled: false, detail: `No "${WINDOWS_TASK_NAME}" scheduled task installed.` };
			if (!query.stdout.includes(xmlEscape(wrapperPath()))) {
				return { enabled: false, detail: `The "${WINDOWS_TASK_NAME}" scheduled task exists but starts another CL Agent Mesh node; enable autostart here to take it over.` };
			}
			return { enabled: true, detail: `Scheduled task "${WINDOWS_TASK_NAME}" starts CL Agent Mesh when you log on (it is not started now).` };
		},
		async enable() {
			requireBuild();
			const spec = buildSpec();
			await mkdir(logsDir(), { recursive: true });
			await writeAtomic(wrapperPath(), buildWindowsWrapper(spec));
			// `schtasks /XML` only reads UTF-16 files.
			await writeAtomic(taskXmlPath(), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(buildWindowsTaskXml(wrapperPath()), "utf16le")]));
			const create = await schtasks("/Create", "/TN", WINDOWS_TASK_NAME, "/XML", taskXmlPath(), "/F");
			if (create.code !== 0) throw new AutostartError("failed", `schtasks could not create the task: ${(create.stderr || create.stdout).trim()}`);
			return windows.status();
		},
		async disable() {
			if ((await windows.status()).enabled) {
				const del = await schtasks("/Delete", "/TN", WINDOWS_TASK_NAME, "/F");
				if (del.code !== 0) throw new AutostartError("failed", `schtasks could not delete the task: ${(del.stderr || del.stdout).trim()}`);
			}
			// Our own helper files go either way; another node's task is left alone.
			await rm(wrapperPath(), { force: true });
			await rm(taskXmlPath(), { force: true });
			return windows.status();
		},
	};

	// ------------------------------------------------------------ other platforms

	const unsupported: AutostartManager = {
		status: async () => ({ enabled: false, detail: `Autostart is not supported on ${platform}.` }),
		enable: async () => {
			throw new AutostartError("unsupported", `Autostart is not supported on ${platform}.`);
		},
		disable: async () => ({ enabled: false, detail: `Autostart is not supported on ${platform}.` }),
	};

	return platform === "darwin" ? mac : platform === "linux" ? linux : platform === "win32" ? windows : unsupported;
}
