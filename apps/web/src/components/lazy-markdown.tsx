import { memo, Suspense, useMemo } from "react";
import { lazyPreload } from "@/lib/lazy-preload";
import type { AssetResolver } from "./rich/assets.ts";

const markdown = lazyPreload(() => import("./markdown.tsx"));
const Markdown = markdown.Component;

/** Fetch the markdown chunk now (idle time, or as soon as a surface is known to need it) so its first render is already formatted. */
export const preloadMarkdown = (): void => void markdown.preload();

interface Segment {
	code: boolean;
	text: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Prose and fenced code of a text, in order; an unclosed fence runs to the end (a streaming text). */
function segments(text: string): Segment[] {
	const out: Segment[] = [];
	let fence: string | null = null;
	let current: string[] = [];
	const flush = (code: boolean) => {
		if (current.length > 0 || code) out.push({ code, text: current.join("\n") });
		current = [];
	};
	for (const line of text.split("\n")) {
		const match = FENCE.exec(line);
		if (!fence && match) {
			flush(false);
			fence = match[1] as string;
		} else if (fence && match && (match[1] as string)[0] === fence[0] && (match[1] as string).length >= fence.length && line.trim() === match[1]) {
			flush(true);
			fence = null;
		} else current.push(line);
	}
	flush(fence !== null);
	return out;
}

/** What shows while the chunk loads: prose as written, fenced code as a code box — never the raw ``` lines. */
function Plain({ text }: { text: string }) {
	const parts = useMemo(() => segments(text), [text]);
	return (
		<div className="prose-clam">
			{parts.map((part, i) =>
				part.code ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reordered
					<pre key={i} className="scrollbar-thin my-3 overflow-x-auto rounded-xl bg-surface-2 p-3 font-mono text-[12.5px] leading-5 shadow-[inset_0_0_0_1px_var(--border)]">
						{part.text}
					</pre>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reordered
					<div key={i} className="whitespace-pre-wrap">
						{part.text}
					</div>
				),
			)}
		</div>
	);
}

/**
 * Markdown renderer loaded on demand; shows the text with its code fences boxed until the chunk arrives. `assets` resolves
 * relative paths in images/links; pass a stable (memoized) resolver or the message re-renders on every parent render. `breaks`: every
 * single newline is a line break (text a person typed); agent text keeps standard markdown paragraphs. `document`: a whole file
 * (README) whose raw HTML renders too, sanitized like GitHub.
 */
export const LazyMarkdown = memo(function LazyMarkdown({
	text,
	assets,
	breaks = false,
	document = false,
	onOpenFile,
}: {
	text: string;
	assets?: AssetResolver;
	breaks?: boolean;
	document?: boolean;
	/** A link to another file of the folder opens it here (the file viewer) instead of downloading it. */
	onOpenFile?: (path: string) => void;
}) {
	return (
		<Suspense fallback={<Plain text={text} />}>
			<Markdown text={text} assets={assets} breaks={breaks} document={document} onOpenFile={onOpenFile} />
		</Suspense>
	);
});
