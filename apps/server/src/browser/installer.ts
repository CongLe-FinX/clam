import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserInstallState } from "@clam/contracts";
import { installedBrowsersDir } from "./executable.ts";

const LOG_LINES = 14;

/** `npx`: next to the running node (version managers, official installers), else on PATH. */
export function locateNpx(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string | null {
	const name = platform === "win32" ? "npx.cmd" : "npx";
	const beside = path.join(path.dirname(process.execPath), name);
	if (existsSync(beside)) return beside;
	for (const dir of (env.PATH ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean)) {
		const candidate = path.join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** Pull the percentage out of Playwright's progress bar output (`|■■■■    |  42% of 150.3 MiB`). */
export function parseInstallProgress(chunk: string): number | null {
	let latest: number | null = null;
	for (const match of chunk.matchAll(/(\d{1,3})%/g)) latest = Math.min(100, Number(match[1]));
	return latest;
}

/**
 * The one-click "Install Chromium": the official Playwright installer, run with `PLAYWRIGHT_BROWSERS_PATH=<dataDir>/browsers`, so the
 * browser lives (and is removed) with the node's data and nothing is installed system-wide.
 */
export class ChromiumInstaller {
	private state: BrowserInstallState = { state: "idle", progress: null, log: [], error: null };
	private child: ChildProcess | null = null;

	constructor(
		private readonly dataDir: string,
		private readonly onDone: () => void,
		private readonly npx: () => string | null = () => locateNpx(),
	) {}

	snapshot(): BrowserInstallState {
		return { ...this.state, log: [...this.state.log] };
	}

	get running(): boolean {
		return this.state.state === "running";
	}

	start(): void {
		if (this.running) return;
		const npx = this.npx();
		if (!npx) {
			this.state = { state: "failed", progress: null, log: [], error: "npx was not found on this machine. Install Node.js (it ships npx) or set CLAM_BROWSER_PATH to a Chrome or Chromium executable." };
			return;
		}
		const target = installedBrowsersDir(this.dataDir);
		mkdirSync(target, { recursive: true, mode: 0o700 });
		this.state = { state: "running", progress: null, log: [`$ npx playwright install chromium  (into ${target})`], error: null };
		const child = spawn(npx, ["--yes", "playwright", "install", "chromium"], {
			env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: target, FORCE_COLOR: "0", CI: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
			windowsHide: true,
		});
		this.child = child;
		const onData = (data: Buffer): void => {
			const text = data.toString("utf8");
			const progress = parseInstallProgress(text);
			const lines = text.split(/[\r\n]+/).map((l) => l.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").trim()).filter((l) => l && !/^\|[■ ]+\|/.test(l));
			this.state = { ...this.state, progress: progress ?? this.state.progress, log: [...this.state.log, ...lines].slice(-LOG_LINES) };
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("error", (error) => {
			this.child = null;
			this.state = { ...this.state, state: "failed", error: error.message };
		});
		child.on("exit", (code, signal) => {
			this.child = null;
			if (code === 0) {
				this.state = { ...this.state, state: "done", progress: 100, error: null };
				this.onDone();
			} else if (this.state.state === "running") {
				const tail = this.state.log.at(-1);
				this.state = { ...this.state, state: "failed", error: `The installer ${signal ? `was stopped (${signal})` : `exited with code ${code}`}${tail ? `: ${tail}` : ""}` };
			}
		});
	}

	/** Stop an installer this process started (shutdown). */
	cancel(): void {
		const child = this.child;
		this.child = null;
		if (!child) return;
		this.state = { ...this.state, state: "failed", error: "Installation was cancelled" };
		child.kill("SIGTERM");
	}
}
