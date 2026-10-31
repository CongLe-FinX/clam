import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";

export interface ShellInfo {
	user: string;
	home: string;
	defaultShell: string;
	shells: string[];
}

const isRunnable = (file: string): boolean => {
	try {
		if (!path.isAbsolute(file) || !statSync(file).isFile()) return false;
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

/** The OS account's login shell: `$SHELL`, else the passwd entry, else the first of bash/zsh/sh that exists. */
function loginShell(): string {
	const candidates: Array<string | undefined> = [process.env.SHELL, safeUserInfo()?.shell ?? undefined, "/bin/bash", "/bin/zsh", "/bin/sh"];
	for (const candidate of candidates) if (candidate && isRunnable(candidate)) return candidate;
	return "/bin/sh";
}

function safeUserInfo(): import("node:os").UserInfo<string> | null {
	try {
		return userInfo({ encoding: "utf8" });
	} catch {
		return null;
	}
}

/** Shells the owner may pick: `/etc/shells` entries that exist here, plus the login shell. */
export function shellInfo(): ShellInfo {
	const defaultShell = loginShell();
	const listed: string[] = [];
	try {
		for (const line of readFileSync("/etc/shells", "utf8").split("\n")) {
			const entry = line.trim();
			if (entry.startsWith("/") && !entry.includes("nologin") && !entry.endsWith("/false") && isRunnable(entry)) listed.push(entry);
		}
	} catch {
		// No /etc/shells (minimal image): the login shell is the only choice.
	}
	const shells = [defaultShell, ...listed].filter((shell, index, all) => all.indexOf(shell) === index);
	return { user: safeUserInfo()?.username ?? process.env.USER ?? "user", home: homedir(), defaultShell, shells };
}

/** The environment a shell starts with: this process's, minus the node's own settings, with the terminal identity set. */
export function shellEnv(shell: string, cwd: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		// CLAM_* configure THIS server (ports, data dir): a dev server started from the terminal must not inherit them.
		if (value === undefined || key.startsWith("CLAM_") || key === "NODE_ENV" || key === "INIT_CWD" || key.startsWith("npm_")) continue;
		env[key] = value;
	}
	env.TERM = "xterm-256color";
	env.COLORTERM = "truecolor";
	env.TERM_PROGRAM = "CL-Agent-Mesh";
	env.SHELL = shell;
	env.PWD = cwd;
	env.HOME ??= homedir();
	if (!env.LANG && !env.LC_ALL) env.LANG = "en_US.UTF-8";
	return env;
}

/** The shell's display name (`/bin/zsh` → `zsh`). */
export const shellName = (shell: string): string => path.basename(shell) || shell;

export const dirExists = (dir: string): boolean => existsSync(dir) && statSync(dir).isDirectory();
