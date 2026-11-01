import { i18nMsg, PROMPT_IMAGE_MIME_TYPES, type PromptImage } from "@clam/contracts";
import { ApiError } from "../http/errors.ts";

type ImageMime = (typeof PROMPT_IMAGE_MIME_TYPES)[number];

/** The image type the first bytes announce (magic numbers), or null when they are none of the types a model accepts. */
export function sniffImageMime(head: Uint8Array): ImageMime | null {
	const at = (i: number): number => head[i] ?? -1;
	if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return "image/png";
	if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
	if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38 && (at(4) === 0x37 || at(4) === 0x39) && at(5) === 0x61) return "image/gif";
	if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
	return null;
}

/**
 * Refuse images whose bytes are not the type they claim: a provider rejects such an image and fails the whole turn, so a bad one
 * must never reach the agent. Count, type and total size are the `PromptImages` schema's job.
 */
export function assertPromptImages(images: readonly PromptImage[] | undefined): void {
	images?.forEach((image, index) => {
		const head = Buffer.from(image.data.slice(0, 24), "base64");
		if (sniffImageMime(head) !== image.mimeType) {
			throw ApiError.badRequest(i18nMsg("Image {number} is not a valid {type} file", { number: index + 1, type: image.mimeType }));
		}
	});
}
