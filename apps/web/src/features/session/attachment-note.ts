/**
 * The line block a message carries for the files attached to it: the text the agent reads (it names each file once, by its path in
 * the project folder, and says which pictures it is also seeing) and what the chat parses back to draw file chips under the bubble.
 */
const HEADING = "Attached files, saved in the project folder:";
const SEEN = " (also attached to this message as an image you can see)";
const BLOCK = new RegExp(`(?:^|\\n\\n)${HEADING}\\n((?:- \`[^\`\\n]+\`[^\\n]*(?:\\n|$))+)\\s*$`);

export interface AttachedFileRef {
	path: string;
	/** The picture also went to the model as vision input. */
	seen: boolean;
}

export function withAttachmentNote(text: string, files: readonly AttachedFileRef[]): string {
	if (files.length === 0) return text;
	const lines = files.map((f) => `- \`${f.path}\`${f.seen ? SEEN : ""}`).join("\n");
	return `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${HEADING}\n${lines}`;
}

/** The message text without its attachment block, and the files that block lists. */
export function splitAttachmentNote(text: string): { text: string; files: AttachedFileRef[] } {
	const m = BLOCK.exec(text);
	if (!m) return { text, files: [] };
	const files: AttachedFileRef[] = [];
	for (const line of (m[1] ?? "").split("\n")) {
		const f = /^- `([^`]+)`(.*)$/.exec(line);
		if (f) files.push({ path: f[1] as string, seen: (f[2] ?? "").trim() !== "" });
	}
	return { text: text.slice(0, m.index), files };
}
