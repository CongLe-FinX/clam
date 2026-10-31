import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { BrowserExecutable } from "@clam/contracts";

/** What discovery needs from the machine; every member is injectable so the lookup order is testable without a browser installed. */
export interface DiscoveryEnv {
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	home: string;
	dataDir: string;
	exists(file: string): boolean;
	list(dir: string): string[];
}

export function realDiscoveryEnv(dataDir: string): DiscoveryEnv {
	return {
		env: process.env,
		platform: process.platform,
		home: homedir(),
		dataDir,
		exists: (file) => existsSync(file),
		list: (dir) => {
			try {
				return readdirSync(dir);
			} catch {
				return [];
			}
		},
	};
}

/** `<dataDir>/browsers`: where the one-click installer puts Chromium (`PLAYWRIGHT_BROWSERS_PATH` for the installer). */
export const installedBrowsersDir = (dataDir: string): string => path.join(dataDir, "browsers");

interface Candidate {
	path: string;
	name: string;
}

/** Installed Google Chrome / Chromium / Edge / Brave, in preference order, per OS. */
function systemCandidates(e: DiscoveryEnv): Candidate[] {
	if (e.platform === "darwin") {
		const apps: Array<[string, string, string]> = [
			["Google Chrome", "Google Chrome.app", "Google Chrome"],
			["Chromium", "Chromium.app", "Chromium"],
			["Microsoft Edge", "Microsoft Edge.app", "Microsoft Edge"],
			["Brave", "Brave Browser.app", "Brave Browser"],
		];
		const roots = ["/Applications", path.join(e.home, "Applications")];
		return apps.flatMap(([name, bundle, bin]) => roots.map((root) => ({ name, path: path.join(root, bundle, "Contents", "MacOS", bin) })));
	}
	if (e.platform === "win32") {
		const roots = [e.env.PROGRAMFILES, e.env["PROGRAMFILES(X86)"], e.env.LOCALAPPDATA].filter((r): r is string => !!r);
		const apps: Array<[string, string]> = [
			["Google Chrome", "Google\\Chrome\\Application\\chrome.exe"],
			["Chromium", "Chromium\\Application\\chrome.exe"],
			["Microsoft Edge", "Microsoft\\Edge\\Application\\msedge.exe"],
			["Brave", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
		];
		return apps.flatMap(([name, rel]) => roots.map((root) => ({ name, path: path.win32.join(root, rel) })));
	}
	// Linux and friends: well-known binary names on the standard bin directories and PATH. Snap packages are skipped on
	// purpose: their confinement refuses a profile outside ~/snap, so a dedicated profile directory cannot work there.
	const binaries: Array<[string, string]> = [
		["Google Chrome", "google-chrome-stable"],
		["Google Chrome", "google-chrome"],
		["Chromium", "chromium"],
		["Chromium", "chromium-browser"],
		["Microsoft Edge", "microsoft-edge-stable"],
		["Microsoft Edge", "microsoft-edge"],
		["Brave", "brave-browser"],
	];
	const dirs = [...new Set([...(e.env.PATH ?? "").split(":").filter(Boolean), "/usr/bin", "/usr/local/bin", "/opt/google/chrome"])].filter((d) => !d.startsWith("/snap"));
	return binaries.flatMap(([name, bin]) => dirs.map((dir) => ({ name, path: path.join(dir, bin) })));
}

/** Chromium builds Playwright's installer lays out under `<root>/chromium-<rev>/…` (newest revision first), the full browser before the headless shell. */
function playwrightCandidates(root: string, e: DiscoveryEnv, source: "playwright" | "installed"): Array<Candidate & { source: "playwright" | "installed" }> {
	const entries = e.list(root);
	const byRevision = (prefix: string): string[] =>
		entries
			.filter((entry) => entry.startsWith(`${prefix}-`))
			.sort((a, b) => Number(b.slice(prefix.length + 1)) - Number(a.slice(prefix.length + 1)));
	const full: string[] = [];
	for (const dir of byRevision("chromium")) {
		const base = path.join(root, dir);
		if (e.platform === "darwin") {
			for (const folder of ["chrome-mac-arm64", "chrome-mac"]) {
				full.push(path.join(base, folder, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"));
				full.push(path.join(base, folder, "Chromium.app", "Contents", "MacOS", "Chromium"));
			}
		} else if (e.platform === "win32") {
			for (const folder of ["chrome-win64", "chrome-win"]) full.push(path.win32.join(base, folder, "chrome.exe"));
		} else {
			for (const folder of ["chrome-linux64", "chrome-linux"]) full.push(path.join(base, folder, "chrome"));
		}
	}
	const shell: string[] = [];
	for (const dir of byRevision("chromium_headless_shell")) {
		const base = path.join(root, dir);
		const inner = e.list(base);
		for (const folder of inner.filter((f) => f.startsWith("chrome-")).concat(inner.filter((f) => !f.startsWith("chrome-")))) {
			shell.push(path.join(base, folder, e.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell"));
			shell.push(path.join(base, folder, e.platform === "win32" ? "headless_shell.exe" : "headless_shell"));
		}
	}
	return [...full, ...shell].map((file) => ({ path: file, name: "Chromium (Playwright)", source }));
}

/** Where Playwright keeps its browser cache when `PLAYWRIGHT_BROWSERS_PATH` is not set. */
function playwrightCacheRoots(e: DiscoveryEnv): string[] {
	const custom = e.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
	const roots: string[] = [];
	if (custom && custom !== "0") roots.push(custom);
	if (e.platform === "darwin") roots.push(path.join(e.home, "Library", "Caches", "ms-playwright"));
	else if (e.platform === "win32") roots.push(path.win32.join(e.env.LOCALAPPDATA ?? path.win32.join(e.home, "AppData", "Local"), "ms-playwright"));
	else roots.push(path.join(e.env.XDG_CACHE_HOME?.trim() || path.join(e.home, ".cache"), "ms-playwright"));
	return roots;
}

/**
 * Find the browser this machine runs. Order: `CLAM_BROWSER_PATH`, an installed Chrome/Chromium/Edge/Brave, Playwright's cached
 * Chromium, then the Chromium the one-click installer put in `<dataDir>/browsers`. Null when none is there.
 */
export function findBrowserExecutable(e: DiscoveryEnv): BrowserExecutable | null {
	const explicit = e.env.CLAM_BROWSER_PATH?.trim();
	if (explicit && e.exists(explicit)) return { path: explicit, name: nameOfPath(explicit), source: "env" };
	for (const candidate of systemCandidates(e)) if (e.exists(candidate.path)) return { path: candidate.path, name: candidate.name, source: "system" };
	for (const root of playwrightCacheRoots(e)) {
		for (const candidate of playwrightCandidates(root, e, "playwright")) if (e.exists(candidate.path)) return { path: candidate.path, name: candidate.name, source: "playwright" };
	}
	for (const candidate of playwrightCandidates(installedBrowsersDir(e.dataDir), e, "installed")) if (e.exists(candidate.path)) return { path: candidate.path, name: "Chromium", source: "installed" };
	return null;
}

function nameOfPath(file: string): string {
	const base = path.basename(file).toLowerCase();
	if (base.includes("edge")) return "Microsoft Edge";
	if (base.includes("brave")) return "Brave";
	if (base.includes("chrome-headless-shell") || base.includes("headless_shell")) return "Chromium (headless shell)";
	if (base.includes("chromium")) return "Chromium";
	if (base.includes("chrome")) return "Google Chrome";
	return path.basename(file);
}
