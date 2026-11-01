import { ATTACHMENT_MAX_BYTES, type FileEntry, routes, type SharedAttachment } from "@clam/contracts";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, FileArchive, FileAudio, FileImage, FileText, FileVideo, FolderInput, Paperclip, X } from "lucide-react";
import { type ComponentType, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { type ChipModel, ComposerChips } from "@/components/composer/chips.tsx";
import { FileStrip } from "@/components/rich/file-strip.tsx";
import { FileTile } from "@/components/rich/file-tile.tsx";
import { attachmentFile } from "@/components/rich/assets.ts";
import { T, t } from "@/i18n";
import { api, errorText, localUrl } from "@/lib/api";
import { readDraft, type DraftFile } from "@/lib/draft-store.ts";
import { previewKind, type PreviewKind } from "@/lib/file-kind";
import { imageBudgetBytes, isVisionImage, prepareImage, thumbnail } from "@/lib/image-prep.ts";
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
	name: string;
	size: number;
	type: string;
	kind: "image" | "file";
	sent: number;
	status: "uploading" | "ready" | "error";
	attachment?: SharedAttachment;
	error?: string;
	/** Object URL or data URL of a picture. */
	preview?: string;
	/** Small preview kept in the draft. */
	thumb?: string;
}

export interface AttachmentUploads {
	items: PendingAttachment[];
	chips: ChipModel[];
	add(files: File[]): void;
	cancel(id: number): void;
	retry(id: number): void;
	clear(): void;
	/** Uploads still in flight: sending is held until they finish so the message carries every file. */
	busy: boolean;
	/** Uploads that failed: sending is held until they are retried or removed, so a file is never silently left out. */
	failed: number;
	ready: SharedAttachment[];
	/** What a draft keeps of the files that are already uploaded. */
	draftFiles: DraftFile[];
}

/** Longest a picture may be to go to the agents' models as it is; a bigger one is scaled down before it is uploaded (the server hands pictures to the model within the prompt's size cap). */
const GROUP_IMAGE_BUDGET = imageBudgetBytes(1);

const isPicture = (type: string, name: string): boolean => type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp|heic|svg)$/i.test(name);
const renameExt = (name: string, mime: string): string => `${name.replace(/\.[^./]*$/, "")}.${mime === "image/webp" ? "webp" : mime === "image/jpeg" ? "jpg" : (mime.split("/")[1] ?? "bin")}`;

/**
 * Uploads files for the group composer in parallel, each with progress, cancel and retry. Ready files are referenced by id when the
 * message posts; a big picture is scaled down first so the agents' models can take it. Files already uploaded come back from the
 * draft after a reload.
 */
export function useAttachmentUploads(sharedId: string): AttachmentUploads {
	const [items, setItems] = useState<PendingAttachment[]>(() =>
		readDraft("group", sharedId).files.flatMap<PendingAttachment>((f, i) => {
			const attachment = f.meta as SharedAttachment | undefined;
			return attachment?.id ? [{ id: -(i + 1), name: f.name, size: f.size, type: f.type, kind: f.kind, sent: f.size, status: "ready", attachment, ...(f.thumb ? { preview: f.thumb, thumb: f.thumb } : {}) }] : [];
		}),
	);
	const ref = useRef(items);
	ref.current = items;
	const handles = useRef(new Map<number, UploadHandle<SharedAttachment>>());
	const sources = useRef(new Map<number, File>());
	const cancelled = useRef(new Set<number>());
	const seq = useRef(0);

	const patch = useCallback((id: number, p: Partial<PendingAttachment>) => setItems((all) => all.map((i) => (i.id === id ? { ...i, ...p } : i))), []);

	const upload = useCallback(
		(id: number, file: File) => {
			patch(id, { status: "uploading", sent: 0, error: undefined });
			const handle = uploadFile<SharedAttachment>(localUrl(routes.sharedAttachmentUpload(sharedId), { name: file.name }), file, (sent) => patch(id, { sent }));
			handles.current.set(id, handle);
			handle.promise
				.then((attachment) => patch(id, { status: "ready", attachment, sent: file.size }))
				.catch((e) => {
					if (isAbort(e)) setItems((all) => all.filter((i) => i.id !== id));
					else patch(id, { status: "error", error: errorText(e) });
				})
				.finally(() => handles.current.delete(id));
		},
		[sharedId, patch],
	);

	const start = useCallback(
		async (id: number, original: File) => {
			let file = original;
			if (isVisionImage(original) && original.size > GROUP_IMAGE_BUDGET) {
				const prepared = await prepareImage(original, GROUP_IMAGE_BUDGET).catch(() => null);
				if (cancelled.current.delete(id)) return;
				if (prepared?.resized) {
					file = new File([prepared.blob], renameExt(original.name, prepared.mimeType), { type: prepared.mimeType });
					patch(id, { name: file.name, size: file.size, type: file.type });
				}
			}
			sources.current.set(id, file);
			upload(id, file);
		},
		[patch, upload],
	);

	const add = useCallback(
		(files: File[]) => {
			for (const file of files) {
				const id = ++seq.current;
				const picture = isPicture(file.type, file.name);
				const base: PendingAttachment = { id, name: file.name, size: file.size, type: file.type || "application/octet-stream", kind: picture ? "image" : "file", sent: 0, status: "uploading", ...(picture ? { preview: URL.createObjectURL(file) } : {}) };
				if (file.size > ATTACHMENT_MAX_BYTES) {
					setItems((all) => [...all, { ...base, status: "error", error: t("Larger than {size}", { size: formatBytes(ATTACHMENT_MAX_BYTES) }) }]);
					continue;
				}
				setItems((all) => [...all, base]);
				void start(id, file);
				if (picture) void thumbnail(file).then((thumb) => thumb && patch(id, { thumb }));
			}
		},
		[start, patch],
	);

	const release = (item: PendingAttachment | undefined) => {
		if (item?.preview?.startsWith("blob:")) URL.revokeObjectURL(item.preview);
	};

	const cancel = useCallback((id: number) => {
		const h = handles.current.get(id);
		if (h) h.abort();
		else {
			cancelled.current.add(id);
			setItems((all) => all.filter((i) => i.id !== id));
		}
		release(ref.current.find((i) => i.id === id));
		sources.current.delete(id);
	}, []);

	const retry = useCallback(
		(id: number) => {
			const file = sources.current.get(id);
			if (file) upload(id, file);
		},
		[upload],
	);

	const clear = useCallback(() => {
		for (const h of handles.current.values()) h.abort();
		for (const i of ref.current) release(i);
		sources.current.clear();
		setItems([]);
	}, []);

	useEffect(
		() => () => {
			for (const h of handles.current.values()) h.abort();
			for (const i of ref.current) release(i);
		},
		[],
	);

	const chips = useMemo<ChipModel[]>(
		() => items.map((i) => ({ id: i.id, name: i.name, size: i.size, kind: i.kind, ...(i.preview ? { preview: i.preview } : {}), mimeType: i.type, status: i.status, progress: i.size ? i.sent / i.size : 0, ...(i.error ? { error: i.error } : {}) })),
		[items],
	);
	const draftFiles = useMemo<DraftFile[]>(
		() => items.flatMap((i) => (i.status === "ready" && i.attachment ? [{ name: i.name, size: i.size, type: i.type, kind: i.kind, ref: i.attachment.id, meta: i.attachment, ...(i.thumb ? { thumb: i.thumb } : {}) }] : [])),
		[items],
	);

	return {
		items,
		chips,
		add,
		cancel,
		retry,
		clear,
		busy: items.some((i) => i.status === "uploading"),
		failed: items.filter((i) => i.status === "error").length,
		ready: items.flatMap((i) => (i.status === "ready" && i.attachment ? [i.attachment] : [])),
		draftFiles,
	};
}

/** Files waiting to be sent with the next message: thumbnails for pictures, cards for the rest. */
export function AttachmentTray({ uploads, className }: { uploads: AttachmentUploads; className?: string }) {
	return <ComposerChips chips={uploads.chips} onRemove={(id) => uploads.cancel(id as number)} onRetry={(id) => uploads.retry(id as number)} className={cn("px-0 pb-2 pt-0", className)} />;
}

/** Paperclip button + hidden multi-file input. */
export function AttachButton({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<Button variant="ghost" size="lg" aria-label={t("Attach files")} disabled={disabled} onClick={() => input.current?.click()} className="shrink-0 px-3 coarse:min-h-12 coarse:min-w-12">
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
			{files.length > 1 ? <FileStrip files={files} title={t("Shared files")} className="w-full" /> : null}
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
				<FolderInput className="size-3" aria-hidden /> {t("Save to project…")}
			</button>
		);
	}
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button type="button" className={trigger}>
					<FolderInput className="size-3" aria-hidden /> {t("Save to project…")}
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
			toast.success(t("Saved {name}", { name: attachment.name }), { description: `${projects.data?.find((p) => p.id === chosen)?.name ?? t("Project")} · ${f.path}` });
			onClose();
		},
	});
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent sheetOnMobile>
				<DialogHeader>
					<DialogTitle>{t("Save to project")}</DialogTitle>
					<DialogDescription>
						<T text="Copies <f>{name}</f> ({size}) into a project folder on this machine. An existing file is never overwritten." params={{ name: attachment.name, size: formatBytes(attachment.size) }} tags={{ f: <span className="font-mono" /> }} />
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(e) => {
						e.preventDefault();
						if (chosen) save.mutate();
					}}
				>
					<Field label={t("Project")}>
						{() => (
							<Select value={chosen} onValueChange={setProjectId}>
								<SelectTrigger>
									<SelectValue placeholder={projects.data?.length === 0 ? t("No projects yet") : t("Select project")} />
								</SelectTrigger>
								<SelectContent>
									{projects.data?.map((p) => (
										<SelectItem key={p.id} value={p.id}>
											{p.name}
											{p.origin === "chat" ? ` · ${t("chat")}` : ""}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					</Field>
					<Field label={t("Path in the project")} hint={t("Optional — defaults to attachments/{name}", { name: attachment.name })} error={save.error ? errorText(save.error) : null}>
						{(id) => <Input id={id} value={path} onChange={(e) => setPath(e.target.value)} placeholder={`attachments/${attachment.name}`} className="font-mono" />}
					</Field>
					<DialogFooter>
						<Button variant="ghost" onClick={onClose}>
							{t("Cancel")}
						</Button>
						<Button type="submit" variant="primary" loading={save.isPending} disabled={!chosen}>
							<FolderInput /> {t("Save")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
