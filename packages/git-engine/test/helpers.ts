import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { createGitEngine, type GitEngine } from "../src/index.ts";

// Isolate from the developer's git configuration (credential helpers, signing, hooks path, …).
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const roots: string[] = [];
const engines: GitEngine[] = [];

afterAll(async () => {
	await Promise.all(engines.map((e) => e.dispose().catch(() => {})));
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

export function tmpRoot(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "clam-ge-")));
	roots.push(dir);
	return dir;
}

export function sh(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
}

export function write(dir: string, rel: string, content: string): void {
	const p = join(dir, rel);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, content);
}

export function read(dir: string, rel: string): string {
	return readFileSync(join(dir, rel), "utf8");
}

export function configUser(dir: string, name = "Test User", email = "test@example.com"): void {
	sh(dir, "config", "user.name", name);
	sh(dir, "config", "user.email", email);
}

export function commitAll(dir: string, message: string): string {
	sh(dir, "add", "-A");
	sh(dir, "commit", "-q", "-m", message);
	return sh(dir, "rev-parse", "HEAD").trim();
}

export async function newEngine(root: string, gitBinary?: string): Promise<GitEngine> {
	const engine = await createGitEngine({ runtimeDir: join(root, "run"), gitBinary });
	engines.push(engine);
	return engine;
}

/** A shell wrapper that records argv and environment of every invocation, then runs the real git. */
export function captureWrapper(root: string): { bin: string; log: string; invocations(): Array<{ argv: string[] }>; raw(): string } {
	const log = join(root, "git-calls.log");
	const bin = join(root, "git-capture.sh");
	writeFileSync(
		bin,
		`#!/bin/sh
{ printf 'ARGV'; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\n'; env | sort | sed 's/^/ENV /'; } >> '${log}'
exec git "$@"
`,
	);
	chmodSync(bin, 0o755);
	return {
		bin,
		log,
		invocations: () =>
			(existsSync(log) ? readFileSync(log, "utf8") : "")
				.split("\n")
				.filter((l) => l.startsWith("ARGV"))
				.map((l) => ({ argv: l.slice(4).split("\x1f").slice(1) })),
		raw: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
	};
}

export interface Fixture {
	root: string;
	remote: string;
	a: string;
	b: string;
}

/** Bare "origin" + two clones (A seeded with one commit on `main`, B cloned from it). */
export function makeFixture(): Fixture {
	const root = tmpRoot();
	const remote = join(root, "remote.git");
	const a = join(root, "a");
	const b = join(root, "b");
	sh(root, "init", "-q", "--bare", "-b", "main", remote);
	sh(root, "clone", "-q", remote, a);
	configUser(a, "Alice", "alice@example.com");
	write(a, "README.md", "# demo\n");
	write(a, "src/app.ts", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
	commitAll(a, "initial");
	sh(a, "push", "-q", "-u", "origin", "main");
	sh(root, "clone", "-q", remote, b);
	configUser(b, "Bob", "bob@example.com");
	return { root, remote, a, b };
}
