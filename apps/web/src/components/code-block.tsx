import { Check, Copy } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { type HlLine, highlightLines, resolveLang } from "@/lib/highlight";
import { cn } from "@/lib/utils";
import { Tip } from "@/ui/tooltip";

export function HlLineView({ line }: { line: HlLine }) {
	return (
		<>
			{line.map((t, i) => (
				<span key={i} className="hl-tok" style={t.style}>
					{t.content}
				</span>
			))}
		</>
	);
}

const cache = new Map<string, HlLine[] | null>();

/** Highlights lazily (after the text stops changing for ~140 ms) so streaming stays cheap. */
function useHighlighted(code: string, lang: string | null | undefined): HlLine[] | null {
	const key = `${lang}\u0000${code}`;
	const [lines, setLines] = useState<HlLine[] | null>(() => cache.get(key) ?? null);
	useEffect(() => {
		if (!resolveLang(lang)) return;
		if (cache.has(key)) {
			setLines(cache.get(key) ?? null);
			return;
		}
		let alive = true;
		const t = setTimeout(() => {
			highlightLines(code, lang)
				.then((l) => {
					if (cache.size > 200) cache.clear();
					cache.set(key, l);
					if (alive) setLines(l);
				})
				.catch(() => undefined);
		}, 140);
		return () => {
			alive = false;
			clearTimeout(t);
		};
	}, [code, lang, key]);
	return lines;
}

export function CopyButton({ text, className, label = "Copy" }: { text: string; className?: string; label?: string }) {
	const [done, setDone] = useState(false);
	useEffect(() => {
		if (!done) return;
		const t = setTimeout(() => setDone(false), 1500);
		return () => clearTimeout(t);
	}, [done]);
	return (
		<Tip label={done ? "Copied" : label}>
			<button
				type="button"
				aria-label={label}
				onClick={() => {
					void navigator.clipboard?.writeText(text).then(() => setDone(true));
				}}
				className={cn("grid size-7 place-items-center rounded-md text-subtle outline-none transition-colors hover:bg-surface-3 hover:text-foreground coarse:size-10", className)}
			>
				{done ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
			</button>
		</Tip>
	);
}

export const CodeBlock = memo(function CodeBlock({ code, lang, className, maxHeight = 420 }: { code: string; lang?: string | null; className?: string; maxHeight?: number }) {
	const lines = useHighlighted(code, lang);
	const label = lang && lang !== "text" ? lang : null;
	return (
		<div className={cn("group/code overflow-hidden rounded-lg bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)]", className)}>
			<div className="flex h-8 items-center justify-between border-b px-3 text-2xs text-subtle">
				<span className="font-mono">{label ?? "text"}</span>
				<CopyButton text={code} className="-mr-2 size-6" />
			</div>
			<pre className="scrollbar-thin overflow-auto px-3 py-2.5 font-mono text-[12.5px] leading-[1.6]" style={{ maxHeight }}>
				<code>{lines ? lines.map((l, i) => <div key={i}><HlLineView line={l} />{"\n"}</div>) : code}</code>
			</pre>
		</div>
	);
});
