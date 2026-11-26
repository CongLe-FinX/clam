import { type FileEntry, routes } from "@clam/contracts";
import { AtSign, Copy, Folder, GripVertical, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import {
	type DragEvent as ReactDragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { t } from "@/i18n";
import { api, errorText, localUrl } from "@/lib/api";
import { uploadFile } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { Kbd } from "@/ui/kbd";
import { fileIcon, parentOf } from "./file-utils.ts";

/**
 * What the Files views (the folder tree, the folder list of a project's Files tab) do to the project's files: create, rename, move and
 * delete entries, the right-click menu, and dragging an entry onto a folder — with a mouse (HTML drag and drop), or on a touch screen by
 * the grip a row shows while "drag to move" is on.
 */

export type NewKind = "file" | "dir";

/** Creates an empty file or a folder (its parent folders too). Returns the error to show, or null. */
export async function createEntry(projectId: string, kind: NewKind, path: string): Promise<string | null> {
	try {
		if (kind === "dir") await api.post<FileEntry>(routes.projectFolder(projectId), { path });
		else await uploadFile<FileEntry>(localUrl(routes.projectUpload(projectId), { path }), new File([""], path.slice(path.lastIndexOf("/") + 1))).promise;
		return null;
	} catch (e) {
		return errorText(e);
	}
}

/** Moves or renames an entry (never over another one). Returns the error to show, or null. */
export async function moveEntry(projectId: string, from: string, to: string): Promise<string | null> {
	try {
		await api.post<FileEntry>(routes.projectMove(projectId), { from, to });
		return null;
	} catch (e) {
		return errorText(e);
	}
}

const MAC = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform);
/** Shown beside "Delete" in the menu. */
const DELETE_KEY_LABEL = MAC ? "⌘⌫" : "Del";

/** The key that deletes the focused row: Delete, or ⌘⌫ on a Mac (whose keyboards often have no Delete key), as in Finder and VS Code. */
export function isDeleteKey(e: ReactKeyboardEvent): boolean {
	return e.key === "Delete" || (MAC && e.key === "Backspace" && e.metaKey);
}

/**
 * Deleting an entry: `ask` opens a confirmation (nothing goes to a trash, so it cannot be undone), confirming deletes it on the server
 * and then runs `onDeleted`, for the view to drop what pointed into it (open folders, the selection). Render `dialog`.
 */
export function useEntryDelete(projectId: string, onDeleted: (path: string) => void) {
	const [target, setTarget] = useState<{ path: string; dir: boolean } | null>(null);
	const [busy, setBusy] = useState(false);
	const name = target ? target.path.slice(target.path.lastIndexOf("/") + 1) : "";
	const confirm = async () => {
		if (!target) return;
		setBusy(true);
		try {
			await api.delete(routes.projectFiles(projectId), { path: target.path });
			toast.success(t("Deleted {name}", { name }));
			setTarget(null);
			onDeleted(target.path);
		} catch (e) {
			toast.error(t("Could not delete {name}", { name }), { description: errorText(e) });
		} finally {
			setBusy(false);
		}
	};
	const dialog = (
		<ConfirmDialog
			open={target !== null}
			onOpenChange={(open) => {
				if (!open && !busy) setTarget(null);
			}}
			title={target?.dir ? t("Delete the folder {name}?", { name }) : t("Delete {name}?", { name })}
			description={target?.dir ? t("The folder and everything in it are deleted from the project folder. This cannot be undone.") : t("The file is deleted from the project folder. This cannot be undone.")}
			confirmLabel={t("Delete")}
			danger
			loading={busy}
			onConfirm={() => void confirm()}
		/>
	);
	return { ask: setTarget, dialog };
}

/** Why a name cannot be a new file or folder here, or null. A `/` inside makes folders (`docs/notes.md`); the server confines the path. */
function nameProblem(name: string, taken: ReadonlySet<string>, kind: NewKind): string | null {
	const shape = kind === "dir" ? t("Use a folder name like assets or docs/assets") : t("Use a file name like notes.md or docs/notes.md");
	if (!name) return kind === "dir" ? t("Type a name for the folder") : t("Type a name for the file");
	if (name.startsWith("/") || name.endsWith("/") || name.includes("\\")) return shape;
	if (name.split("/").some((part) => part === "" || part === "." || part === "..")) return shape;
	if (taken.has(name.split("/")[0] as string) && !name.includes("/")) return t("{name} already exists here", { name });
	return null;
}

/**
 * The name box of a new file or folder, or of one being renamed, VS Code style: Enter saves, Esc cancels, leaving the box with a valid
 * name saves too; a rename starts with the name selected up to its extension. Problems show right under the box without moving the
 * rows around it. The icon follows the typed name.
 */
export function NameInput({
	kind,
	initial = "",
	label,
	taken,
	onSubmit,
	onCancel,
	icon = true,
	className,
	inputClassName,
}: {
	kind: NewKind;
	/** The current name, when renaming. */
	initial?: string;
	label: string;
	/** Names already used in the folder (the entry's own name excluded). */
	taken: ReadonlySet<string>;
	onSubmit: (name: string) => Promise<string | null>;
	onCancel: () => void;
	icon?: boolean;
	className?: string;
	inputClassName?: string;
}) {
	const [name, setName] = useState(initial);
	const [error, setError] = useState<string | null>(null);
	const busy = useRef(false);
	/**
	 * Set once the box is done (Esc, or saved). The host may move the focus away while closing it (back to the tree), and the blur that
	 * follows must not save what Esc dropped, or save the same name a second time.
	 */
	const closed = useRef(false);
	const input = useRef<HTMLInputElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: select once, when the box opens
	useEffect(() => {
		const dot = initial.lastIndexOf(".");
		input.current?.setSelectionRange(0, kind === "file" && dot > 0 ? dot : initial.length);
	}, []);
	const submit = async (fromBlur: boolean) => {
		if (busy.current || closed.current) return;
		const value = name.trim();
		if ((!value && fromBlur) || (initial && value === initial)) return onCancel();
		const problem = nameProblem(value, taken, kind);
		if (problem) {
			if (fromBlur) return onCancel();
			return setError(problem);
		}
		busy.current = true;
		const failed = await onSubmit(value);
		busy.current = false;
		if (failed) setError(failed);
		else closed.current = true;
	};
	const { Icon, tone } = kind === "dir" ? { Icon: Folder, tone: "text-muted-foreground" } : fileIcon(name.trim() || "file");
	return (
		<div className={cn("relative flex min-w-0 flex-1 items-center gap-1.5", className)}>
			{icon ? <Icon aria-hidden className={cn("size-4 shrink-0", tone)} /> : null}
			<input
				ref={input}
				// biome-ignore lint/a11y/noAutofocus: the box exists only because the person just asked to name a file or folder
				autoFocus
				value={name}
				spellCheck={false}
				autoCapitalize="off"
				autoCorrect="off"
				aria-label={label}
				aria-invalid={error !== null}
				onChange={(e) => {
					setName(e.target.value);
					setError(null);
				}}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => {
					// Every key belongs to the box: the view's own arrow / Enter handling must not see them.
					e.stopPropagation();
					if (e.key === "Enter") {
						e.preventDefault();
						void submit(false);
					} else if (e.key === "Escape") {
						e.preventDefault();
						closed.current = true;
						onCancel();
					}
				}}
				onBlur={() => void submit(true)}
				placeholder={kind === "dir" ? t("Folder name, e.g. assets") : t("File name, e.g. notes.md")}
				className={cn(
					"h-6 min-w-0 flex-1 rounded bg-background px-1.5 font-mono text-base outline-none shadow-[inset_0_0_0_1px_var(--accent)] placeholder:font-sans placeholder:text-subtle md:text-xs coarse:h-8",
					error && "shadow-[inset_0_0_0_1px_var(--danger)]",
					inputClassName,
				)}
			/>
			{error ? (
				<div role="alert" className={cn("absolute right-0 top-full z-10 mt-0.5 animate-fade-in rounded-md bg-danger px-2 py-1 text-2xs font-medium text-white shadow-pop", icon ? "left-[22px]" : "left-0")}>
					{error}
				</div>
			) : null}
		</div>
	);
}

// ───────────────────────────── right-click menu ─────────────────────────────

export interface MenuTarget {
	path: string;
	dir: boolean;
	x: number;
	y: number;
}

/** "Add to chat": what the host does with a file or folder (a mention in its composer, or a new chat that starts with it). */
export interface EntryReference {
	label: string;
	onSelect: (path: string, dir: boolean) => void;
}

/** The entry a right-click (or the menu key) is about: the row under the pointer, else `focused` (the menu key on a focused view). */
export function menuTargetOf(e: ReactMouseEvent, focused: HTMLElement | null): MenuTarget | null {
	const pointed = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-path]") : null;
	const el = pointed ?? focused?.closest<HTMLElement>("[data-path]") ?? null;
	const path = el?.dataset.path;
	if (!el || !path) return null;
	const box = el.getBoundingClientRect();
	return { path, dir: el.dataset.kind === "dir", x: pointed ? e.clientX : box.left + 24, y: pointed ? e.clientY : box.bottom };
}

/** The "⋯" of a row on a touch screen, where there is no right-click: the menu opens under it. */
export function MenuButton({ path, dir, name, onOpen, className }: { path: string; dir: boolean; name: string; onOpen: (target: MenuTarget) => void; className?: string }) {
	return (
		<button
			type="button"
			aria-label={t("Actions for {name}", { name })}
			onClick={(e) => {
				e.stopPropagation();
				const box = e.currentTarget.getBoundingClientRect();
				onOpen({ path, dir, x: box.left, y: box.bottom });
			}}
			className={cn("grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground outline-none active:bg-surface-3", className)}
		>
			<MoreHorizontal aria-hidden className="size-4" />
		</button>
	);
}

/** The menu of a file or folder: Add to chat (when the host offers it), Rename, Copy path, Delete. Mount it while `target` is set. */
export function EntryMenu({
	target,
	reference,
	onRename,
	onDelete,
	onClose,
}: {
	target: MenuTarget;
	reference?: EntryReference;
	onRename: (path: string) => void;
	onDelete: (entry: { path: string; dir: boolean }) => void;
	onClose: () => void;
}) {
	// What an item does once the menu has closed: while it is open the menu holds the focus, so a name box or a composer could not take it.
	const after = useRef<(() => void) | null>(null);
	return (
		<DropdownMenu
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			{/* The anchor lives in <body>: a containing ancestor of the view would otherwise re-base `fixed` and push the menu off screen. */}
			{createPortal(
				<DropdownMenuTrigger asChild>
					<span aria-hidden className="pointer-events-none fixed size-0" style={{ left: target.x, top: target.y }} />
				</DropdownMenuTrigger>,
				document.body,
			)}
			<DropdownMenuContent
				align="start"
				sideOffset={2}
				onCloseAutoFocus={(e) => {
					e.preventDefault();
					after.current?.();
					after.current = null;
				}}
				className="min-w-48"
			>
				{reference ? (
					<>
						<DropdownMenuItem onSelect={() => (after.current = () => reference.onSelect(target.path, target.dir))}>
							<AtSign /> {reference.label}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
					</>
				) : null}
				<DropdownMenuItem onSelect={() => (after.current = () => onRename(target.path))}>
					<Pencil /> {t("Rename")}
					<Kbd className="ml-auto coarse:hidden">F2</Kbd>
				</DropdownMenuItem>
				<DropdownMenuItem
					onSelect={() => {
						void navigator.clipboard.writeText(target.path).then(
							() => toast.success(t("Path copied")),
							(e: unknown) => toast.error(errorText(e)),
						);
					}}
				>
					<Copy /> {t("Copy path")}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem danger onSelect={() => (after.current = () => onDelete({ path: target.path, dir: target.dir }))}>
					<Trash2 /> {t("Delete")}
					<Kbd className="ml-auto coarse:hidden">{DELETE_KEY_LABEL}</Kbd>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// ───────────────────────────── drag to move ─────────────────────────────

interface Dragged {
	projectId: string;
	path: string;
	kind: FileEntry["kind"];
}

/** The entry being dragged, shared by the views of a page: a row of the folder list can be dropped on the tree, and back. */
let dragged: Dragged | null = null;

const HOLD_MS = 600;
const EDGE_PX = 48;

/**
 * Drag an entry onto a folder to move it there. A view marks its rows with `data-path` / `data-kind` (what can be dragged) and the
 * places a drop lands in with `data-drop-dir` (a folder row: itself; a file row: its folder; the view's background: the folder it
 * shows), and spreads `dropProps` on its container. A mouse uses HTML drag and drop on rows with `draggable`; a touch screen drags by a
 * row's grip (`startTouch` on pointer down), which never steals the list's scrolling. `onHold` runs when a drag rests on a row (the
 * tree opens a closed folder), `scrollRef` scrolls when a touch drag nears its top or bottom edge.
 */
export function useEntryDrag({
	projectId,
	onMove,
	onHold,
	scrollRef,
}: {
	projectId: string;
	onMove: (from: string, kind: FileEntry["kind"], dir: string) => void;
	onHold?: (row: HTMLElement) => void;
	scrollRef: RefObject<HTMLElement | null>;
}) {
	const [moving, setMoving] = useState<string | null>(null);
	const [dropDir, setDropDir] = useState<string | null>(null);
	const [ghost, setGhost] = useState<{ x: number; y: number; name: string; kind: FileEntry["kind"] } | null>(null);
	const hold = useRef<{ row: HTMLElement; timer: number } | null>(null);
	const latest = useRef({ projectId, onMove, onHold });
	latest.current = { projectId, onMove, onHold };

	/** Where the dragged entry lands under `el`, or null where it cannot go (where it already is, into itself, another project). */
	const targetAt = useCallback((el: Element | null): string | null => {
		const src = dragged;
		if (!src || src.projectId !== latest.current.projectId) return null;
		const zone = el?.closest<HTMLElement>("[data-drop-dir]");
		if (!zone) return null;
		const dir = zone.dataset.dropDir ?? "";
		if (dir === parentOf(src.path)) return null;
		if (src.kind === "dir" && (dir === src.path || dir.startsWith(`${src.path}/`))) return null;
		return dir;
	}, []);
	const holdOn = useCallback((el: Element | null) => {
		const row = el?.closest<HTMLElement>("[data-path]") ?? null;
		if (row === hold.current?.row) return;
		if (hold.current) window.clearTimeout(hold.current.timer);
		hold.current = null;
		const onHold = latest.current.onHold;
		if (row && onHold) hold.current = { row, timer: window.setTimeout(() => onHold(row), HOLD_MS) };
	}, []);
	const end = useCallback(() => {
		if (hold.current) window.clearTimeout(hold.current.timer);
		hold.current = null;
		dragged = null;
		setMoving(null);
		setDropDir(null);
		setGhost(null);
	}, []);
	const drop = useCallback(
		(dir: string | null) => {
			const src = dragged;
			end();
			if (src && dir !== null) latest.current.onMove(src.path, src.kind, dir);
		},
		[end],
	);
	useEffect(() => end, [end]);

	const dropProps = {
		onDragStart: (e: ReactDragEvent) => {
			const row = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-path]") : null;
			const path = row?.dataset.path;
			if (!row || !path) return;
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", path);
			dragged = { projectId, path, kind: (row.dataset.kind ?? "file") as FileEntry["kind"] };
			setMoving(path);
		},
		onDragOver: (e: ReactDragEvent) => {
			if (!dragged) return;
			const dir = targetAt(e.target as Element);
			setDropDir(dir);
			holdOn(e.target as Element);
			if (dir === null) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
		},
		onDragLeave: (e: ReactDragEvent) => {
			if (!dragged || (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) return;
			holdOn(null);
			setDropDir(null);
		},
		onDrop: (e: ReactDragEvent) => {
			if (!dragged) return;
			const dir = targetAt(e.target as Element);
			if (dir === null) return;
			e.preventDefault();
			drop(dir);
		},
		onDragEnd: end,
	};

	/** Pointer down on a row's grip: past a few pixels the row follows the finger; letting go over a folder moves it there. */
	const startTouch = useCallback(
		(e: ReactPointerEvent, entry: { path: string; kind: FileEntry["kind"]; name: string }) => {
			e.preventDefault();
			e.stopPropagation();
			const from = { x: e.clientX, y: e.clientY };
			let last = from;
			let started = false;
			let frame = 0;
			// Near the top or bottom edge the view scrolls, and what is under the finger changes with it.
			const scroll = () => {
				const view = scrollRef.current;
				if (view && started) {
					const box = view.getBoundingClientRect();
					const step = last.y < box.top + EDGE_PX ? -8 : last.y > box.bottom - EDGE_PX ? 8 : 0;
					if (step) {
						view.scrollTop += step;
						setDropDir(targetAt(document.elementFromPoint(last.x, last.y)));
					}
				}
				frame = requestAnimationFrame(scroll);
			};
			const move = (ev: PointerEvent) => {
				last = { x: ev.clientX, y: ev.clientY };
				if (!started) {
					if (Math.hypot(last.x - from.x, last.y - from.y) < 6) return;
					started = true;
					dragged = { projectId: latest.current.projectId, path: entry.path, kind: entry.kind };
					setMoving(entry.path);
					navigator.vibrate?.(8);
				}
				const el = document.elementFromPoint(last.x, last.y);
				setGhost({ x: last.x, y: last.y, name: entry.name, kind: entry.kind });
				setDropDir(targetAt(el));
				holdOn(el);
			};
			const stop = (ev: PointerEvent) => {
				removeEventListener("pointermove", move);
				removeEventListener("pointerup", stop);
				removeEventListener("pointercancel", stop);
				cancelAnimationFrame(frame);
				if (started && ev.type === "pointerup") drop(targetAt(document.elementFromPoint(ev.clientX, ev.clientY)));
				else end();
			};
			addEventListener("pointermove", move);
			addEventListener("pointerup", stop);
			addEventListener("pointercancel", stop);
			frame = requestAnimationFrame(scroll);
		},
		[drop, end, holdOn, scrollRef, targetAt],
	);

	const ghostEl: ReactNode = ghost
		? createPortal(<DragGhost name={ghost.name} dir={ghost.kind === "dir"} x={ghost.x} y={ghost.y} />, document.body)
		: null;
	return { moving, dropDir, dropProps, startTouch, ghost: ghostEl };
}

/** What follows the finger during a touch drag. */
function DragGhost({ name, dir, x, y }: { name: string; dir: boolean; x: number; y: number }) {
	const { Icon, tone } = dir ? { Icon: Folder, tone: "text-accent" } : fileIcon(name);
	return (
		<div aria-hidden className="pointer-events-none fixed left-0 top-0 z-[80] flex max-w-60 items-center gap-1.5 rounded-lg bg-overlay px-2.5 py-1.5 text-[13px] shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)]" style={{ transform: `translate(${x + 14}px, ${y - 36}px)` }}>
			<Icon className={cn("size-4 shrink-0", tone)} />
			<span className="truncate">{name}</span>
		</div>
	);
}

/** The grip of a row while "drag to move" is on (touch screens): only it starts a drag, the rest of the row still scrolls the list. */
export function DragGrip({ name, onPointerDown, className }: { name: string; onPointerDown: (e: ReactPointerEvent) => void; className?: string }) {
	return (
		<span
			role="img"
			aria-label={t("Drag {name} to move it", { name })}
			onPointerDown={onPointerDown}
			onClick={(e) => e.stopPropagation()}
			className={cn("grid size-9 shrink-0 touch-none place-items-center rounded-md text-muted-foreground active:bg-surface-3", className)}
		>
			<GripVertical aria-hidden className="size-4" />
		</span>
	);
}

/** Whether this device's main pointer is a finger: no right-click, no HTML drag and drop. */
export const coarsePointer = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
