import { type FileEntry, routes } from "@clam/contracts";
import * as D from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Terminal } from "lucide-react";
import { type KeyboardEvent, useMemo } from "react";
import { t } from "@/i18n";
import { api } from "@/lib/api";
import { qk } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { DialogOverlay } from "@/ui/dialog";
import { GrabHandle } from "@/ui/grab-handle";
import { Tip } from "@/ui/tooltip";
import { byKindThenName, parentOf } from "./file-utils.ts";
import { FileViewer } from "./file-viewer.tsx";

export interface QuickLookProps {
	projectId: string;
	/** Project-relative path of the open file. */
	path: string;
	/** Switch to another file of the same folder (previous / next). */
	onNavigate: (path: string) => void;
	onClose: () => void;
}

/** Keys that mean something to the focused control itself: arrows must not flip files while typing or scrubbing media. */
function ownsArrows(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|VIDEO|AUDIO|IFRAME)$/.test(target.tagName);
}

/**
 * Quick Look: the one place files open. A large centered sheet over whatever page is showing (full-screen on a phone, with a grab
 * handle that dismisses on a downward drag). Focus is trapped and Esc closes (Radix). ← / → step through the files of the
 * current folder. It exists only while a file is open: nothing takes layout space the rest of the time.
 */
export default function QuickLook({ projectId, path, onNavigate, onClose }: QuickLookProps) {
	const dir = parentOf(path);
	const listing = useQuery({
		queryKey: qk.projectFiles(projectId, dir),
		queryFn: ({ signal }) => api.get<FileEntry[]>(routes.projectFiles(projectId), { path: dir }, { signal }),
	});
	const siblings = useMemo(() => (listing.data ? listing.data.filter((e) => e.kind !== "dir").sort(byKindThenName) : []), [listing.data]);
	const index = siblings.findIndex((e) => e.path === path);
	const prev = index > 0 ? siblings[index - 1] : undefined;
	const next = index >= 0 ? siblings[index + 1] : undefined;
	const name = path.split("/").at(-1) ?? path;

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || ownsArrows(e.target)) return;
		const to = e.key === "ArrowLeft" ? prev : e.key === "ArrowRight" ? next : undefined;
		if (!to) return;
		e.preventDefault();
		onNavigate(to.path);
	};

	const actions = (
		<>
			{siblings.length > 1 && index >= 0 ? (
				<span className="hidden shrink-0 font-mono text-2xs text-subtle tabular sm:inline" aria-live="polite">
					{index + 1} / {siblings.length}
				</span>
			) : null}
			<Tip label={t("Previous file")} shortcut="←">
				<Button variant="ghost" size="icon-sm" aria-label={t("Previous file")} disabled={!prev} onClick={() => prev && onNavigate(prev.path)}>
					<ChevronLeft />
				</Button>
			</Tip>
			<Tip label={t("Next file")} shortcut="→">
				<Button variant="ghost" size="icon-sm" aria-label={t("Next file")} disabled={!next} onClick={() => next && onNavigate(next.path)}>
					<ChevronRight />
				</Button>
			</Tip>
			<Tip label={t("Open terminal here")}>
				<Button asChild variant="ghost" size="icon-sm" aria-label={t("Open terminal here")} className="hidden sm:inline-flex">
					<Link to="/terminal" search={{ project: projectId }}>
						<Terminal />
					</Link>
				</Button>
			</Tip>
		</>
	);

	return (
		<D.Root open onOpenChange={(o) => !o && onClose()}>
			<D.Portal>
				<DialogOverlay className="bg-[var(--scrim)] backdrop-blur-[3px]" />
				<D.Content
					aria-describedby={undefined}
					onKeyDown={onKeyDown}
					// Focus the sheet itself so ← / → work at once and no toolbar tooltip pops open.
					onOpenAutoFocus={(e) => {
						e.preventDefault();
						(e.currentTarget as HTMLElement).focus({ preventScroll: true });
					}}
					className={cn(
						"clam-dialog clam-dialog-sheet fixed z-[61] flex flex-col overflow-hidden bg-overlay shadow-pop outline-none",
						"sm:left-1/2 sm:top-1/2 sm:h-[88dvh] sm:w-[min(1100px,92vw)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:shadow-pop sm:shadow-[inset_0_0_0_1px_var(--border-strong)]",
						"max-sm:inset-0 max-sm:h-[100dvh] max-sm:rounded-none max-sm:pt-safe max-sm:pb-safe",
					)}
				>
					<D.Title className="sr-only">{name}</D.Title>
					<GrabHandle onClose={onClose} className="mt-0 h-6 sm:hidden" />
					<FileViewer key={path} projectId={projectId} path={path} onClose={onClose} actions={actions} className="min-h-0 flex-1" />
				</D.Content>
			</D.Portal>
		</D.Root>
	);
}
