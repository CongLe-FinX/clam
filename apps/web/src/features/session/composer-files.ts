import { type FileEntry, routes } from "@clam/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ChipModel } from "@/components/composer/chips.tsx";
import type { DraftFile } from "@/lib/draft-store.ts";
import { t } from "@/i18n";
import { ApiError, errorText, localUrl } from "@/lib/api";
import { isVisionImage, thumbnail } from "@/lib/image-prep.ts";
import { isAbort, uploadFile, type UploadHandle } from "@/lib/upload";

/** A file attached to the message being written, uploaded to the session's project folder as soon as it is added. */
export interface ComposerFile {
	id: number;
	name: string;
	size: number;
	type: string;
	kind: "image" | "file";
	status: "uploading" | "ready" | "error";
	sent: number;
	error?: string;
	/** Path in the project folder once uploaded (can differ from `name` when that name was taken). */
	path?: string;
	/** The bytes the user chose; absent for a file restored from a draft (it is already in the folder). */
	file?: File;
	/** Object URL, data URL or file URL of a picture. */
	preview?: string;
	thumb?: string;
}

const PARALLEL = 3;
const MAX_RENAMES = 50;

/** `report.pdf` → `report (2).pdf` */
function numbered(name: string, n: number): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

const isImage = (type: string, name: string): boolean => type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp|heic|svg)$/i.test(name);
const ATTACHMENTS_DIR = "attachments";

/**
 * The files of the message being written: up to three uploads run at once into the project's `attachments/` folder (a taken name becomes "name (n)",
 * nothing is overwritten), each with progress, cancel and retry. `take()` hands the ready files to the send and empties the tray;
 * `restore()` puts them back when the send failed. Finished uploads are kept so a draft can reference them.
 */
export function useComposerFiles(projectId: string, initial: DraftFile[]) {
	const qc = useQueryClient();
	const [items, setItems] = useState<ComposerFile[]>(() =>
		initial.map((f, i) => ({
			id: -(i + 1),
			name: f.name,
			size: f.size,
			type: f.type,
			kind: f.kind,
			status: "ready",
			sent: f.size,
			path: f.ref,
			...(f.kind === "image" ? { preview: f.thumb ?? localUrl(routes.projectRaw(projectId), { path: f.ref }) } : {}),
			...(f.thumb ? { thumb: f.thumb } : {}),
		})),
	);
	const ref = useRef(items);
	ref.current = items;
	const seq = useRef(0);
	const handles = useRef(new Map<number, UploadHandle<FileEntry>>());
	const queue = useRef<number[]>([]);
	const active = useRef(0);

	const patch = useCallback((id: number, p: Partial<ComposerFile>) => setItems((all) => all.map((i) => (i.id === id ? { ...i, ...p } : i))), []);

	const runOne = useCallback(
		async (id: number): Promise<void> => {
			const item = ref.current.find((i) => i.id === id);
			if (!item?.file) return;
			patch(id, { status: "uploading", sent: 0, error: undefined });
			let name = item.name;
			let target = `${ATTACHMENTS_DIR}/${name}`;
			try {
				for (let n = 1; ; n++) {
					const handle = uploadFile<FileEntry>(localUrl(routes.projectUpload(projectId), { path: target }), item.file, (sent) => patch(id, { sent }));
					handles.current.set(id, handle);
					try {
						await handle.promise;
						break;
					} catch (e) {
						// Taken: keep both (the draft must never replace a file of the project).
						if (e instanceof ApiError && e.status === 409 && n <= MAX_RENAMES) {
							name = numbered(item.name, n);
							target = `${ATTACHMENTS_DIR}/${name}`;
							continue;
						}
						throw e;
					}
				}
				patch(id, { status: "ready", sent: item.size, path: target });
				void qc.invalidateQueries({ queryKey: ["local", "project", projectId, "files"] });
			} catch (e) {
				if (isAbort(e)) return;
				patch(id, { status: "error", error: errorText(e) });
				toast.error(t("Could not upload {name}", { name: item.name }), { description: errorText(e) });
			} finally {
				handles.current.delete(id);
			}
		},
		[projectId, patch, qc],
	);

	const pump = useCallback(() => {
		while (active.current < PARALLEL) {
			const id = queue.current.shift();
			if (id === undefined) return;
			active.current++;
			void runOne(id).finally(() => {
				active.current--;
				pump();
			});
		}
	}, [runOne]);

	const add = useCallback(
		(files: File[]) => {
			if (files.length === 0) return;
			const added = files.map<ComposerFile>((file) => {
				const image = isImage(file.type, file.name);
				const type = file.type || "application/octet-stream";
				return { id: ++seq.current, name: file.name, size: file.size, type, kind: image ? "image" : "file", status: "uploading", sent: 0, file, ...(image ? { preview: URL.createObjectURL(file) } : {}) };
			});
			setItems((all) => [...all, ...added]);
			ref.current = [...ref.current, ...added];
			queue.current.push(...added.map((a) => a.id));
			pump();
			for (const a of added) {
				if (a.kind === "image" && a.file) void thumbnail(a.file).then((thumb) => thumb && patch(a.id, { thumb }));
			}
		},
		[pump, patch],
	);

	const revoke = (item: ComposerFile) => {
		if (item.preview?.startsWith("blob:")) URL.revokeObjectURL(item.preview);
	};

	const remove = useCallback((id: number) => {
		queue.current = queue.current.filter((q) => q !== id);
		const handle = handles.current.get(id);
		if (handle) handle.abort();
		const gone = ref.current.find((i) => i.id === id);
		if (gone) revoke(gone);
		setItems((all) => all.filter((i) => i.id !== id));
	}, []);

	const retry = useCallback(
		(id: number) => {
			queue.current.push(id);
			patch(id, { status: "uploading", sent: 0, error: undefined });
			pump();
		},
		[pump, patch],
	);

	/** The files for a send, leaving the tray empty. Previews are released: `restore()` makes new ones. */
	const take = useCallback((): ComposerFile[] => {
		const taken = ref.current.filter((i) => i.status === "ready");
		for (const i of taken) revoke(i);
		ref.current = [];
		setItems([]);
		return taken;
	}, []);

	const restore = useCallback((files: ComposerFile[]) => {
		const back = files.map((f) => (f.file && f.kind === "image" ? { ...f, preview: URL.createObjectURL(f.file) } : f));
		ref.current = [...back, ...ref.current];
		setItems(ref.current);
	}, []);

	useEffect(
		() => () => {
			for (const h of handles.current.values()) h.abort();
			for (const i of ref.current) revoke(i);
		},
		[],
	);

	const chips = useMemo<ChipModel[]>(
		() => items.map((i) => ({ id: i.id, name: i.name, size: i.size, kind: i.kind, ...(i.preview ? { preview: i.preview } : {}), mimeType: i.type, status: i.status, progress: i.size ? i.sent / i.size : 0, ...(i.error ? { error: i.error } : {}) })),
		[items],
	);
	const uploading = items.filter((i) => i.status === "uploading").length;
	const failed = items.filter((i) => i.status === "error").length;
	const draftFiles = useMemo<DraftFile[]>(
		() => items.flatMap((i) => (i.status === "ready" && i.path ? [{ name: i.name, size: i.size, type: i.type, kind: i.kind, ref: i.path, ...(i.thumb ? { thumb: i.thumb } : {}) }] : [])),
		[items],
	);

	return { items, chips, add, remove, retry, take, restore, uploading, failed, draftFiles, visionCount: items.filter((i) => i.kind === "image" && isVisionImage({ type: i.type })).length };
}
