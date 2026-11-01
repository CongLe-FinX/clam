import { type FileEntry, routes } from "@clam/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, FileUp, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { t, T } from "@/i18n";
import { ApiError, errorText, localUrl } from "@/lib/api";
import { isAbort, uploadFile, type UploadHandle } from "@/lib/upload";
import { cn, formatBytes } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Progress } from "@/ui/progress";

export interface UploadItem {
	id: number;
	file: File;
	/** Destination path relative to the project root (changes when the user keeps both). */
	path: string;
	sent: number;
	status: "queued" | "uploading" | "done" | "error" | "conflict";
	error?: string;
}

/** `report.pdf` → `report (1).pdf` */
function renamed(path: string, n: number): string {
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
	const name = path.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? `${dir}${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${dir}${name} (${n})`;
}

/**
 * Uploads files into a project folder one at a time. The server refuses to overwrite: a 409 parks the file as `conflict` and the
 * dock asks whether to replace it, keep both (adds " (n)") or skip it.
 */
export function useProjectUploads(projectId: string): ProjectUploads {
	const qc = useQueryClient();
	const [items, setItems] = useState<UploadItem[]>([]);
	const handles = useRef(new Map<number, UploadHandle<FileEntry>>());
	const seq = useRef(0);
	const queue = useRef<number[]>([]);
	const running = useRef(false);
	const itemsRef = useRef<UploadItem[]>([]);
	itemsRef.current = items;

	const patch = useCallback((id: number, p: Partial<UploadItem>) => setItems((all) => all.map((i) => (i.id === id ? { ...i, ...p } : i))), []);
	const drop = useCallback((id: number) => setItems((all) => all.filter((i) => i.id !== id)), []);

	const refresh = useCallback(() => {
		void qc.invalidateQueries({ queryKey: ["local", "project", projectId, "files"] });
	}, [qc, projectId]);

	const runOne = useCallback(
		async (id: number, overwrite: boolean) => {
			const item = itemsRef.current.find((i) => i.id === id);
			if (!item) return;
			patch(id, { status: "uploading", sent: 0, error: undefined });
			const handle = uploadFile<FileEntry>(localUrl(routes.projectUpload(projectId), { path: item.path, overwrite: overwrite ? 1 : undefined }), item.file, (sent) => patch(id, { sent }));
			handles.current.set(id, handle);
			try {
				await handle.promise;
				patch(id, { status: "done", sent: item.file.size });
				refresh();
				setTimeout(() => drop(id), 4000);
			} catch (e) {
				if (isAbort(e)) drop(id);
				else if (e instanceof ApiError && e.status === 409) patch(id, { status: "conflict" });
				else {
					patch(id, { status: "error", error: errorText(e) });
					toast.error(t("Could not upload {name}", { name: item.file.name }), { description: errorText(e) });
				}
			} finally {
				handles.current.delete(id);
			}
		},
		[projectId, patch, drop, refresh],
	);

	const pump = useCallback(async () => {
		if (running.current) return;
		running.current = true;
		try {
			for (let id = queue.current.shift(); id !== undefined; id = queue.current.shift()) await runOne(id, false);
		} finally {
			running.current = false;
		}
	}, [runOne]);

	const upload = useCallback(
		(files: File[], dir: string) => {
			const added = files.map<UploadItem>((file) => ({ id: ++seq.current, file, path: dir ? `${dir}/${file.name}` : file.name, sent: 0, status: "queued" }));
			if (added.length === 0) return;
			itemsRef.current = [...itemsRef.current, ...added];
			setItems(itemsRef.current);
			queue.current.push(...added.map((a) => a.id));
			void pump();
		},
		[pump],
	);

	const cancel = useCallback(
		(id: number) => {
			queue.current = queue.current.filter((q) => q !== id);
			const h = handles.current.get(id);
			if (h) h.abort();
			else drop(id);
		},
		[drop],
	);

	const resolve = useCallback(
		(id: number, choice: "replace" | "keep" | "skip") => {
			const item = itemsRef.current.find((i) => i.id === id);
			if (!item) return;
			if (choice === "skip") return drop(id);
			if (choice === "keep") {
				let n = 1;
				while (itemsRef.current.some((i) => i.path === renamed(item.path.replace(/ \(\d+\)(\.[^./]*)?$/, "$1"), n))) n++;
				const next = renamed(item.path.replace(/ \(\d+\)(\.[^./]*)?$/, "$1"), n);
				itemsRef.current = itemsRef.current.map((i) => (i.id === id ? { ...i, path: next } : i));
				setItems(itemsRef.current);
			}
			void runOne(id, choice === "replace");
		},
		[drop, runOne],
	);

	return { items, upload, cancel, resolve, dismiss: drop };
}

export interface ProjectUploads {
	items: UploadItem[];
	/** `dir` is a folder path relative to the project root ("" = root). */
	upload(files: File[], dir: string): void;
	cancel(id: number): void;
	resolve(id: number, choice: "replace" | "keep" | "skip"): void;
	dismiss(id: number): void;
}

/** Progress rows for uploads in flight plus the replace / keep both / skip prompt for the first conflict. */
export function UploadDock({ uploads, className }: { uploads: ProjectUploads; className?: string }) {
	const conflict = uploads.items.find((i) => i.status === "conflict");
	const visible = uploads.items.filter((i) => i.status !== "conflict");
	return (
		<>
			{visible.length > 0 ? (
				<ul aria-label={t("Uploads")} className={cn("flex shrink-0 flex-col gap-1.5 border-t bg-surface-1 p-2", className)}>
					{visible.map((i) => (
						<li key={i.id} className="flex items-center gap-2 text-xs">
							{i.status === "done" ? <Check className="size-3.5 shrink-0 text-success" aria-hidden /> : i.status === "error" ? <AlertCircle className="size-3.5 shrink-0 text-danger" aria-hidden /> : <FileUp className="size-3.5 shrink-0 text-accent" aria-hidden />}
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<span className="flex items-baseline gap-2">
									<span className="min-w-0 truncate" title={i.path}>
										{i.file.name}
									</span>
									<span className="tabular shrink-0 font-mono text-2xs text-subtle">{i.status === "error" ? t("failed") : i.status === "queued" ? t("waiting") : i.status === "done" ? formatBytes(i.file.size) : t("{sent} / {total}", { sent: formatBytes(i.sent), total: formatBytes(i.file.size) })}</span>
								</span>
								{i.status === "uploading" || i.status === "queued" ? <Progress value={i.file.size ? (i.sent / i.file.size) * 100 : 0} /> : null}
								{i.error ? <span className="truncate text-2xs text-danger">{i.error}</span> : null}
							</div>
							{i.status === "done" ? null : (
								<button
									type="button"
									aria-label={i.status === "error" ? t("Dismiss {name}", { name: i.file.name }) : t("Cancel upload of {name}", { name: i.file.name })}
									onClick={() => (i.status === "error" ? uploads.dismiss(i.id) : uploads.cancel(i.id))}
									className="grid size-6 shrink-0 place-items-center rounded-md text-subtle outline-none hover:bg-surface-3 hover:text-foreground coarse:size-10"
								>
									<X className="size-3.5" />
								</button>
							)}
						</li>
					))}
				</ul>
			) : null}
			{conflict ? (
				<Dialog open onOpenChange={(o) => !o && uploads.resolve(conflict.id, "skip")}>
					<DialogContent sheetOnMobile>
						<DialogHeader>
							<DialogTitle>{t("“{name}” already exists", { name: conflict.file.name })}</DialogTitle>
							<DialogDescription>
								<T text="A file named <code>{path}</code> is already in this folder. Replace it, keep both files, or skip this upload." params={{ path: conflict.path }} tags={{ code: <span className="font-mono" /> }} />
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="ghost" onClick={() => uploads.resolve(conflict.id, "skip")}>
								{t("Skip")}
							</Button>
							<Button variant="outline" onClick={() => uploads.resolve(conflict.id, "keep")}>
								{t("Keep both")}
							</Button>
							<Button variant="danger" onClick={() => uploads.resolve(conflict.id, "replace")}>
								{t("Replace")}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			) : null}
		</>
	);
}
