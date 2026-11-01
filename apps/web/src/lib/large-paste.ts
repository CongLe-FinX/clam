/** Pasting more than this many characters or lines offers to attach the text as a file instead of putting it in the message. */
export const LARGE_PASTE_CHARS = 8000;
export const LARGE_PASTE_LINES = 200;

export interface LargePaste {
	chars: number;
	lines: number;
}

export function measurePaste(text: string): LargePaste | null {
	const lines = text.split("\n").length;
	return text.length > LARGE_PASTE_CHARS || lines > LARGE_PASTE_LINES ? { chars: text.length, lines } : null;
}

/** The pasted text as a file: Markdown when it reads like it, plain text otherwise. */
export function pasteAsFile(text: string): File {
	const markdown = /^#{1,6} \S/m.test(text) || /^```/m.test(text);
	return new File([text], `pasted-text-${Date.now().toString(36)}.${markdown ? "md" : "txt"}`, { type: markdown ? "text/markdown" : "text/plain" });
}
