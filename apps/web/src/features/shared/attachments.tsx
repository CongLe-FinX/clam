import { ATTACHMENT_MAX_BYTES, type FileEntry, routes, type SharedAttachment } from "@clam/contracts";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, FileArchive, FileAudio, FileImage, FileText, FileVideo, FolderInput, Paperclip, X } from "lucide-react";
import { type ComponentType, memo, useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { FileStrip } from "@/components/rich/file-strip.tsx";
import { FileTile } from "@/components/rich/file-tile.tsx";
import { attachmentFile } from "@/components/rich/assets.ts";
import { api, errorMessage, localUrl } from "@/lib/api";
import { previewKind, type PreviewKind } from "@/lib/file-kind";
import { useProjects } from "@/lib/queries";
import { isAbort, type UploadHandle, uploadFile } from "@/lib/upload";
import { cn, formatBytes } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Field } from "@/ui/field";
import { Input } from "@/ui/input";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Progress } from "@/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";

// ───────────────────────────── uploads (composer side) ─────────────────────────────

export interface PendingAttachment {
	id: number;
	file: File;
	sent: number;
	status: "uploading" | "ready" | "error";
	attachment?: SharedAttachment;
	error?: string;
}

export interface AttachmentUploads {
	items: PendingAttachment[];
	add(files: File[]): void;
	cancel(id: number): void;
	clear(): void;
	/** Uploads still in flight: sending is held until they finish so the message carries every file. */
	busy: boolean;
	ready: SharedAttachment[];
}

/** Uploads files for the group composer in parallel, each with progress and cancel. Ready files are referenced by id when the message posts. */
export function useAttachmentUploads(sharedId: string): AttachmentUploads {
	const [items, setItems] = useState<PendingAttachment[]>([]);
	const handles = useRef(new Map<number, UploadHandle<SharedAttachment>>());
	const seq = useRef(0);

	const patch = useCallback((id: number, p: Partial<PendingAttachment>) => setItems((all) => all.map((i) => (i.id === id ? { ...i, ...p } : i))), []);

	const add = useCallback(
		(files: File[]) => {
			for (const file of files) {
				const id = ++seq.current;
				if (file.size > ATTACHMENT_MAX_BYTES) {
					setItems((all) => [...all, { id, file, sent: 0, status: "error", error: `Larger than ${formatBytes(ATTACHMENT_MAX_BYTES)}` }]);
					continue;
				}
				setItems((all) => [...all, { id, file, sent: 0, status: "uploading" }]);
				const handle = uploadFile<SharedAttachment>(localUrl(routes.sharedAttachmentUpload(sharedId), { name: file.name }), file, (sent) => patch(id, { sent }));
				handles.current.set(id, handle);
				handle.promise
					.then((attachment) => patch(id, { status: "ready", attachment, sent: file.size }))
					.catch((e) => {
						if (isAbort(e)) setItems((all) => all.filter((i) => i.id !== id));
						else patch(id, { status: "error", error: errorMessage(e) });
					})
					.finally(() => handles.current.delete(id));
			}
		},
		[sharedId, patch],
	);

	const cancel = useCallback((id: number) => {
		const h = handles.current.get(id);
		if (h) h.abort();
		else setItems((all) => all.filter((i) => i.id !== id));
	}, []);

	const clear = useCallback(() => {
		for (const h of handles.current.values()) h.abort();
		setItems([]);
	}, []);

	return {
		items,
		add,
		cancel,
		clear,
		busy: items.some((i) => i.status === "uploading"),
		ready: items.flatMap((i) => (i.status === "ready" && i.attachment ? [i.attachment] : [])),
	};
}

/** Files waiting to be sent with the next message. */
export function AttachmentTray({ uploads, className }: { uploads: AttachmentUploads; className?: string }) {
	if (uploads.items.length === 0) return null;
	return (
		<ul aria-label="Files to send" className={cn("scrollbar-none mb-2 flex gap-2 overflow-x-auto", className)}>
			{uploads.items.map((i) => (
				<li key={i.id} className="flex w-52 shrink-0 flex-col gap-1.5 rounded-lg bg-surface-2 p-2 text-xs shadow-[inset_0_0_0_1px_var(--border)]">
					<div className="flex items-center gap-1.5">
						{i.status === "error" ? <AlertCircle className="size-3.5 shrink-0 text-danger" aria-hidden /> : <KindIcon kind={previewKind(i.file.name, i.file.type)} className="size-3.5 shrink-0 text-accent" />}
						<span className="min-w-0 flex-1 truncate" title={i.file.name}>
							{i.file.name}
						</span>
						<button
							type="button"
							aria-label={i.status === "uploading" ? `Cancel upload of ${i.file.name}` : `Remove ${i.file.name}`}
							onClick={() => uploads.cancel(i.id)}
							className="grid size-5 shrink-0 place-items-center rounded text-subtle outline-none hover:bg-surface-3 hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:size-11"
						>
							<X className="size-3" />
						</button>
					</div>
					{i.status === "uploading" ? <Progress value={i.file.size ? (i.sent / i.file.size) * 100 : 0} /> : null}
					<span className={cn("tabular text-2xs", i.status === "error" ? "text-danger" : "text-subtle")}>
						{i.status === "uploading" ? `${formatBytes(i.sent)} / ${formatBytes(i.file.size)}` : i.status === "error" ? (i.error ?? "Upload failed") : `${formatBytes(i.file.size)} · ready`}
					</span>
				</li>
			))}
		</ul>
	);
}

/** Paperclip button + hidden multi-file input. */
export function AttachButton({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<Button variant="ghost" size="lg" aria-label="Attach files" disabled={disabled} onClick={() => input.current?.click()} className="shrink-0 px-3 coarse:min-h-12 coarse:min-w-12">
				<Paperclip />
			</Button>
			<input
				ref={input}
				type="file"
				multiple
				hidden
				onChange={(e) => {
					onFiles(Array.from(e.target.files ?? []));
					e.target.value = "";
				}}
			/>
		</>
	);
}

// ───────────────────────────── timeline cards ─────────────────────────────

const KIND_ICON: Record<PreviewKind, ComponentType<{ className?: string }>> = { image: FileImage, video: FileVideo, audio: FileAudio, pdf: FileText, text: FileText, other: FileArchive };

function KindIcon({ kind, className }: { kind: PreviewKind; className?: string }) {
	const Icon = KIND_ICON[kind];
	return <Icon className={className} aria-hidden />;
}

/**
 * The files of one group message: a single file is a tile (thumbnail / player / PDF card / typed card), several are a strip. Bytes missing
 * on this machine show a fetching state and are pulled from a member when opened. `hidden` lists attachments the message text embeds inline.
 */
export const AttachmentCards = memo(function AttachmentCards({ sharedId, attachments, hidden, align = "start" }: { sharedId: string; attachments: readonly SharedAttachment[]; hidden?: ReadonlySet<string>; align?: "start" | "end" }) {
	const [saving, setSaving] = useState<SharedAttachment | null>(null);
	const files = useMemo(() => attachments.filter((a) => !hidden?.has(a.id)).map((a) => attachmentFile(sharedId, a)), [sharedId, attachments, hidden]);
	if (attachments.length === 0) return null;
	return (
		<div data-attachments className={cn("flex w-full max-w-[min(100%,36rem)] flex-col gap-1.5", align === "end" ? "items-end" : "items-start")}>
			{files.length === 1 && files[0] ? <FileTile file={files[0]} className="w-full" /> : null}
			{files.length > 1 ? <FileStrip files={files} title="Shared files" className="w-full" /> : null}
			<SaveMenu attachments={attachments} onPick={setSaving} />
			{saving ? <SaveToProjectDialog sharedId={sharedId} attachment={saving} onClose={() => setSaving(null)} /> : null}
		</div>
	);
});

/** Copies a shared file into a project folder on this machine (always visible: it is the one action a touch screen cannot hover for). */
function SaveMenu({ attachments, onPick }: { attachments: readonly SharedAttachment[]; onPick: (a: SharedAttachment) => void }) {
	const trigger = "inline-flex items-center gap-1 rounded text-2xs text-subtle outline-none hover:text-foreground focus-visible:text-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:min-h-11";
	if (attachments.length === 1 && attachments[0]) {
		const only = attachments[0];
		return (
			<button type="button" className={trigger} onClick={() => onPick(only)}>
				<FolderInput className="size-3" aria-hidden /> Save to project…
			</button>
		);
	}
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button type="button" className={trigger}>
					<FolderInput className="size-3" aria-hidden /> Save to project…
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="flex w-72 flex-col gap-0.5 p-1">
				{attachments.map((a) => (
					<PopoverClose key={a.id} asChild>
						<button type="button" onClick={() => onPick(a)} className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] outline-none hover:bg-surface-2 focus-visible:bg-surface-2 coarse:min-h-11">
							<KindIcon kind={previewKind(a.name, a.mimeType)} className="size-3.5 shrink-0 text-accent" />
							<span className="min-w-0 flex-1 truncate" title={a.name}>
								{a.name}
							</span>
							<span className="tabular shrink-0 text-2xs text-subtle">{formatBytes(a.size)}</span>
						</button>
					</PopoverClose>
				))}
			</PopoverContent>
		</Popover>
	);
}

// ───────────────────────────── save to project ─────────────────────────────

function SaveToProjectDialog({ sharedId, attachment, onClose }: { sharedId: string; attachment: SharedAttachment; onClose: () => void }) {
	const projects = useProjects();
	const [projectId, setProjectId] = useState("");
	const [path, setPath] = useState("");
	const chosen = projectId || projects.data?.[0]?.id || "";
	const save = useMutation({
		mutationFn: () => api.post<FileEntry>(routes.sharedAttachmentSave(sharedId, attachment.id), { projectId: chosen, path: path.trim() || undefined }),
		onSuccess: (f) => {
			toast.success(`Saved ${attachment.name}`, { description: `${projects.data?.find((p) => p.id === chosen)?.name ?? "Project"} · ${f.path}` });
			onClose();
		},
	});
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent sheetOnMobile>
				<DialogHeader>
					<DialogTitle>Save to project</DialogTitle>
					<DialogDescription>
						Copies <span className="font-mono">{attachment.name}</span> ({formatBytes(attachment.size)}) into a project folder on this machine. An existing file is never overwritten.
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(e) => {
						e.preventDefault();
						if (chosen) save.mutate();
					}}
				>
					<Field label="Project">
						{() => (
							<Select value={chosen} onValueChange={setProjectId}>
								<SelectTrigger>
									<SelectValue placeholder={projects.data?.length === 0 ? "No projects yet" : "Select project"} />
								</SelectTrigger>
								<SelectContent>
									{projects.data?.map((p) => (
										<SelectItem key={p.id} value={p.id}>
											{p.name}
											{p.origin === "chat" ? " · chat" : ""}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					</Field>
					<Field label="Path in the project" hint={`Optional — defaults to attachments/${attachment.name}`} error={save.error ? errorMessage(save.error) : null}>
						{(id) => <Input id={id} value={path} onChange={(e) => setPath(e.target.value)} placeholder={`attachments/${attachment.name}`} className="font-mono" />}
					</Field>
					<DialogFooter>
						<Button variant="ghost" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" loading={save.isPending} disabled={!chosen}>
							<FolderInput /> Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
