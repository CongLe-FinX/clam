import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HandoffEnvironment, HandoffProject } from "@clam/contracts";
import { parseVersion, satisfiesRange } from "./semver.ts";

type PackageManager = NonNullable<HandoffEnvironment["packageManager"]>;
type Runtime = HandoffEnvironment["runtimes"][number];

async function readText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

async function exists(path: string): Promise<boolean> {
	return (await readText(path)) !== null;
}

function readJson(text: string | null): Record<string, unknown> | null {
	if (text === null) return null;
	try {
		const value: unknown = JSON.parse(text);
		return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A pin file / `engines` value → a range, or null for aliases that carry no version (`lts/*`, `system`, `stable`). */
function pinToRange(text: string | null): string | null {
	if (!text) return null;
	const t = text.trim().split(/\r?\n/)[0]?.trim() ?? "";
	if (!/\d/.test(t)) return null;
	if (/^[v=]?\d+(?:\.\d+){0,2}$/.test(t)) return t.replace(/^[v=]/, "");
	return t;
}

export interface DetectOptions {
	/** Declared by the user/source; carried through verbatim. */
	setupCommands?: string[];
	checkCommand?: string | null;
	/** Override `process.platform` / `process.arch` (tests). */
	os?: string | null;
	arch?: string | null;
}

interface Ecosystem {
	pm: PackageManager;
	runtimes: Runtime[];
}

async function detectNode(dir: string): Promise<Ecosystem | null> {
	const pkgText = await readText(join(dir, "package.json"));
	const pkg = readJson(pkgText);
	const lock = await firstExisting(dir, [
		["pnpm-lock.yaml", "pnpm", "pnpm install --frozen-lockfile"],
		["yarn.lock", "yarn", "yarn install --frozen-lockfile"],
		["package-lock.json", "npm", "npm ci"],
		["npm-shrinkwrap.json", "npm", "npm ci"],
		["bun.lock", "bun", "bun install --frozen-lockfile"],
		["bun.lockb", "bun", "bun install --frozen-lockfile"],
	]);
	if (!lock && !pkg) return null;

	const runtimes: Runtime[] = [];
	const engines = asRecord(pkg?.engines);
	const nodeRange = pinToRange(asString(engines?.node)) ?? pinToRange(await readText(join(dir, ".nvmrc"))) ?? pinToRange(await readText(join(dir, ".node-version")));
	runtimes.push({ name: "node", versionRange: nodeRange ?? "*" });
	if (!nodeRange) runtimes.pop(); // nothing pinned: do not demand a specific node, only that the package manager works

	// `packageManager: "pnpm@9.1.0"` (corepack) names the tool when no lockfile does.
	const declared = /^(pnpm|yarn|npm|bun)@(\d+(?:\.\d+){0,2})/.exec(asString(pkg?.packageManager) ?? "");
	let pm: PackageManager | null = lock ? { name: lock.name, lockfile: lock.file, installCommand: lock.command } : null;
	if (!pm) {
		const name = declared?.[1] ?? "npm";
		pm = { name, lockfile: null, installCommand: `${name} install` };
	}
	if (declared && declared[1] === pm.name) {
		runtimes.push({ name: pm.name, versionRange: `^${declared[2]}` });
	}
	for (const tool of ["pnpm", "yarn", "npm"] as const) {
		const range = pinToRange(asString(engines?.[tool]));
		if (range && !runtimes.some((r) => r.name === tool)) runtimes.push({ name: tool, versionRange: range });
	}
	return { pm, runtimes };
}

async function firstExisting(dir: string, candidates: [file: string, name: string, command: string][]) {
	for (const [file, name, command] of candidates) {
		if (await exists(join(dir, file))) return { file, name, command };
	}
	return null;
}

async function detectPython(dir: string): Promise<Ecosystem | null> {
	const pyproject = await readText(join(dir, "pyproject.toml"));
	const requirements = await exists(join(dir, "requirements.txt"));
	const uvLock = await exists(join(dir, "uv.lock"));
	const poetryLock = await exists(join(dir, "poetry.lock"));
	const pipfileLock = await exists(join(dir, "Pipfile.lock"));
	let pm: PackageManager | null = null;
	if (pyproject !== null && uvLock) pm = { name: "uv", lockfile: "uv.lock", installCommand: "uv sync" };
	else if (poetryLock) pm = { name: "poetry", lockfile: "poetry.lock", installCommand: "poetry install" };
	else if (pipfileLock) pm = { name: "pipenv", lockfile: "Pipfile.lock", installCommand: "pipenv sync" };
	else if (requirements) pm = { name: "pip", lockfile: "requirements.txt", installCommand: "python3 -m pip install -r requirements.txt" };
	if (!pm) return null;

	const runtimes: Runtime[] = [];
	const pin = pinToRange(await readText(join(dir, ".python-version")));
	const requiresPython = pyproject ? /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1] : undefined;
	const range = pin ?? pinToRange(requiresPython ?? null);
	if (range) runtimes.push({ name: "python", versionRange: range });
	return { pm, runtimes };
}

async function detectGo(dir: string): Promise<Ecosystem | null> {
	const gomod = await readText(join(dir, "go.mod"));
	if (gomod === null) return null;
	const version = /^\s*go\s+(\d+(?:\.\d+){1,2})/m.exec(gomod)?.[1];
	return {
		pm: { name: "go", lockfile: (await exists(join(dir, "go.sum"))) ? "go.sum" : null, installCommand: "go mod download" },
		runtimes: version ? [{ name: "go", versionRange: `>=${version}` }] : [],
	};
}

async function detectRust(dir: string): Promise<Ecosystem | null> {
	if (!(await exists(join(dir, "Cargo.toml")))) return null;
	const toolchainFile = (await readText(join(dir, "rust-toolchain.toml"))) ?? (await readText(join(dir, "rust-toolchain")));
	const channel = toolchainFile ? (/^\s*channel\s*=\s*["']([^"']+)["']/m.exec(toolchainFile)?.[1] ?? toolchainFile.split(/\r?\n/)[0]?.trim()) : undefined;
	const range = pinToRange(channel ?? null);
	return {
		pm: { name: "cargo", lockfile: (await exists(join(dir, "Cargo.lock"))) ? "Cargo.lock" : null, installCommand: "cargo fetch" },
		runtimes: range ? [{ name: "rust", versionRange: /^\d/.test(range) && !/[<>=^~*x|]/.test(range) ? `>=${range}` : range }] : [],
	};
}

async function detectRuby(dir: string): Promise<Ecosystem | null> {
	if (!(await exists(join(dir, "Gemfile.lock")))) return null;
	const range = pinToRange(await readText(join(dir, ".ruby-version")));
	return {
		pm: { name: "bundler", lockfile: "Gemfile.lock", installCommand: "bundle install" },
		runtimes: range ? [{ name: "ruby", versionRange: range }] : [],
	};
}

const ENV_EXAMPLE_FILES = [".env.example", ".env.sample", ".env.template", ".env.dist"];

/** Variable NAMES from the example env files — values are never read into the result. */
async function detectEnvVarNames(dir: string): Promise<string[]> {
	const names = new Set<string>();
	for (const file of ENV_EXAMPLE_FILES) {
		const text = await readText(join(dir, file));
		if (text === null) continue;
		for (const line of text.split(/\r?\n/)) {
			const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
			if (m) names.add(m[1] as string);
		}
	}
	return [...names].sort();
}

/** Folders never scanned for nested projects: installed dependencies, vendored code, build output, caches (and every dot-folder). */
const SKIPPED_DIRS: Record<string, true> = { node_modules: true, vendor: true, third_party: true, bower_components: true, dist: true, build: true, out: true, target: true, coverage: true, __pycache__: true, venv: true, "site-packages": true };
/** How deep below the work folder a nested project may sit (`a/b/c` is 3). */
export const NESTED_PROJECT_MAX_DEPTH = 3;
/** At most this many nested projects are reported (the manifest allows the same). */
export const NESTED_PROJECT_MAX = 20;
/** A scan never looks at more folders than this, whatever the tree looks like. */
const NESTED_SCAN_MAX_DIRS = 2000;

type EcosystemKind = "node" | "python" | "go" | "rust" | "ruby";
const DETECTORS: ReadonlyArray<readonly [EcosystemKind, (dir: string) => Promise<Ecosystem | null>]> = [
	["node", detectNode],
	["python", detectPython],
	["go", detectGo],
	["rust", detectRust],
	["ruby", detectRuby],
];

interface NestedProject {
	path: string;
	eco: Ecosystem;
}

/**
 * Projects in subfolders of `root` (depth ≤ `NESTED_PROJECT_MAX_DEPTH`, breadth first and alphabetical so the result is stable
 * and the shallowest win the cap). A folder is only a project of its own when it would not be installed by an ancestor: a
 * manifest WITHOUT its own lockfile under an ancestor project of the same ecosystem is a workspace member (`packages/*` of a
 * pnpm monorepo), a manifest with its own lockfile, or one with no ancestor of that ecosystem, is a separate root.
 */
async function detectNested(root: string, rootKinds: ReadonlySet<EcosystemKind>): Promise<NestedProject[]> {
	const found: NestedProject[] = [];
	let visited = 0;
	let level: Array<{ rel: string; kinds: ReadonlySet<EcosystemKind> }> = [{ rel: "", kinds: rootKinds }];
	for (let depth = 1; depth <= NESTED_PROJECT_MAX_DEPTH && level.length > 0; depth++) {
		const next: typeof level = [];
		for (const parent of level) {
			let entries: string[];
			try {
				entries = (await readdir(join(root, parent.rel), { withFileTypes: true })).filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith(".") && !Object.hasOwn(SKIPPED_DIRS, e.name)).map((e) => e.name);
			} catch {
				continue;
			}
			for (const name of entries.sort()) {
				if (++visited > NESTED_SCAN_MAX_DIRS) return found;
				const rel = parent.rel === "" ? name : `${parent.rel}/${name}`;
				const kinds = new Set(parent.kinds);
				for (const [kind, detect] of DETECTORS) {
					const eco = await detect(join(root, rel));
					if (!eco) continue;
					if (eco.pm.lockfile === null && parent.kinds.has(kind)) continue; // installed by the ancestor
					kinds.add(kind);
					if (found.length < NESTED_PROJECT_MAX) found.push({ path: rel, eco });
				}
				next.push({ rel, kinds });
			}
		}
		level = next;
	}
	return found;
}

/**
 * Detect how to rebuild the environment of a work folder from lockfiles/manifests. A folder with nothing
 * recognisable (research/report chats) yields an empty, valid environment (`packageManager: null`).
 * The first matching ecosystem of the folder itself (node → python → go → rust → ruby) becomes `packageManager`; install
 * commands of its further ecosystems are appended to `setupCommands`. Projects in subfolders (see `detectNested`) are listed
 * in `projects`, each installed with its own folder as the working directory; their runtimes join `runtimes`.
 */
export async function detectEnvironment(dir: string, opts: DetectOptions = {}): Promise<HandoffEnvironment> {
	const found: Ecosystem[] = [];
	const rootKinds = new Set<EcosystemKind>();
	for (const [kind, detect] of DETECTORS) {
		const eco = await detect(dir);
		if (!eco) continue;
		found.push(eco);
		rootKinds.add(kind);
	}
	const nested = await detectNested(dir, rootKinds);
	const [primary, ...others] = found;
	const runtimes: Runtime[] = [];
	for (const eco of [...found, ...nested.map((n) => n.eco)]) {
		for (const r of eco.runtimes) if (!runtimes.some((x) => x.name === r.name)) runtimes.push(r);
	}
	const projects: HandoffProject[] = nested.map((n) => ({ path: n.path, packageManager: n.eco.pm }));
	return {
		os: opts.os === undefined ? process.platform : opts.os,
		arch: opts.arch === undefined ? process.arch : opts.arch,
		runtimes,
		packageManager: primary?.pm ?? null,
		requiredEnvVars: await detectEnvVarNames(dir),
		setupCommands: [...others.map((o) => o.pm.installCommand), ...(opts.setupCommands ?? [])],
		...(projects.length > 0 && { projects }),
		checkCommand: opts.checkCommand ?? null,
	};
}

/** Human-facing hints that do not change the commands (e.g. prefer a virtualenv for pip). */
export function environmentNotes(env: HandoffEnvironment): string[] {
	const notes: string[] = [];
	if (env.packageManager?.name === "pip") {
		notes.push("pip installs into the interpreter's site-packages: prefer a virtualenv (`python3 -m venv .venv`) on the target.");
	}
	if (env.requiredEnvVars.length > 0) {
		notes.push(`Set these environment variables on the target (names only, values are never handed over): ${env.requiredEnvVars.join(", ")}.`);
	}
	return notes;
}

// ------------------------------------------------------------------ runtime probe

export type RuntimeStatus = "ok" | "missing" | "mismatch" | "unknown";
export interface RuntimeCheck {
	name: string;
	versionRange: string;
	status: RuntimeStatus;
	/** `major.minor.patch` found locally; null when missing or unparseable. */
	found: string | null;
	detail: string;
}
export interface RuntimeReport {
	ok: boolean;
	checks: RuntimeCheck[];
}

/** Runs `cmd args` and returns combined stdout+stderr, or null when the executable is missing/fails. */
export type ProbeFn = (cmd: string, args: string[]) => Promise<string | null>;

export const defaultProbe: ProbeFn = (cmd, args) => {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile(cmd, args, { timeout: 10_000, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
		resolve(error ? null : `${stdout}\n${stderr}`);
	});
	return promise;
};

const PROBES: Record<string, Array<[string, string[]]>> = {
	node: [["node", ["--version"]]],
	python: [["python3", ["--version"]], ["python", ["--version"]]],
	pip: [["python3", ["-m", "pip", "--version"]]],
	go: [["go", ["version"]]],
	rust: [["rustc", ["--version"]]],
	cargo: [["cargo", ["--version"]]],
	ruby: [["ruby", ["--version"]]],
	bundler: [["bundle", ["--version"]]],
};
const SAFE_TOOL = /^[a-z0-9][a-z0-9_.-]*$/i;

/**
 * Probe local tool versions for `env.runtimes` and the package manager itself, and compare against the
 * ranges. A failed check is advisory data for the dependency step: `ok` is false when anything is
 * `missing` or `mismatch` (`unknown` = tool present but its version could not be read).
 */
export async function checkRuntimes(env: HandoffEnvironment, probe: ProbeFn = defaultProbe): Promise<RuntimeReport> {
	const wanted: Runtime[] = [...env.runtimes];
	if (env.packageManager && !wanted.some((r) => r.name === env.packageManager?.name)) {
		wanted.push({ name: env.packageManager.name, versionRange: "*" });
	}
	const checks: RuntimeCheck[] = [];
	for (const { name, versionRange } of wanted) {
		checks.push(await checkOne(name, versionRange, probe));
	}
	return { ok: checks.every((c) => c.status === "ok" || c.status === "unknown"), checks };
}

async function checkOne(name: string, versionRange: string, probe: ProbeFn): Promise<RuntimeCheck> {
	const key = name.toLowerCase();
	const candidates = PROBES[key] ?? (SAFE_TOOL.test(name) ? [[name, ["--version"]] as [string, string[]]] : []);
	let output: string | null = null;
	for (const [cmd, args] of candidates) {
		output = await probe(cmd, args);
		if (output !== null) break;
	}
	if (output === null) return { name, versionRange, status: "missing", found: null, detail: `${name} is not installed (or not on PATH)` };
	const version = parseVersion(output);
	if (!version) return { name, versionRange, status: "unknown", found: null, detail: `${name} is installed but its version could not be read` };
	const found = version.join(".");
	if (!satisfiesRange(version, versionRange)) {
		return { name, versionRange, status: "mismatch", found, detail: `${name} ${found} does not satisfy ${versionRange}` };
	}
	return { name, versionRange, status: "ok", found, detail: `${name} ${found} satisfies ${versionRange}` };
}

// ------------------------------------------------------------------ setup fingerprint

/**
 * Hash of the lockfile contents + install command + extra setup commands: if it is unchanged after a
 * crash, the dependency step was already done for exactly this input and may be skipped. Without a
 * lockfile the package manifest(s) stand in, so the fingerprint still changes when dependencies do.
 */
export async function setupFingerprint(dir: string, env: HandoffEnvironment): Promise<string> {
	const hash = createHash("sha256");
	const add = (label: string, value: string) => hash.update(`${label}\0${value.length}\0${value}\0`);
	const pm = env.packageManager;
	add("command", pm?.installCommand ?? "");
	add("setup", JSON.stringify(env.setupCommands));
	const files = pm?.lockfile ? [pm.lockfile] : ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile"];
	for (const file of files) {
		add(`file:${file}`, (await readText(join(dir, file))) ?? "<absent>");
	}
	// Folder by folder, the same way: what each nested project installs from. Nothing is added for a root-only environment.
	for (const project of env.projects ?? []) {
		add(`project:${project.path}`, project.packageManager.installCommand);
		const nestedFiles = project.packageManager.lockfile ? [project.packageManager.lockfile] : ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile"];
		for (const file of nestedFiles) add(`file:${project.path}/${file}`, (await readText(join(dir, project.path, file))) ?? "<absent>");
	}
	return hash.digest("hex");
}
