import { createReadStream } from "node:fs";
import { mkdir, readdir, realpath, rm, stat, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	GitBranch,
	GitCommit,
	DiffFile,
	GitConflictReport,
	GitDiff,
	GitDiffQuery,
	GitLogPage,
	GitPullResult,
	GitPushResult,
	GitRemote,
	GitStatus,
} from "@clam/contracts";
import { type AskpassBroker, type GitAuth, createAskpassBroker } from "./askpass.ts";
import { DEFAULT_DIFF_CAPS, languageOf, parsePatch } from "./diff.ts";
import { GitEngineError, classifyFailure, stripUrlCredentials } from "./errors.ts";
import { BRANCH_FORMAT, LOG_FORMAT, parseBranches, parseLog } from "./log.ts";
import { type Runner, createRunner, failure } from "./runner.ts";
import { parseStatusV2 } from "./status.ts";

export type { GitAuth } from "./askpass.ts";

export interface GitProgress {
	phase: string;
	percent: number | null;
}

export interface GitEngineOptions {
	gitBinary?: string;
	/** 0700 directory for the askpass socket and helper. */
	runtimeDir: string;
	log?: { debug(o: object, m?: string): void; warn(o: object, m?: string): void };
}

export interface GitEngine {
	version(): Promise<string>;
	isRepo(dir: string): Promise<boolean>;
	status(dir: string): Promise<GitStatus>;
	diff(dir: string, q: GitDiffQuery): Promise<GitDiff>;
	branches(dir: string): Promise<GitBranch[]>;
	log(dir: string, o: { ref?: string; limit: number; cursor?: string }): Promise<GitLogPage>;
	createBranch(dir: string, o: { name: string; from?: string; checkout: boolean }): Promise<void>;
	checkout(dir: string, branch: string): Promise<void>;
	stage(dir: string, paths: string[]): Promise<void>;
	unstage(dir: string, paths: string[]): Promise<void>;
	/** Reverts exactly the given paths to HEAD (index and working tree); untracked/new files at those paths are deleted. */
	discard(dir: string, paths: string[]): Promise<void>;
	/** With `paths`, commits only those paths (other staged changes stay staged). Without, commits the index. */
	commit(dir: string, o: { message: string; paths?: string[]; author: { name: string; email: string }; trailers?: Record<string, string> }): Promise<GitCommit>;
	clone(url: string, dest: string, o: { branch?: string; auth?: GitAuth; onProgress?: (p: GitProgress) => void; signal?: AbortSignal }): Promise<void>;
	fetch(dir: string, o: { remote?: string; auth?: GitAuth; onProgress?: (p: GitProgress) => void }): Promise<void>;
	pull(dir: string, o: { auth?: GitAuth }): Promise<Omit<GitPullResult, "status">>;
	push(dir: string, o: { auth?: GitAuth; setUpstream: boolean }): Promise<Omit<GitPushResult, "status">>;
	conflicts(dir: string, o: { against?: string }): Promise<GitConflictReport>;
	/**
	 * Linked working tree of `dir` (the repository's main working tree) on `o.branch`. A branch another working tree already
	 * holds is refused with `branch_in_worktree`.
	 */
	worktreeAdd(dir: string, o: WorktreeAddOptions): Promise<void>;
	/** `git worktree remove` WITHOUT `--force`: a dirty, locked or unclean working tree is refused (`dirty_worktree`) and kept. The branch is never deleted. */
	worktreeRemove(dir: string, path: string): Promise<void>;
	worktreeList(dir: string): Promise<GitWorktree[]>;
	/** Forgets linked working trees whose directory is gone. */
	worktreePrune(dir: string): Promise<void>;
	/**
	 * `git format-patch --stdout --binary --no-color <base>..<head>` (head defaults to HEAD): the mbox of every commit in
	 * the range, oldest first, plus the commit count. An empty range yields an empty buffer and 0 commits. Output over
	 * 25 MiB throws `failed`. Needs no configured identity. Read-only.
	 */
	formatPatch(dir: string, o: { base: string; head?: string }): Promise<{ patch: Buffer; commits: number }>;
	configIdentity(dir: string): Promise<{ name: string; email: string } | null>;
	githubRemote(dir: string): Promise<{ owner: string; repo: string } | null>;
	dispose(): Promise<void>;
}

/** One entry of `git worktree list`; the first entry is the repository's main working tree. */
export interface GitWorktree {
	path: string;
	/** Short branch name; null when HEAD is detached or the entry is bare. */
	branch: string | null;
	headSha: string | null;
	/** Git marks the directory as gone (deleted by hand); `worktreePrune` forgets it. */
	prunable: boolean;
}

export interface WorktreeAddOptions {
	/** Absolute directory of the new linked working tree (must not exist or be empty). */
	path: string;
	branch: string;
	/** Create `branch` (from `startPoint`, default HEAD). Without it `branch` must already exist locally. */
	newBranch?: boolean;
	startPoint?: string;
	/** With `newBranch` and a remote-tracking `startPoint`: set it as the new branch's upstream. */
	track?: boolean;
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_UNTRACKED_DIFFS = 200;
const MAX_PATCH_BYTES = 25 * 1024 * 1024;

export function parseGithubUrl(url: string): { owner: string; repo: string } | null {
	const clean = stripUrlCredentials(url.trim());
	const m =
		/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?(?:www\.)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(clean) ??
		/^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(clean);
	return m ? { owner: m[1] as string, repo: m[2] as string } : null;
}

export function parseProgress(line: string): GitProgress | null {
	const withPct = /^(?:remote: )?([A-Za-z][A-Za-z ]*?):\s+(\d+)%/.exec(line);
	if (withPct) return { phase: withPct[1] as string, percent: Number(withPct[2]) };
	const counting = /^(?:remote: )?([A-Za-z][A-Za-z ]*?):\s+\d+, done\./.exec(line);
	if (counting) return { phase: counting[1] as string, percent: null };
	if (line.startsWith("Cloning into")) return { phase: "Cloning", percent: null };
	return null;
}

function validateRef(value: string, what = "ref"): string {
	if (!value || value.startsWith("-") || /[\0\n\r]/.test(value)) {
		throw new GitEngineError("invalid_ref", `Invalid ${what}: ${JSON.stringify(value)}`);
	}
	return value;
}

/** Normalises project-relative paths; rejects escapes from the repo and `.git` internals. */
function normalizePaths(root: string, paths: string[]): string[] {
	const out: string[] = [];
	for (const p of paths) {
		if (!p || p.includes("\0")) throw new GitEngineError("invalid_ref", `Invalid path: ${JSON.stringify(p)}`);
		const rel = isAbsolute(p) ? relative(root, p) : p;
		const norm = rel.split(sep).join("/").replace(/^(\.\/)+/, "").replace(/\/+$/, "") || ".";
		const segs = norm.split("/");
		if (segs.includes("..") || segs[0] === ".git") throw new GitEngineError("invalid_ref", `Path is outside the repository or inside .git: ${p}`);
		out.push(norm);
	}
	return out;
}

const nulList = (paths: string[]): string => `${paths.join("\0")}\0`;

function pathCovered(candidate: string, specs: string[]): boolean {
	return specs.some((s) => s === "." || candidate === s || candidate.startsWith(`${s}/`));
}

/** Two repo paths clash when equal or when one is a directory prefix of the other (file/dir collisions). */
function pathsClash(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export async function createGitEngine(opts: GitEngineOptions): Promise<GitEngine> {
	const gitBinary = opts.gitBinary ?? "git";
	const broker: AskpassBroker = await createAskpassBroker(opts.runtimeDir);
	const runner: Runner = createRunner(gitBinary, broker, opts.log);
	const git = runner.text;
	const gitRun = runner.run;

	const ver = (await git(["--version"]).catch(async (err) => {
		await broker.close();
		throw err;
	})).trim();

	async function rootOf(dir: string): Promise<string | null> {
		const st = await stat(dir).catch(() => null);
		if (!st?.isDirectory()) return null;
		const r = await gitRun(["rev-parse", "--show-toplevel"], { cwd: dir });
		if (r.code !== 0) return null;
		const top = r.stdout.toString("utf8").trim();
		if (!top) return null;
		const [a, b] = await Promise.all([realpath(top).catch(() => top), realpath(dir).catch(() => dir)]);
		return a === b ? b : null;
	}

	/** Returns the canonical repo root or throws `not_a_repo`. */
	async function ensureRoot(dir: string): Promise<string> {
		const root = await rootOf(dir);
		if (!root) throw new GitEngineError("not_a_repo", `${dir} is not the root of a git repository`);
		return dir;
	}

	async function resolveCommit(dir: string, ref: string, what = "ref"): Promise<string> {
		validateRef(ref, what);
		const r = await gitRun(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: dir });
		const sha = r.stdout.toString("utf8").trim();
		if (r.code !== 0 || !sha) throw new GitEngineError("invalid_ref", `Unknown ${what}: ${ref}`, r.stderr);
		return sha;
	}

	async function hasHead(dir: string): Promise<boolean> {
		return (await gitRun(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: dir })).code === 0;
	}

	function mapOperationError(err: unknown): never {
		if (err instanceof GitEngineError) {
			const s = err.stderr;
			if (/would be overwritten|overwritten by checkout/i.test(s)) throw new GitEngineError("would_overwrite", firstMessage(s) || err.message, s);
			if (/need to resolve your current index|unmerged|in the middle of|cannot do a partial commit during|merge in progress|rebase in progress/i.test(s))
				throw new GitEngineError("operation_in_progress", firstMessage(s) || err.message, s);
		}
		throw err;
	}

	async function remotesOf(dir: string): Promise<GitRemote[]> {
		const r = await gitRun(["remote", "-v"], { cwd: dir });
		if (r.code !== 0) return [];
		const seen = new Map<string, GitRemote>();
		for (const line of r.stdout.toString("utf8").split("\n")) {
			const m = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line);
			if (!m || m[3] !== "fetch") continue;
			const name = m[1] as string;
			const url = stripUrlCredentials(m[2] as string);
			const gh = parseGithubUrl(url);
			seen.set(name, { name, url, github: gh ? `${gh.owner}/${gh.repo}` : null });
		}
		return [...seen.values()];
	}

	async function exists(path: string): Promise<boolean> {
		return stat(path).then(() => true, () => false);
	}

	async function status(dir: string): Promise<GitStatus> {
		const now = new Date().toISOString();
		const root = await rootOf(dir);
		if (!root) {
			return { isRepo: false, branch: null, headSha: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [], operation: null, remotes: [], clean: true, lastFetchedAt: null, updatedAt: now };
		}
		const [stOut, gitPaths, remotes] = await Promise.all([
			git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], { cwd: dir }),
			git(["rev-parse", "--git-path", "MERGE_HEAD", "--git-path", "rebase-merge", "--git-path", "rebase-apply", "--git-path", "CHERRY_PICK_HEAD", "--git-path", "REVERT_HEAD", "--git-path", "FETCH_HEAD"], { cwd: dir }),
			remotesOf(dir),
		]);
		const parsed = parseStatusV2(stOut);
		const [merge, rebaseMerge, rebaseApply, cherry, revert, fetchHead] = gitPaths.split("\n").map((p) => resolve(dir, p));
		const flags = await Promise.all([merge, rebaseMerge, rebaseApply, cherry, revert].map((p) => (p ? exists(p) : false)));
		const operation: GitStatus["operation"] = flags[1] || flags[2] ? "rebase" : flags[0] ? "merge" : flags[3] ? "cherry-pick" : flags[4] ? "revert" : null;
		const fh = fetchHead ? await stat(fetchHead).catch(() => null) : null;
		return {
			isRepo: true,
			branch: parsed.branch,
			headSha: parsed.headSha,
			detached: parsed.detached,
			upstream: parsed.upstream,
			ahead: parsed.ahead,
			behind: parsed.behind,
			files: parsed.files,
			operation,
			remotes,
			clean: parsed.files.length === 0,
			lastFetchedAt: fh ? fh.mtime.toISOString() : null,
			updatedAt: now,
		};
	}

	async function countLines(file: string): Promise<number> {
		let n = 0;
		for await (const chunk of createReadStream(file)) for (const byte of chunk as Buffer) if (byte === 10) n++;
		return n;
	}

	async function untrackedDiff(dir: string, q: { path?: string; context: number }): Promise<{ text: string; paths: Set<string>; oversized: DiffFile[]; truncated: boolean }> {
		const listArgs = ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z"];
		if (q.path) listArgs.push("--", q.path);
		const listed = (await git(listArgs, { cwd: dir })).split("\0").filter((p) => p && !p.endsWith("/"));
		const truncated = listed.length > MAX_UNTRACKED_DIFFS;
		const files = listed.slice(0, MAX_UNTRACKED_DIFFS);
		const texts: string[] = new Array(files.length).fill("");
		const oversized: DiffFile[] = [];
		let next = 0;
		const worker = async () => {
			for (;;) {
				const i = next++;
				const file = files[i];
				if (file === undefined) return;
				const r = await gitRun(
					["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", `-U${q.context}`, "--", "/dev/null", file],
					{ cwd: dir, maxStdout: DEFAULT_DIFF_CAPS.maxFileBytes * 2 },
				);
				if (r.truncated) {
					const additions = await countLines(join(dir, file)).catch(() => 0);
					oversized.push({ path: file, oldPath: null, status: "untracked", binary: false, additions, deletions: 0, hunks: [], tooLarge: true, language: languageOf(file) });
					continue;
				}
				if (r.code > 1) continue;
				texts[i] = r.stdout.toString("utf8");
			}
		};
		await Promise.all(Array.from({ length: 8 }, worker));
		oversized.sort((x, y) => (x.path < y.path ? -1 : 1));
		return { text: texts.join(""), paths: new Set(files), oversized, truncated };
	}

	async function diff(dir: string, q: GitDiffQuery): Promise<GitDiff> {
		await ensureRoot(dir);
		const context = q.context ?? 3;
		const scope = q.scope ?? "head";
		const args = ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", `-U${context}`];
		let withUntracked = false;
		switch (scope) {
			case "unstaged":
				withUntracked = true;
				break;
			case "staged":
				args.push("--cached");
				break;
			case "head":
				args.push((await hasHead(dir)) ? "HEAD" : EMPTY_TREE);
				withUntracked = true;
				break;
			case "commit": {
				if (!q.commit) throw new GitEngineError("invalid_ref", "scope=commit requires `commit`");
				const sha = await resolveCommit(dir, q.commit, "commit");
				const parent = await gitRun(["rev-parse", "--verify", "--quiet", `${sha}^1`], { cwd: dir });
				args.push(parent.code === 0 ? parent.stdout.toString("utf8").trim() : EMPTY_TREE, sha);
				break;
			}
			case "range": {
				if (!q.base) throw new GitEngineError("invalid_ref", "scope=range requires `base`");
				const base = await resolveCommit(dir, q.base, "base");
				const head = await resolveCommit(dir, q.head ?? "HEAD", "head");
				args.push(`${base}...${head}`);
				break;
			}
		}
		if (q.path) args.push("--", q.path);
		const r = await gitRun(args, { cwd: dir, maxStdout: DEFAULT_DIFF_CAPS.maxTotalBytes * 4 });
		if (r.code !== 0) throw failure(args, r);
		let text = r.stdout.toString("utf8");
		let truncated = r.truncated;
		let untrackedPaths = new Set<string>();
		let oversized: DiffFile[] = [];
		if (withUntracked && !truncated) {
			const u = await untrackedDiff(dir, { path: q.path, context });
			text += (text && !text.endsWith("\n") ? "\n" : "") + u.text;
			untrackedPaths = u.paths;
			oversized = u.oversized;
			truncated ||= u.truncated;
		}
		const parsed = parsePatch(text, DEFAULT_DIFF_CAPS, r.truncated);
		for (const f of parsed.files) if (f.status === "added" && untrackedPaths.has(f.path)) f.status = "untracked";
		return { files: [...parsed.files, ...oversized], truncated: truncated || parsed.truncated };
	}

	async function branches(dir: string): Promise<GitBranch[]> {
		await ensureRoot(dir);
		const out = await git(["for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads", "refs/remotes"], { cwd: dir });
		return parseBranches(out);
	}

	async function logOne(dir: string, ref: string): Promise<GitCommit> {
		const out = await git(["log", "-z", "-n", "1", "--decorate=short", `--format=${LOG_FORMAT}`, ref, "--"], { cwd: dir });
		const c = parseLog(out)[0];
		if (!c) throw new GitEngineError("invalid_ref", `No commit at ${ref}`);
		return c;
	}

	async function log(dir: string, o: { ref?: string; limit: number; cursor?: string }): Promise<GitLogPage> {
		await ensureRoot(dir);
		const limit = Math.max(1, Math.min(500, Math.floor(o.limit)));
		let tip: string;
		let skip = 0;
		if (o.cursor) {
			const m = /^([0-9a-f]{40,64}):(\d{1,9})$/.exec(o.cursor);
			if (!m) throw new GitEngineError("invalid_ref", "Invalid log cursor");
			tip = m[1] as string;
			skip = Number(m[2]);
		} else if (o.ref) {
			tip = await resolveCommit(dir, o.ref);
		} else {
			if (!(await hasHead(dir))) return { commits: [], nextCursor: null };
			tip = await resolveCommit(dir, "HEAD");
		}
		const args = ["log", "-z", "--decorate=short", `--format=${LOG_FORMAT}`, "-n", String(limit + 1)];
		if (skip > 0) args.push(`--skip=${skip}`);
		args.push(tip, "--");
		const commits = parseLog(await git(args, { cwd: dir }));
		const more = commits.length > limit;
		return { commits: commits.slice(0, limit), nextCursor: more ? `${tip}:${skip + limit}` : null };
	}

	async function createBranch(dir: string, o: { name: string; from?: string; checkout: boolean }): Promise<void> {
		await ensureRoot(dir);
		validateRef(o.name, "branch name");
		const check = await gitRun(["check-ref-format", "--branch", o.name], { cwd: dir });
		if (check.code !== 0) throw new GitEngineError("invalid_ref", `Invalid branch name: ${o.name}`, check.stderr);
		const from = o.from ? validateRef(o.from, "start point") : undefined;
		const exists = await gitRun(["rev-parse", "--verify", "--quiet", `refs/heads/${o.name}`], { cwd: dir });
		if (exists.code === 0) throw new GitEngineError("invalid_ref", `Branch ${o.name} already exists`);
		try {
			if (o.checkout) await git(["switch", "-c", o.name, ...(from ? [from] : [])], { cwd: dir });
			else await git(["branch", o.name, ...(from ? [from] : [])], { cwd: dir });
		} catch (err) {
			mapOperationError(err);
		}
	}

	async function checkout(dir: string, branch: string): Promise<void> {
		await ensureRoot(dir);
		validateRef(branch, "branch");
		const local = await gitRun(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: dir });
		try {
			if (local.code === 0) {
				await git(["switch", branch], { cwd: dir });
				return;
			}
			const remote = await gitRun(["rev-parse", "--verify", "--quiet", `refs/remotes/${branch}`], { cwd: dir });
			if (remote.code === 0 && branch.includes("/")) {
				// `origin/feature` from the branch list → local tracking branch `feature`.
				const localName = branch.slice(branch.indexOf("/") + 1);
				const taken = await gitRun(["rev-parse", "--verify", "--quiet", `refs/heads/${localName}`], { cwd: dir });
				if (taken.code === 0) await git(["switch", localName], { cwd: dir });
				else await git(["switch", "-c", localName, "--track", branch], { cwd: dir });
				return;
			}
			// Bare name that only exists on exactly one remote → git's DWIM creates the tracking branch.
			await git(["switch", "--guess", branch], { cwd: dir });
		} catch (err) {
			mapOperationError(err);
		}
	}

	async function worktreeAdd(dir: string, o: WorktreeAddOptions): Promise<void> {
		await ensureRoot(dir);
		validateRef(o.branch, "branch");
		if (!isAbsolute(o.path) || o.path.includes("\0")) throw new GitEngineError("invalid_ref", `Invalid worktree path: ${JSON.stringify(o.path)}`);
		const check = await gitRun(["check-ref-format", "--branch", o.branch], { cwd: dir });
		if (check.code !== 0) throw new GitEngineError("invalid_ref", `Invalid branch name: ${o.branch}`, check.stderr);
		const startPoint = o.startPoint ? validateRef(o.startPoint, "start point") : undefined;
		const exists = (await gitRun(["rev-parse", "--verify", "--quiet", `refs/heads/${o.branch}`], { cwd: dir })).code === 0;
		if (o.newBranch && exists) throw new GitEngineError("invalid_ref", `Branch ${o.branch} already exists`);
		if (!o.newBranch && !exists) throw new GitEngineError("invalid_ref", `Unknown branch: ${o.branch}`);
		const args = ["worktree", "add"];
		if (o.newBranch) args.push(...(o.track ? ["--track"] : ["--no-track"]), "-b", o.branch, o.path, ...(startPoint ? [startPoint] : []));
		else args.push(o.path, o.branch);
		await mkdir(dirname(o.path), { recursive: true });
		await git(args, { cwd: dir });
	}

	async function worktreeRemove(dir: string, path: string): Promise<void> {
		await ensureRoot(dir);
		try {
			await git(["worktree", "remove", path], { cwd: dir });
		} catch (err) {
			if (err instanceof GitEngineError && err.code === "failed" && /contains modified or untracked files|is dirty|locked|use --force/i.test(err.stderr)) {
				throw new GitEngineError("dirty_worktree", firstMessage(err.stderr) || err.message, err.stderr);
			}
			throw err;
		}
	}

	async function worktreeList(dir: string): Promise<GitWorktree[]> {
		await ensureRoot(dir);
		const out = await git(["worktree", "list", "--porcelain", "-z"], { cwd: dir });
		const entries: GitWorktree[] = [];
		let current: GitWorktree | null = null;
		for (const field of out.split("\0")) {
			if (field === "") {
				if (current) entries.push(current);
				current = null;
				continue;
			}
			const space = field.indexOf(" ");
			const key = space < 0 ? field : field.slice(0, space);
			const value = space < 0 ? "" : field.slice(space + 1);
			if (key === "worktree") current = { path: value, branch: null, headSha: null, prunable: false };
			else if (!current) continue;
			else if (key === "HEAD") current.headSha = /^0+$/.test(value) ? null : value;
			else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
			else if (key === "prunable") current.prunable = true;
		}
		if (current) entries.push(current);
		return entries;
	}

	async function worktreePrune(dir: string): Promise<void> {
		await ensureRoot(dir);
		await git(["worktree", "prune"], { cwd: dir });
	}

	const pathspecStdin = ["--pathspec-from-file=-", "--pathspec-file-nul"];

	async function stage(dir: string, paths: string[]): Promise<void> {
		await ensureRoot(dir);
		const norm = normalizePaths(dir, paths);
		await git(["--literal-pathspecs", "add", "-A", ...pathspecStdin], { cwd: dir, input: nulList(norm) });
	}

	async function unstage(dir: string, paths: string[]): Promise<void> {
		await ensureRoot(dir);
		const norm = normalizePaths(dir, paths);
		if (await hasHead(dir)) {
			await git(["--literal-pathspecs", "restore", "--staged", ...pathspecStdin], { cwd: dir, input: nulList(norm) });
			return;
		}
		for (let i = 0; i < norm.length; i += 500) {
			await git(["--literal-pathspecs", "rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", ...norm.slice(i, i + 500)], { cwd: dir });
		}
	}

	async function removeWorktreePath(root: string, rel: string): Promise<void> {
		const abs = resolve(root, rel);
		const within = relative(root, abs);
		if (!within || within.startsWith("..") || isAbsolute(within) || within.split(sep)[0] === ".git") return;
		const st = await lstat(abs).catch(() => null);
		if (!st || st.isDirectory()) return;
		await rm(abs, { force: true });
	}

	async function discard(dir: string, paths: string[]): Promise<void> {
		await ensureRoot(dir);
		const specs = normalizePaths(dir, paths);
		const st = await status(dir);
		const selected = st.files.filter((f) => pathCovered(f.path, specs));
		const untracked = selected.filter((f) => f.kind === "untracked");
		const newlyAdded = selected.filter((f) => f.kind === "added" || f.kind === "copied" || (f.kind === "renamed" && f.staged));
		const addedPaths = new Set(newlyAdded.map((f) => f.path));
		const restore = new Set<string>();
		for (const f of selected) {
			if (f.kind === "untracked" || addedPaths.has(f.path)) continue;
			restore.add(f.path);
		}
		for (const f of newlyAdded) if (f.kind === "renamed" && f.origPath) restore.add(f.origPath);

		if (newlyAdded.length > 0) {
			const list = newlyAdded.map((f) => f.path);
			for (let i = 0; i < list.length; i += 500) {
				await git(["--literal-pathspecs", "rm", "-f", "--cached", "-q", "--ignore-unmatch", "--", ...list.slice(i, i + 500)], { cwd: dir });
			}
			for (const p of list) await removeWorktreePath(dir, p);
		}
		if (restore.size > 0) {
			await git(["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", ...pathspecStdin], { cwd: dir, input: nulList([...restore]) });
		}
		for (const f of untracked) await removeWorktreePath(dir, f.path);
	}

	async function commit(dir: string, o: { message: string; paths?: string[]; author: { name: string; email: string }; trailers?: Record<string, string> }): Promise<GitCommit> {
		await ensureRoot(dir);
		let message = o.message.replace(/\r\n/g, "\n").trimEnd();
		if (!message.trim() || message.includes("\0")) throw new GitEngineError("failed", "Commit message is empty or invalid");
		if (!o.author.name.trim() || !o.author.email.trim()) throw new GitEngineError("failed", "Commit author name and email are required");
		const trailers = Object.entries(o.trailers ?? {});
		if (trailers.length > 0) {
			const args = ["interpret-trailers", "--no-divider"];
			for (const [k, v] of trailers) {
				if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(k) || /[\r\n\0]/.test(v)) throw new GitEngineError("failed", `Invalid trailer: ${k}`);
				args.push("--trailer", `${k}: ${v}`);
			}
			message = (await git(args, { cwd: dir, input: `${message}\n` })).trimEnd();
		}
		const env = {
			GIT_AUTHOR_NAME: o.author.name,
			GIT_AUTHOR_EMAIL: o.author.email,
			GIT_COMMITTER_NAME: o.author.name,
			GIT_COMMITTER_EMAIL: o.author.email,
		};
		try {
			if (o.paths && o.paths.length > 0) {
				const norm = normalizePaths(dir, o.paths);
				await git(["--literal-pathspecs", "add", "-A", ...pathspecStdin], { cwd: dir, input: nulList(norm) });
				await git(["--literal-pathspecs", "commit", "--only", "-m", message, ...pathspecStdin], { cwd: dir, input: nulList(norm), env });
			} else {
				await git(["commit", "-m", message], { cwd: dir, env });
			}
		} catch (err) {
			mapOperationError(err);
		}
		return logOne(dir, "HEAD");
	}

	async function clone(url: string, dest: string, o: { branch?: string; auth?: GitAuth; onProgress?: (p: GitProgress) => void; signal?: AbortSignal }): Promise<void> {
		if (!url || url.startsWith("-")) throw new GitEngineError("invalid_ref", "Invalid clone URL");
		if (stripUrlCredentials(url) !== url) throw new GitEngineError("failed", "Clone URL must not embed credentials; pass `auth` instead");
		const target = resolve(dest);
		const st = await stat(target).catch(() => null);
		const wasEmptyDir = !!st;
		if (st) {
			if (!st.isDirectory() || (await readdir(target)).length > 0) throw new GitEngineError("dest_not_empty", `${target} already exists and is not an empty directory`);
		}
		await mkdir(dirname(target), { recursive: true });
		const args = ["clone", "--progress"];
		if (o.branch) args.push("--branch", validateRef(o.branch, "branch"));
		args.push("--", url, target);
		try {
			await git(args, {
				cwd: tmpdir(),
				network: true,
				auth: o.auth,
				signal: o.signal,
				onStderrLine: o.onProgress
					? (line) => {
							const p = parseProgress(line);
							if (p) o.onProgress?.(p);
						}
					: undefined,
			});
		} catch (err) {
			// git removes what it created on failure; make sure nothing partial is left behind either way.
			if (wasEmptyDir) {
				for (const entry of await readdir(target).catch(() => [])) await rm(join(target, entry), { recursive: true, force: true });
			} else {
				await rm(target, { recursive: true, force: true });
			}
			throw err;
		}
	}

	async function upstreamRemote(dir: string, branch: string | null, upstreamShort: string | null): Promise<string | null> {
		if (branch) {
			const r = await gitRun(["config", "--get", `branch.${branch}.remote`], { cwd: dir });
			const v = r.stdout.toString("utf8").trim();
			if (r.code === 0 && v) return v;
		}
		return upstreamShort && upstreamShort.includes("/") ? upstreamShort.slice(0, upstreamShort.indexOf("/")) : null;
	}

	async function fetchRemote(dir: string, remote: string, o: { auth?: GitAuth; onProgress?: (p: GitProgress) => void }): Promise<void> {
		validateRef(remote, "remote");
		await git(["fetch", "--progress", "--no-recurse-submodules", remote], {
			cwd: dir,
			network: true,
			auth: o.auth,
			onStderrLine: o.onProgress
				? (line) => {
						const p = parseProgress(line);
						if (p) o.onProgress?.(p);
					}
				: undefined,
		});
	}

	async function fetch(dir: string, o: { remote?: string; auth?: GitAuth; onProgress?: (p: GitProgress) => void }): Promise<void> {
		await ensureRoot(dir);
		let remote = o.remote;
		if (!remote) {
			const st = await status(dir);
			remote = (await upstreamRemote(dir, st.branch, st.upstream)) ?? "origin";
			if (remote === ".") remote = "origin";
		}
		await fetchRemote(dir, remote, o);
	}

	async function aheadBehind(dir: string, ref: string): Promise<{ ahead: number; behind: number }> {
		const out = await git(["rev-list", "--left-right", "--count", `HEAD...${ref}`], { cwd: dir });
		const [a, b] = out.trim().split(/\s+/);
		return { ahead: Number(a ?? 0), behind: Number(b ?? 0) };
	}

	async function incomingPaths(dir: string, range: string[]): Promise<string[]> {
		const r = await gitRun(["diff", "--name-only", "--no-renames", "-z", ...range], { cwd: dir });
		return r.code === 0 ? r.stdout.toString("utf8").split("\0").filter(Boolean) : [];
	}

	function dirtyPathsOf(st: GitStatus): string[] {
		const set = new Set<string>();
		for (const f of st.files) {
			set.add(f.path);
			if (f.origPath) set.add(f.origPath);
		}
		return [...set];
	}

	async function pull(dir: string, o: { auth?: GitAuth }): Promise<Omit<GitPullResult, "status">> {
		await ensureRoot(dir);
		const refuse = (reason: NonNullable<GitPullResult["reason"]>, message: string, paths: string[] = []): Omit<GitPullResult, "status"> => ({ result: "refused", reason, paths, message });
		const st = await status(dir);
		if (st.operation) return refuse("operation-in-progress", `A ${st.operation} is in progress; finish or abort it before pulling.`);
		if (st.detached || !st.branch) return refuse("detached", "HEAD is detached; check out a branch before pulling.");
		if (!st.upstream) return refuse("no-upstream", `Branch ${st.branch} has no upstream branch; push it with --set-upstream first.`);

		const remote = await upstreamRemote(dir, st.branch, st.upstream);
		if (remote && remote !== ".") await fetchRemote(dir, remote, o);

		const up = await gitRun(["rev-parse", "--symbolic-full-name", "@{upstream}"], { cwd: dir });
		const upRef = up.stdout.toString("utf8").trim();
		if (up.code !== 0 || !upRef) return refuse("no-upstream", `Upstream ${st.upstream} of ${st.branch} no longer exists.`);
		const { ahead, behind } = await aheadBehind(dir, upRef);
		if (behind === 0) {
			return { result: "up-to-date", reason: null, paths: [], message: ahead > 0 ? `Already up to date (${ahead} local commit${ahead === 1 ? "" : "s"} not pushed).` : "Already up to date." };
		}
		if (ahead > 0) {
			const report = await conflicts(dir, { against: upRef }).catch(() => null);
			return refuse(
				"diverged",
				`${st.branch} and ${st.upstream} have diverged (${ahead} ahead, ${behind} behind). Pull is fast-forward only; merge or rebase explicitly.`,
				report ? report.conflicts.map((c) => c.path) : [],
			);
		}
		const incoming = await incomingPaths(dir, ["HEAD", upRef]);
		const overlap = [...new Set(dirtyPathsOf(st).filter((d) => incoming.some((i) => pathsClash(d, i))))].sort();
		if (overlap.length > 0) {
			return refuse("dirty-overlap", `Local changes to ${overlap.length} file${overlap.length === 1 ? "" : "s"} would be overwritten by the incoming changes; commit or discard them first.`, overlap);
		}
		const merge = await gitRun(["merge", "--ff-only", "--no-edit", upRef], { cwd: dir });
		if (merge.code !== 0) {
			if (/would be overwritten/i.test(merge.stderr)) {
				const paths = merge.stderr.split("\n").filter((l) => l.startsWith("\t")).map((l) => l.trim());
				return refuse("dirty-overlap", firstMessage(merge.stderr) || "Local changes would be overwritten.", paths);
			}
			throw failure(["merge"], merge);
		}
		return { result: "fast-forward", reason: null, paths: [], message: merge.stdout.toString("utf8").trim() || `Fast-forwarded ${st.branch} to ${upRef}.` };
	}

	function classifyPushRejection(stderr: string): NonNullable<GitPushResult["reason"]> {
		if (/SAML|\bSSO\b|single sign-on/i.test(stderr)) return "sso";
		if (/GH006|GH013|protected branch|Repository rule violations/i.test(stderr)) return "protected-branch";
		if (/fetch first|non-fast-forward|Updates were rejected because|tip of your current branch is behind|\(already exists\)/i.test(stderr)) return "non-fast-forward";
		if (/returned error: 403|Permission to .* denied|permission denied|denied to/i.test(stderr)) return "permission";
		if (/returned error: 401|Authentication failed|Invalid username or password|could not read (?:Username|Password)|terminal prompts disabled/i.test(stderr)) return "auth";
		return "other";
	}

	async function push(dir: string, o: { auth?: GitAuth; setUpstream: boolean }): Promise<Omit<GitPushResult, "status">> {
		await ensureRoot(dir);
		const rejected = (message: string, reason: NonNullable<GitPushResult["reason"]> = "other"): Omit<GitPushResult, "status"> => ({ result: "rejected", reason, message });
		const st = await status(dir);
		if (st.operation) throw new GitEngineError("operation_in_progress", `A ${st.operation} is in progress; finish or abort it before pushing.`);
		if (st.detached || !st.branch) return rejected("HEAD is detached; check out a branch before pushing.");
		if (!st.headSha) return rejected(`Branch ${st.branch} has no commits to push.`);

		let remote = await upstreamRemote(dir, st.branch, st.upstream);
		let remoteRef = `refs/heads/${st.branch}`;
		if (st.upstream) {
			const merge = await gitRun(["config", "--get", `branch.${st.branch}.merge`], { cwd: dir });
			const v = merge.stdout.toString("utf8").trim();
			if (merge.code === 0 && v.startsWith("refs/heads/")) remoteRef = v;
		}
		if (!remote || remote === ".") {
			const remotes = st.remotes.map((r) => r.name);
			remote = remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
		}
		if (!remote) throw new GitEngineError("failed", "No remote is configured for this repository");
		validateRef(remote, "remote");

		const args = ["push", "--porcelain"];
		if (o.setUpstream && !st.upstream) args.push("--set-upstream");
		args.push(remote, `refs/heads/${st.branch}:${remoteRef}`);
		const r = await gitRun(args, { cwd: dir, network: true, auth: o.auth });
		const stderr = r.stderr.trim();
		const lines = r.stdout.toString("utf8").split("\n");
		const refLines = lines.filter((l) => /^[ +\-*=!]\t/.test(l));
		if (r.code === 0) {
			const upToDate = refLines.length > 0 && refLines.every((l) => l.startsWith("="));
			return { result: upToDate ? "up-to-date" : "pushed", reason: null, message: stderr || (upToDate ? "Everything up-to-date" : "Pushed.") };
		}
		const classified = classifyFailure(stderr);
		if (refLines.length === 0 && (classified === "network" || classified === "not_a_repo")) throw failure(args, r);
		// `--porcelain` puts the per-ref verdict ("[rejected] (fetch first)") on stdout; keep it in the message and classify over both.
		const verdicts = refLines.filter((l) => l.startsWith("!")).map((l) => l.split("\t").join(" ").trim());
		const message = [...verdicts, stderr].filter(Boolean).join("\n") || `git push failed (exit ${r.code})`;
		return rejected(message, classifyPushRejection(message));
	}

	async function conflicts(dir: string, o: { against?: string }): Promise<GitConflictReport> {
		await ensureRoot(dir);
		let againstLabel = o.against;
		let target: string;
		if (againstLabel) {
			target = await resolveCommit(dir, againstLabel, "ref");
		} else {
			const up = await gitRun(["rev-parse", "--symbolic-full-name", "@{upstream}"], { cwd: dir });
			const full = up.stdout.toString("utf8").trim();
			if (up.code !== 0 || !full) throw new GitEngineError("invalid_ref", "The current branch has no upstream to compare against", up.stderr);
			againstLabel = (await git(["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: dir })).trim() || full;
			target = await resolveCommit(dir, full, "upstream");
		}
		const { ahead, behind } = await aheadBehind(dir, target);
		const mt = await gitRun(["merge-tree", "--write-tree", "--name-only", "-z", "HEAD", target], { cwd: dir });
		if (mt.code > 1) throw failure(["merge-tree"], mt);
		const conflictList = mt.code === 1 ? parseMergeTree(mt.stdout.toString("utf8")) : [];
		const st = await status(dir);
		const incoming = await incomingPaths(dir, [`HEAD...${target}`]);
		const dirtyOverlap = [...new Set(dirtyPathsOf(st).filter((d) => incoming.some((i) => pathsClash(d, i))))].sort();
		return { against: againstLabel, ahead, behind, clean: conflictList.length === 0, conflicts: conflictList, dirtyOverlap };
	}

	async function configIdentity(dir: string): Promise<{ name: string; email: string } | null> {
		await ensureRoot(dir);
		const [n, e] = await Promise.all([gitRun(["config", "--get", "user.name"], { cwd: dir }), gitRun(["config", "--get", "user.email"], { cwd: dir })]);
		const name = n.stdout.toString("utf8").trim();
		const email = e.stdout.toString("utf8").trim();
		return n.code === 0 && e.code === 0 && name && email ? { name, email } : null;
	}

	async function githubRemote(dir: string): Promise<{ owner: string; repo: string } | null> {
		await ensureRoot(dir);
		const remotes = await remotesOf(dir);
		const ordered = [...remotes.filter((r) => r.name === "origin"), ...remotes.filter((r) => r.name !== "origin")];
		for (const r of ordered) {
			const gh = parseGithubUrl(r.url);
			if (gh) return gh;
		}
		return null;
	}

	async function formatPatch(dir: string, o: { base: string; head?: string }): Promise<{ patch: Buffer; commits: number }> {
		await ensureRoot(dir);
		const base = await resolveCommit(dir, o.base, "base");
		const head = await resolveCommit(dir, o.head ?? "HEAD", "head");
		const range = `${base}..${head}`;
		const count = Number((await git(["rev-list", "--count", range], { cwd: dir })).trim());
		if (!Number.isInteger(count) || count < 0) throw new GitEngineError("failed", "could not count commits in range");
		if (count === 0) return { patch: Buffer.alloc(0), commits: 0 };
		const args = ["format-patch", "--stdout", "--binary", "--no-color", range];
		const r = await gitRun(args, { cwd: dir, maxStdout: MAX_PATCH_BYTES });
		if (r.truncated) throw new GitEngineError("failed", "patch exceeds the size cap");
		if (r.code !== 0) throw failure(args, r);
		return { patch: r.stdout, commits: count };
	}

	return {
		version: async () => ver.replace(/^git version\s+/, ""),
		isRepo: async (dir) => (await rootOf(dir)) !== null,
		status,
		diff,
		branches,
		log,
		createBranch,
		worktreeAdd,
		worktreeRemove,
		worktreeList,
		worktreePrune,
		checkout,
		stage,
		unstage,
		discard,
		commit,
		clone,
		fetch,
		pull,
		push,
		conflicts,
		configIdentity,
		githubRemote,
		formatPatch,
		dispose: () => broker.close(),
	};
}

function firstMessage(stderr: string): string {
	return stderr.trim().split("\n").slice(0, 8).join("\n");
}

/** Parses `merge-tree --write-tree --name-only -z`: `<tree>\0<file>\0…\0\0(<n>\0<path>…\0<type>\0<message>\0)*`. */
export function parseMergeTree(raw: string): Array<{ path: string; type: string }> {
	const parts = raw.split("\0");
	let i = 1; // skip the tree id
	const files: string[] = [];
	while (i < parts.length && parts[i] !== "") files.push(parts[i++] as string);
	i++; // blank separator
	const types = new Map<string, string>();
	while (i < parts.length) {
		const count = Number(parts[i++]);
		if (!Number.isInteger(count)) break;
		const paths = parts.slice(i, i + count);
		i += count;
		const kind = parts[i++] ?? "";
		i++; // message
		const m = /^CONFLICT \((.+)\)$/.exec(kind);
		if (!m) continue;
		const type = (m[1] as string) === "contents" ? "content" : (m[1] as string);
		for (const p of paths) if (!types.has(p)) types.set(p, type);
	}
	return files.map((path) => ({ path, type: types.get(path) ?? "content" }));
}
