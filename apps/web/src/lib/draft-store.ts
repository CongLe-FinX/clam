/** Composer drafts: text plus the files already uploaded for the message, kept per chat in localStorage so they survive navigation and reloads. */

const PREFIX = "clam.draft2:";
const MAX_AGE_MS = 30 * 86_400_000;

export interface DraftFile {
	name: string;
	size: number;
	type: string;
	kind: "image" | "file";
	/** Small preview (data URL) of an image. */
	thumb?: string;
	/** Where the file lives: a project-folder path (single-agent chat) or a group attachment id. */
	ref: string;
	/** Free-form data of the owner (the group composer keeps its `SharedAttachment`). */
	meta?: unknown;
}

export interface Draft {
	text: string;
	files: DraftFile[];
}

interface Stored extends Draft {
	savedAt: number;
}

let pruned = false;
function prune(): void {
	if (pruned) return;
	pruned = true;
	try {
		const stale: string[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key?.startsWith(PREFIX)) continue;
			try {
				const saved = (JSON.parse(localStorage.getItem(key) ?? "{}") as Partial<Stored>).savedAt ?? 0;
				if (Date.now() - saved > MAX_AGE_MS) stale.push(key);
			} catch {
				stale.push(key);
			}
		}
		for (const key of stale) localStorage.removeItem(key);
	} catch {
		/* storage unavailable */
	}
}

const key = (scope: "session" | "group", id: string): string => `${PREFIX}${scope}:${id}`;

export function readDraft(scope: "session" | "group", id: string): Draft {
	prune();
	try {
		const raw = localStorage.getItem(key(scope, id));
		if (!raw) return { text: "", files: [] };
		const stored = JSON.parse(raw) as Partial<Stored>;
		return { text: typeof stored.text === "string" ? stored.text : "", files: Array.isArray(stored.files) ? stored.files : [] };
	} catch {
		return { text: "", files: [] };
	}
}

export function writeDraft(scope: "session" | "group", id: string, draft: Draft): void {
	try {
		if (!draft.text && draft.files.length === 0) {
			localStorage.removeItem(key(scope, id));
			return;
		}
		const store = (files: DraftFile[]) => localStorage.setItem(key(scope, id), JSON.stringify({ ...draft, files, savedAt: Date.now() } satisfies Stored));
		try {
			store(draft.files);
		} catch {
			// Quota: the previews are the bulk, the text and file references are what matter.
			store(draft.files.map(({ thumb: _thumb, ...rest }) => rest));
		}
	} catch {
		/* storage unavailable: the draft just isn't kept */
	}
}
