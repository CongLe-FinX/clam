import { z } from "zod";
import { IsoDate } from "./common.ts";
import type { Project } from "./workspace.ts";

// ---------------------------------------------------------------- status

export const GitFileKind = z.enum(["modified", "added", "deleted", "renamed", "copied", "typechange", "untracked", "conflicted"]);
export type GitFileKind = z.infer<typeof GitFileKind>;

export const GitFileStatus = z.object({
	/** Project-relative, POSIX separators. */
	path: z.string(),
	/** Previous path for renames/copies. */
	origPath: z.string().nullable(),
	kind: GitFileKind,
	/** Has changes in the index (staged). */
	staged: z.boolean(),
	/** Has changes in the working tree not yet staged (incl. untracked). */
	unstaged: z.boolean(),
});
export type GitFileStatus = z.infer<typeof GitFileStatus>;

export const GitRemote = z.object({
	name: z.string(),
	/** Credential-free URL (any userinfo stripped). */
	url: z.string(),
	/** `owner/repo` when the remote is on github.com. */
	github: z.string().nullable(),
});
export type GitRemote = z.infer<typeof GitRemote>;

export const GitStatus = z.object({
	isRepo: z.boolean(),
	/** Current branch; null when detached or not a repo. */
	branch: z.string().nullable(),
	headSha: z.string().nullable(),
	detached: z.boolean(),
	/** e.g. `origin/main`; null when the branch has no upstream. */
	upstream: z.string().nullable(),
	ahead: z.number().int(),
	behind: z.number().int(),
	files: z.array(GitFileStatus),
	/** In-progress operation that needs the user's attention. */
	operation: z.enum(["merge", "rebase", "cherry-pick", "revert"]).nullable(),
	remotes: z.array(GitRemote),
	clean: z.boolean(),
	lastFetchedAt: IsoDate.nullable(),
	updatedAt: IsoDate,
});
export type GitStatus = z.infer<typeof GitStatus>;

// ---------------------------------------------------------------- refs & history

export const GitBranch = z.object({
	name: z.string(),
	/** `refs/heads/x` → false; `refs/remotes/origin/x` → true. */
	remote: z.boolean(),
	current: z.boolean(),
	upstream: z.string().nullable(),
	ahead: z.number().int().nullable(),
	behind: z.number().int().nullable(),
	headSha: z.string(),
	subject: z.string(),
	committedAt: IsoDate,
});
export type GitBranch = z.infer<typeof GitBranch>;

export const GitCommit = z.object({
	sha: z.string(),
	shortSha: z.string(),
	subject: z.string(),
	body: z.string(),
	authorName: z.string(),
	authorEmail: z.string(),
	authoredAt: IsoDate,
	parents: z.array(z.string()),
	/** Parsed trailers, e.g. `{ "Agent": "OMP Agent@my-mac" }`. */
	trailers: z.record(z.string(), z.string()),
	/** Decorations (branch/tag names pointing here). */
	refs: z.array(z.string()),
});
export type GitCommit = z.infer<typeof GitCommit>;

export const GitLogPage = z.object({ commits: z.array(GitCommit), nextCursor: z.string().nullable() });
export type GitLogPage = z.infer<typeof GitLogPage>;

// ---------------------------------------------------------------- diff

export const DiffLine = z.object({
	type: z.enum(["context", "add", "del", "meta"]),
	content: z.string(),
	oldNo: z.number().int().nullable(),
	newNo: z.number().int().nullable(),
});
export type DiffLine = z.infer<typeof DiffLine>;

export const DiffHunk = z.object({
	header: z.string(),
	oldStart: z.number().int(),
	oldLines: z.number().int(),
	newStart: z.number().int(),
	newLines: z.number().int(),
	lines: z.array(DiffLine),
});
export type DiffHunk = z.infer<typeof DiffHunk>;

export const DiffFile = z.object({
	path: z.string(),
	oldPath: z.string().nullable(),
	status: z.enum(["modified", "added", "deleted", "renamed", "copied", "typechange", "untracked"]),
	binary: z.boolean(),
	additions: z.number().int(),
	deletions: z.number().int(),
	hunks: z.array(DiffHunk),
	/** Hunks omitted because the file diff exceeded the per-file cap. */
	tooLarge: z.boolean(),
	language: z.string().nullable(),
});
export type DiffFile = z.infer<typeof DiffFile>;

export const GitDiff = z.object({
	files: z.array(DiffFile),
	/** Files omitted because the whole diff exceeded the total cap. */
	truncated: z.boolean(),
});
export type GitDiff = z.infer<typeof GitDiff>;

export const GitDiffQuery = z.object({
	/** unstaged = worktree vs index (incl. untracked) · staged = index vs HEAD · head = worktree vs HEAD · commit = commit vs its first parent · range = base...head */
	scope: z.enum(["unstaged", "staged", "head", "commit", "range"]).default("head"),
	commit: z.string().optional(),
	base: z.string().optional(),
	head: z.string().optional(),
	/** Limit to one project-relative path. */
	path: z.string().optional(),
	context: z.coerce.number().int().min(0).max(50).default(3),
});
export type GitDiffQuery = z.infer<typeof GitDiffQuery>;

// ---------------------------------------------------------------- operations

export const GitPathsBody = z.object({ paths: z.array(z.string().min(1)).min(1).max(5000) });
/** Destructive: discards working-tree changes of the given paths. Requires an explicit UI confirmation. */
export const GitDiscardBody = GitPathsBody.extend({ confirm: z.literal(true) });

export const GitCommitBody = z.object({
	message: z.string().trim().min(1).max(20_000),
	/** Stage exactly these paths before committing; omit to commit what is staged. */
	paths: z.array(z.string().min(1)).max(5000).optional(),
	/** Adds an `Agent: <name>@<node>` trailer when the commit is made on behalf of an agent session. */
	sessionId: z.string().optional(),
});

export const GitCreateBranchBody = z.object({
	name: z.string().trim().min(1).max(200),
	/** Start point (branch, tag or sha); defaults to HEAD. */
	from: z.string().optional(),
	checkout: z.boolean().default(true),
});
export const GitCheckoutBody = z.object({ branch: z.string().min(1) });
export const GitPushBody = z.object({
	/** Set upstream `origin/<branch>` when the branch has none. */
	setUpstream: z.boolean().default(true),
});

export const GitPullResult = z.object({
	result: z.enum(["fast-forward", "up-to-date", "refused"]),
	/** Why a pull was refused. Nothing in the working tree was changed when refused. */
	reason: z.enum(["dirty-overlap", "diverged", "no-upstream", "operation-in-progress", "detached"]).nullable(),
	/** Local paths that block the pull (dirty-overlap) or would conflict (diverged). */
	paths: z.array(z.string()),
	message: z.string(),
	status: GitStatus,
});
export type GitPullResult = z.infer<typeof GitPullResult>;

export const GitPushResult = z.object({
	result: z.enum(["pushed", "up-to-date", "rejected"]),
	reason: z.enum(["non-fast-forward", "protected-branch", "permission", "sso", "auth", "other"]).nullable(),
	/** Remote's own message, verbatim (credentials scrubbed). */
	message: z.string(),
	status: GitStatus,
});
export type GitPushResult = z.infer<typeof GitPushResult>;

export const GitConflictReport = z.object({
	/** Ref compared against (default: the upstream). */
	against: z.string(),
	ahead: z.number().int(),
	behind: z.number().int(),
	/** Result of a dry-run `git merge-tree`; the working tree is never touched. */
	clean: z.boolean(),
	conflicts: z.array(z.object({ path: z.string(), type: z.string() })),
	/** Uncommitted local paths also changed upstream (a pull would be refused). */
	dirtyOverlap: z.array(z.string()),
});
export type GitConflictReport = z.infer<typeof GitConflictReport>;

export const GitIdentity = z.object({
	name: z.string(),
	email: z.string(),
	/** `account` = derived from the linked GitHub account; `project` = overridden for this project; `git-config` = the repo's own git config. */
	source: z.enum(["account", "project", "git-config"]),
});
export type GitIdentity = z.infer<typeof GitIdentity>;
export const SetGitIdentityBody = z.object({ name: z.string().trim().min(1), email: z.string().trim().email() }).nullable();

// ---------------------------------------------------------------- clone

export const CloneProjectBody = z.object({
	workspaceId: z.string().min(1),
	accountId: z.string().min(1),
	owner: z.string().min(1),
	repo: z.string().min(1),
	/** Absolute target directory; must not exist or be empty. Default suggested by the UI: `~/clam/<owner>/<repo>`. */
	path: z.string().min(1),
	name: z.string().trim().min(1).max(80).optional(),
	branch: z.string().optional(),
});

export const GitOperationState = z.enum(["running", "succeeded", "failed"]);
export const GitOperation = z.object({
	id: z.string(),
	kind: z.enum(["clone", "fetch", "pull", "push"]),
	state: GitOperationState,
	/** Git's progress phase, e.g. "Receiving objects". */
	phase: z.string().nullable(),
	percent: z.number().min(0).max(100).nullable(),
	error: z.string().nullable(),
	/** Set when a clone succeeded. */
	projectId: z.string().nullable(),
	startedAt: IsoDate,
	finishedAt: IsoDate.nullable(),
});
export type GitOperation = z.infer<typeof GitOperation>;

// ---------------------------------------------------------------- pull requests

export const PullRequest = z.object({
	number: z.number().int(),
	title: z.string(),
	body: z.string(),
	state: z.enum(["open", "closed", "merged"]),
	draft: z.boolean(),
	htmlUrl: z.string(),
	head: z.string(),
	base: z.string(),
	author: z.string(),
	/** null while GitHub is still computing it. */
	mergeable: z.boolean().nullable(),
	/** Combined check/status state of the head commit, when readable. */
	checks: z.enum(["pending", "success", "failure", "neutral"]).nullable(),
	createdAt: IsoDate,
	updatedAt: IsoDate,
});
export type PullRequest = z.infer<typeof PullRequest>;

export const CreatePullRequestBody = z.object({
	title: z.string().trim().min(1).max(256),
	body: z.string().max(65_536).default(""),
	base: z.string().min(1),
	/** Defaults to the current branch (must be pushed). */
	head: z.string().optional(),
	draft: z.boolean().default(false),
});

// ---------------------------------------------------------------- .clmesh

export const ClmeshInitResult = z.object({
	/** Project-relative paths written (not committed). */
	written: z.array(z.string()),
	/** Paths that already existed and were left untouched. */
	skipped: z.array(z.string()),
	status: GitStatus,
});
export type ClmeshInitResult = z.infer<typeof ClmeshInitResult>;

/** Events on topic `git:<projectId>`. */
export type GitEvent =
	| { type: "status"; status: GitStatus }
	| { type: "operation"; operation: GitOperation };

/** Events on topic `git-op:<operationId>` (clone progress before a project exists). */
export type GitOperationEvent = { type: "operation"; operation: GitOperation; project?: Project };
