import { PROMPT_IMAGE_MIME_TYPES, PROMPT_IMAGES_MAX_BASE64_BYTES, PROMPT_IMAGES_MAX_COUNT, type PromptImage } from "@clam/contracts";

/** Longest side a model can use: bigger pictures are scaled down before they are sent (vision models resize them anyway). */
export const MAX_IMAGE_EDGE = 2048;
const EDGES = [MAX_IMAGE_EDGE, 1600, 1280, 1024, 800, 640];
const QUALITIES = [0.86, 0.72, 0.58, 0.45];

const MODEL_TYPES = new Set<string>(PROMPT_IMAGE_MIME_TYPES);

/** A picture a model can take as vision input (PNG, JPEG, WebP, GIF). Anything else (SVG, HEIC, TIFF…) travels as a file. */
export const isVisionImage = (file: { type: string }): boolean => MODEL_TYPES.has(file.type);

/** Binary bytes each of `count` images may take so that together they stay inside the prompt's base64 budget. */
export function imageBudgetBytes(count: number): number {
	return Math.floor(((PROMPT_IMAGES_MAX_BASE64_BYTES / Math.max(1, Math.min(count, PROMPT_IMAGES_MAX_COUNT))) * 3) / 4) - 16;
}

export interface PreparedImage extends PromptImage {
	/** The encoded picture. */
	blob: Blob;
	/** Size of the encoded picture in bytes. */
	bytes: number;
	width: number;
	height: number;
	/** Scaled down or re-encoded to fit (false = the original bytes). */
	resized: boolean;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error);
		reader.onload = () => {
			const url = String(reader.result);
			resolve(url.slice(url.indexOf(",") + 1));
		};
		reader.readAsDataURL(blob);
	});
}

async function decode(blob: Blob): Promise<ImageBitmap | null> {
	try {
		return await createImageBitmap(blob, { imageOrientation: "from-image" });
	} catch {
		return null;
	}
}

/**
 * The picture as vision input: the original bytes when they are small enough, else scaled down (longest side ≤ 2048 px, then
 * smaller) and re-encoded as WebP (JPEG where the browser cannot encode WebP) until it fits `budgetBytes`. Null when the file is
 * not a picture the browser can decode or nothing small enough could be made: it is then sent as a file only.
 */
export async function prepareImage(blob: Blob, budgetBytes: number): Promise<PreparedImage | null> {
	const bitmap = await decode(blob);
	if (!bitmap) return null;
	try {
		const { width, height } = bitmap;
		const longest = Math.max(width, height);
		if (blob.size <= budgetBytes && longest <= MAX_IMAGE_EDGE && isVisionImage(blob)) {
			return { mimeType: blob.type as PromptImage["mimeType"], data: await blobToBase64(blob), blob, bytes: blob.size, width, height, resized: false };
		}
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		const edges = [...new Set(EDGES.map((e) => Math.min(e, longest)))];
		for (const edge of edges) {
			const scale = edge / longest;
			canvas.width = Math.max(1, Math.round(width * scale));
			canvas.height = Math.max(1, Math.round(height * scale));
			for (const quality of QUALITIES) {
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
				let out = await toBlob(canvas, "image/webp", quality);
				if (out && out.type !== "image/webp") {
					// No WebP encoder (Safari): JPEG has no alpha, so draw on white.
					ctx.globalCompositeOperation = "destination-over";
					ctx.fillStyle = "#fff";
					ctx.fillRect(0, 0, canvas.width, canvas.height);
					ctx.globalCompositeOperation = "source-over";
					out = await toBlob(canvas, "image/jpeg", quality);
				}
				if (out && out.size <= budgetBytes && isVisionImage(out)) {
					return { mimeType: out.type as PromptImage["mimeType"], data: await blobToBase64(out), blob: out, bytes: out.size, width: canvas.width, height: canvas.height, resized: true };
				}
			}
		}
		return null;
	} finally {
		bitmap.close();
	}
}

/** A small square preview (data URL) kept in drafts so a restored chip still shows its picture. Null when the file cannot be decoded. */
export async function thumbnail(blob: Blob, size = 128): Promise<string | null> {
	const bitmap = await decode(blob);
	if (!bitmap) return null;
	try {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = size;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		const side = Math.min(bitmap.width, bitmap.height);
		ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
		const out = await toBlob(canvas, "image/jpeg", 0.7);
		return out ? await blobToDataUrl(out) : null;
	} finally {
		bitmap.close();
	}
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error);
		reader.onload = () => resolve(String(reader.result));
		reader.readAsDataURL(blob);
	});
}
