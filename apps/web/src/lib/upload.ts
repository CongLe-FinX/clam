import type { ApiErrorBody } from "@clam/contracts";
import { authGate } from "@/features/auth/gate.ts";
import { ApiError } from "./api.ts";

export interface UploadHandle<T> {
	promise: Promise<T>;
	abort(): void;
}

/**
 * POSTs the raw bytes of `file` (Content-Type = the file's type) with upload progress. XHR rather than fetch because only XHR
 * reports bytes sent. Rejects with `ApiError` (so callers can branch on `status`/`code`) or an `AbortError` DOMException.
 */
export function uploadFile<T>(url: string, file: File, onProgress?: (sent: number, total: number) => void): UploadHandle<T> {
	const xhr = new XMLHttpRequest();
	const promise = new Promise<T>((resolve, reject) => {
		xhr.open("POST", url);
		xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
		xhr.setRequestHeader("accept", "application/json");
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable) onProgress?.(e.loaded, e.total);
		};
		xhr.onerror = () => reject(new ApiError(0, "network", "Cannot reach the CL Agent Mesh server. Is it running?"));
		xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
		xhr.onload = () => {
			let json: unknown;
			try {
				json = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
			} catch {
				json = undefined;
			}
			if (xhr.status >= 200 && xhr.status < 300) {
				onProgress?.(file.size, file.size);
				resolve(json as T);
				return;
			}
			const err = (json as ApiErrorBody | undefined)?.error;
			if (xhr.status === 401 && err?.code === "auth_required") authGate.require();
			reject(new ApiError(xhr.status, err?.code ?? `http_${xhr.status}`, err?.message ?? (xhr.statusText || `Upload failed (${xhr.status})`), err?.details));
		};
		xhr.send(file);
	});
	return { promise, abort: () => xhr.abort() };
}

export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === "AbortError";

/** Files from a clipboard paste event (screenshots, copied files). */
export function filesFromClipboard(e: ClipboardEvent | React.ClipboardEvent): File[] {
	const out: File[] = [];
	for (const item of Array.from(e.clipboardData?.items ?? [])) {
		if (item.kind !== "file") continue;
		const f = item.getAsFile();
		if (f) out.push(f.name && f.name !== "image.png" ? f : new File([f], `pasted-${Date.now().toString(36)}.${(f.type.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "")}`, { type: f.type }));
	}
	return out;
}

export function hasFiles(e: DragEvent | React.DragEvent): boolean {
	return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}
