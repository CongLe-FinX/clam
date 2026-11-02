import type { AgentSession, GitFileStatus, TurnOutputFile } from "@clam/contracts";
import { X } from "lucide-react";
import { t, tr } from "@/i18n";
import { KIND_LABEL, KIND_LETTER, KIND_TONE } from "@/features/git/status-utils.ts";
import { fileIcon } from "@/features/projects/file-utils.ts";
import { FileExplorer } from "@/features/projects/file-explorer.tsx";
import { cn, relativeTime } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/ui/sheet";

/** Newest changes shown above the tree; the full list is one filter away in the tree itself. */
const RECENT_MAX = 6;

function RecentFile({ file, onOpen }: { file: TurnOutputFile; onOpen: (path: string) => void }) {
	const { Icon, tone } = fileIcon(file.name);
	const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
	return (
		<li>
			<button
				type="button"
				onClick={() => onOpen(file.path)}
				title={file.path}
				className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] coarse:min-h-12"
			>
				<Icon aria-hidden className={cn("size-4 shrink-0", tone)} />
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate text-[13px]">{file.name}</span>
					<span className="truncate font-mono text-2xs text-subtle">{dir ? `${dir} · ` : ""}{relativeTime(new Date(file.modifiedAt).toISOString())}</span>
				</span>
				<span className={cn("shrink-0 rounded px-1.5 py-px text-2xs font-medium", file.change === "created" ? "bg-success/14 text-success" : "bg-accent-soft text-accent")}>
					{file.change === "created" ? t("New") : t("Edited")}
				</span>
			</button>
		</li>
	);
}

/** One uncommitted change of the folder (git status): a deleted file has nothing left to open. */
function GitChange({ file, onOpen }: { file: GitFileStatus; onOpen: (path: string) => void }) {
	const { Icon, tone } = fileIcon(file.path);
	const slash = file.path.lastIndexOf("/");
	const name = slash < 0 ? file.path : file.path.slice(slash + 1);
	const dir = slash < 0 ? "" : file.path.slice(0, slash);
	const gone = file.kind === "deleted";
	return (
		<li>
			<button
				type="button"
				disabled={gone}
				onClick={() => onOpen(file.path)}
				title={`${tr(KIND_LABEL[file.kind])}: ${file.path}`}
				className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] disabled:hover:bg-transparent coarse:min-h-12"
			>
				<Icon aria-hidden className={cn("size-4 shrink-0", tone)} />
				<span className="flex min-w-0 flex-1 flex-col">
					<span className={cn("truncate text-[13px]", gone && "text-subtle line-through")}>{name}</span>
					{dir ? <span className="truncate font-mono text-2xs text-subtle">{dir}</span> : null}
				</span>
				<span aria-label={tr(KIND_LABEL[file.kind])} className={cn("w-4 shrink-0 text-center font-mono text-xs font-semibold", KIND_TONE[file.kind])}>
					{KIND_LETTER[file.kind]}
				</span>
			</button>
		</li>
	);
}

/**
 * The session's Files drawer: above the folder tree, the folder's uncommitted git changes (a git project) or what the agent changed in this
 * session (a plain folder, newest first). A modal drawer from the right (bottom sheet on a phone), closed by default. Opening a file shows it
 * in Quick Look over the chat; the drawer stays underneath.
 */
export default function SessionFiles({
	session,
	changed,
	gitFiles,
	open,
	onOpenChange,
	mobile,
	selectedPath,
	onOpenFile,
}: {
	session: AgentSession;
	changed: readonly TurnOutputFile[];
	/** The folder's git status files; `null` when the folder is not a git repository (or its status is not known yet). */
	gitFiles: readonly GitFileStatus[] | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mobile: boolean;
	selectedPath: string | null;
	onOpenFile: (path: string) => void;
}) {
	const recent = changed.slice(0, RECENT_MAX);
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side={mobile ? "bottom" : "right"} className={cn("p-0", mobile ? "h-[82dvh]" : "w-[min(92vw,380px)]")} aria-describedby={undefined}>
				<div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
					<SheetTitle className="flex-1">{t("Files")}</SheetTitle>
					<SheetDescription className="sr-only">{t("Files the agent changed in this session and the session folder.")}</SheetDescription>
					<SheetClose asChild>
						<Button variant="ghost" size="icon-sm" aria-label={t("Close")}>
							<X />
						</Button>
					</SheetClose>
				</div>
				{gitFiles ? (
					gitFiles.length > 0 ? (
						<section aria-label={t("Uncommitted changes")} className="shrink-0 border-b p-1.5">
							<h3 className="px-2.5 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-wide text-subtle">
								{t("Uncommitted changes")}
								<span className="tabular ml-1.5 text-subtle">{gitFiles.length}</span>
							</h3>
							<ul className="flex max-h-[34dvh] flex-col gap-0.5 overflow-y-auto overscroll-contain scrollbar-thin">
								{gitFiles.map((f) => (
									<GitChange key={f.path} file={f} onOpen={onOpenFile} />
								))}
							</ul>
						</section>
					) : null
				) : recent.length > 0 ? (
					<section aria-label={t("Changed in this session")} className="shrink-0 border-b p-1.5">
						<h3 className="px-2.5 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-wide text-subtle">
							{t("Changed in this session")}
							<span className="tabular ml-1.5 text-subtle">{changed.length}</span>
						</h3>
						<ul className="flex max-h-[34dvh] flex-col gap-0.5 overflow-y-auto overscroll-contain scrollbar-thin">
							{recent.map((f) => (
								<RecentFile key={f.path} file={f} onOpen={onOpenFile} />
							))}
						</ul>
					</section>
				) : null}
				<div className="min-h-0 flex-1">
					<FileExplorer projectId={session.checkoutId} selectedPath={selectedPath} onOpenFile={onOpenFile} className="h-full" />
				</div>
			</SheetContent>
		</Sheet>
	);
}
