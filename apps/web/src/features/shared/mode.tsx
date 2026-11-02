import type { Checkpoint, Project, SharedSession } from "@clam/contracts";
import { Folder, FolderSync, GitBranch, GitCommitHorizontal, Info } from "lucide-react";
import { type Msg, msg, t, tr } from "@/i18n";
import { cn, formatBytes } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Tip } from "@/ui/tooltip";
import { commitUrl, repoLabel, shortCommit } from "./format.ts";

export type ShareMode = SharedSession["vcs"];

export const FILES_INFO = msg("The working folder travels machine to machine as a bundle together with the session snapshot; nothing needs a Git repository.");

/** How a project's work would travel when shared: a linked repository means a shared branch, anything else is folder sync. */
export const projectShareMode = (p: Pick<Project, "repository">): ShareMode => (p.repository ? "git" : "files");

export const shortSha = (sha: string): string => sha.slice(0, 8);

/** Info button with the explanation of folder sync; a popover so it also works by tap and keyboard. */
export function FilesInfoButton({ className }: { className?: string }) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={t("About folder sync")}
					className={cn("inline-grid size-5 shrink-0 place-items-center rounded-full text-subtle outline-none hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:size-8", className)}
				>
					<Info className="size-3.5" aria-hidden />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-64 text-xs text-muted-foreground">
				<strong className="mb-1 block text-[13px] text-foreground">{t("Folder sync")}</strong>
				{tr(FILES_INFO)}
			</PopoverContent>
		</Popover>
	);
}

/** How the shared session moves its files, as one icon (branch or folder sync); the details open on hover, tap or Enter. */
export function ModeIcon({ vcs, repo }: { vcs: ShareMode; repo: SharedSession["repo"] }) {
	const branch = vcs === "git" ? repo?.branch : undefined;
	const git = branch !== undefined;
	const label = git ? t("Git branch {branch}", { branch }) : t("Folder sync · no repository");
	const Icon = git ? GitBranch : FolderSync;
	return (
		<Popover>
			<Tip label={label}>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label={label}
						className="grid size-7 shrink-0 place-items-center rounded-lg text-subtle outline-none hover:bg-surface-2 hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:size-11"
					>
						<Icon className="size-3.5" aria-hidden />
					</button>
				</PopoverTrigger>
			</Tip>
			<PopoverContent align="end" className="w-72 text-xs text-muted-foreground">
				<ModeLabel vcs={vcs} repo={repo} className="mb-1.5 flex-wrap" />
				<p>{git ? t("Checkpoints commit the lead's work to this branch and push it.") : tr(FILES_INFO)}</p>
			</PopoverContent>
		</Popover>
	);
}

/**
 * How a shared session moves its files: `Git branch · repo · branch`, or `Folder sync · no repository` with an info tooltip.
 * `interactive` renders a tappable info button (use it outside links/buttons); otherwise a hover tooltip on the label.
 */
export function ModeLabel({ vcs, repo, interactive = false, withRepo = true, className }: { vcs: ShareMode; repo: SharedSession["repo"]; interactive?: boolean; withRepo?: boolean; className?: string }) {
	if (vcs === "git" && repo) {
		return (
			<span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
				<GitBranch className="size-3.5 shrink-0 text-subtle" aria-hidden />
				<span className="shrink-0">{t("Git branch")}</span>
				{withRepo ? <code className="min-w-0 max-w-[14rem] truncate font-mono text-foreground">{repoLabel(repo.url)}</code> : null}
				<code className="min-w-0 max-w-[14rem] truncate font-mono text-foreground">{withRepo ? `· ${repo.branch}` : repo.branch}</code>
			</span>
		);
	}
	const label = (
		<span className={cn("inline-flex items-center gap-1.5", className)}>
			<FolderSync className="size-3.5 shrink-0 text-subtle" aria-hidden />
			<span>{t("Folder sync · no repository")}</span>
			{interactive ? null : <span className="sr-only">{tr(FILES_INFO)}</span>}
		</span>
	);
	if (interactive) {
		return (
			<span className="inline-flex items-center gap-0.5">
				{label}
				<FilesInfoButton />
			</span>
		);
	}
	return <Tip label={tr(FILES_INFO)}>{label}</Tip>;
}

/** What a checkpoint holds, per mode: git commit (linked when the repo is on GitHub), the files bundle (count, size, short sha), or nothing. */
export function CheckpointFacts({ shared, c, className }: { shared: Pick<SharedSession, "repo">; c: Checkpoint; className?: string }) {
	if (c.files) {
		return (
			<span className={cn("inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5", className)} title={t("Folder bundle sha256 {sha}", { sha: c.files.sha256 })}>
				<Folder className="size-3.5 shrink-0 text-subtle" aria-hidden />
				<span>
					{t("{count, plural, one {# file} other {# files}}", { count: c.files.fileCount })} · {formatBytes(c.files.size)}
				</span>
				<span className="font-mono text-subtle">{shortSha(c.files.sha256)}</span>
			</span>
		);
	}
	if (c.commit) {
		const url = shared.repo ? commitUrl(shared.repo.url, c.commit) : null;
		return (
			<span className={cn("inline-flex items-center gap-1 font-mono", className)}>
				<GitCommitHorizontal className="size-3.5 shrink-0 text-subtle" aria-hidden />
				{url ? (
					<a href={url} target="_blank" rel="noreferrer noopener" className="hover:text-foreground hover:underline">
						{shortCommit(c.commit)}
					</a>
				) : (
					shortCommit(c.commit)
				)}
			</span>
		);
	}
	return <span className={cn("text-subtle", className)}>{t("No file changes")}</span>;
}

// ───────────────────────────── copy ─────────────────────────────

export const HANDOVER_INTRO: Record<ShareMode | "unknown", Msg> = {
	git: msg("Stop here and let an agent on another machine continue the work. Everything this session changed is committed and pushed to a shared branch first — nothing is lost — and this session becomes a read-only copy that links to the new one."),
	files: msg("Stop here and let an agent on another machine continue the work. The current working folder is bundled and sent with the session snapshot — nothing needs a Git repository — and this session becomes a read-only copy that links to the new one."),
	unknown: msg("Stop here and let an agent on another machine continue the work. Everything this session changed is saved and sent to it first, and this session becomes a read-only copy that links to the new one."),
};

export const HANDOVER_SEMANTICS: Record<ShareMode, Msg> = {
	git: msg("The shared branch is pushed and the next driver continues from the pushed commit."),
	files: msg("The current working folder is bundled and sent with the session snapshot. The receiver applies it into a local folder (a managed folder is created for you, or pick an existing local folder) — files that differ locally are reported, never silently overwritten."),
};

export const TAKEOVER_SEMANTICS: Record<ShareMode, Msg> = {
	git: msg("The shared branch is checked out at the last checkpoint and the next driver continues from the pushed commit."),
	files: msg("The current working folder is bundled and sent with the session snapshot; the receiver applies it into a local folder (a managed folder is created for you, or pick an existing local folder) — files that differ locally are reported, never silently overwritten. Takeover continues from the last checkpoint's folder state; work done after it is lost."),
};

/** The short explanation of what travels and how it lands, shown in hand-over / takeover / invite dialogs. */
export function ModeNote({ mode, copy, className }: { mode: ShareMode; copy: Partial<Record<ShareMode, Msg>>; className?: string }) {
	const Icon = mode === "git" ? GitBranch : FolderSync;
	return (
		<p className={cn("flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-xs text-muted-foreground", className)}>
			<Icon className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
			<span>
				<strong className="font-medium text-foreground">{mode === "git" ? t("Git branch") : t("Folder sync")}.</strong> {copy[mode] ? tr(copy[mode]) : null}
			</span>
		</p>
	);
}
