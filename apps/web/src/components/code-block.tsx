import { Check, Copy, WrapText } from "lucide-react";
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
				className={cn("grid size-7 place-items-center rounded-md text-subtle outline-none transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring coarse:size-10", className)}
			>
				{done ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
			</button>
		</Tip>
	);
}

export const CodeBlock = memo(function CodeBlock({
	code,
	lang,
	className,
	maxHeight = 420,
	hint,
}: {
	code: string;
	lang?: string | null;
	className?: string;
	maxHeight?: number;
	/** Small note in the header (e.g. “rendering when complete” for an open streaming fence). */
	hint?: string;
}) {
	const lines = useHighlighted(code, lang);
	const [wrap, setWrap] = useState(false);
	const label = lang && lang !== "text" ? lang : null;
	return (
		<div className={cn("rich-card group/code overflow-hidden rounded-lg bg-surface-2 shadow-[inset_0_0_0_1px_var(--border-strong)]", className)}>
			<div className="flex min-h-8 items-center justify-between gap-2 border-b px-3 text-2xs text-subtle coarse:min-h-11">
				<span className="flex min-w-0 items-center gap-2">
					<span className="font-mono">{label ?? "text"}</span>
					{hint ? <span className="truncate italic">{hint}</span> : null}
				</span>
				<span className="-mr-2 flex items-center">
					<Tip label={wrap ? "No wrap" : "Wrap lines"}>
						<button
							type="button"
							aria-label="Wrap lines"
							aria-pressed={wrap}
							onClick={() => setWrap((v) => !v)}
							className={cn("grid size-6 place-items-center rounded-md outline-none transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring coarse:size-10", wrap && "bg-surface-3 text-foreground")}
						>
							<WrapText className="size-3.5" />
						</button>
					</Tip>
					<CopyButton text={code} className="size-6" />
				</span>
			</div>
			<pre className={cn("scrollbar-thin overflow-auto px-3 py-2.5 font-mono text-[12.5px] leading-[1.6]", wrap && "whitespace-pre-wrap break-words")} style={{ maxHeight }}>
				<code>{lines ? lines.map((l, i) => <div key={i}><HlLineView line={l} />{"\n"}</div>) : code}</code>
			</pre>
		</div>
	);
});
