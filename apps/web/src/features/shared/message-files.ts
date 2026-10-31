import type { SharedAttachment } from "@clam/contracts";
import type { AssetResolver } from "@/components/rich/assets.ts";

const FENCE = /```[\s\S]*?(?:```|$)/g;
const TARGET = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)/g;

/** Attachments the message text already shows through `![alt](name)` / `[text](name)`: the file strip skips them so nothing appears twice. */
export function embeddedAttachmentIds(text: string, attachments: readonly SharedAttachment[], resolver: AssetResolver | undefined): ReadonlySet<string> {
	const out = new Set<string>();
	if (!resolver || attachments.length === 0 || !text.includes("](")) return out;
	for (const m of text.replace(FENCE, "").matchAll(TARGET)) {
		const href = m[1];
		const file = href ? resolver.resolve(href) : null;
		if (file) out.add(file.key);
	}
	return out;
}
