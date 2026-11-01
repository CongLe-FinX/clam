import type { BrowserConsoleEntry } from "@clam/contracts";
import { Trash2, X } from "lucide-react";
import { t } from "@/i18n";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn, formatTime } from "@/lib/utils";
import { Button } from "@/ui/button";

type Pane = "console" | "network";

const LEVEL_CLASS: Record<BrowserConsoleEntry["level"], string> = {
	log: "text-foreground",
	info: "text-info",
	warn: "text-warning",
	error: "text-danger",
	debug: "text-subtle",
};
const SHOWN = 400;

function time(ts: number): string {
	return formatTime(ts, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function Entry({ entry }: { entry: BrowserConsoleEntry }) {
	const failed = entry.kind === "exception" || entry.kind === "network";
	return (
		<li className={cn("flex gap-2 border-b border-border/60 px-3 py-1 font-mono text-xs leading-5", failed && "bg-danger/5")}>
			<span className="shrink-0 text-subtle tabular">{time(entry.ts)}</span>
			<div className="min-w-0 flex-1">
				<p className={cn("whitespace-pre-wrap break-words", LEVEL_CLASS[failed ? "error" : entry.level])}>{entry.text}</p>
				{entry.url ? (
					<p className="truncate text-2xs text-subtle" title={entry.url}>
						{entry.url}
						{entry.line !== null ? `:${entry.line}` : ""}
					</p>
				) : null}
			</div>
		</li>
	);
}

/** DevTools-lite: the page's console (all levels) and its failed network requests. */
export function DevtoolsPanel({ entries, onClear, onClose, className }: { entries: BrowserConsoleEntry[]; onClear: () => void; onClose: () => void; className?: string }) {
	const [pane, setPane] = useState<Pane>("console");
	const { consoleEntries, networkEntries } = useMemo(() => {
		const c: BrowserConsoleEntry[] = [];
		const n: BrowserConsoleEntry[] = [];
		for (const e of entries) (e.kind === "network" ? n : c).push(e);
		return { consoleEntries: c.slice(-SHOWN), networkEntries: n.slice(-SHOWN) };
	}, [entries]);
	const shown = pane === "console" ? consoleEntries : networkEntries;
	const errors = consoleEntries.filter((e) => e.level === "error" || e.kind === "exception").length;

	const listRef = useRef<HTMLUListElement>(null);
	const stick = useRef(true);
	useLayoutEffect(() => {
		const el = listRef.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [shown]);

	const tab = (id: Pane, label: string, count: number, danger: boolean) => (
		<button
			type="button"
			role="tab"
			aria-selected={pane === id}
			onClick={() => setPane(id)}
			className={cn("flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none transition-colors coarse:h-11", pane === id ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:text-foreground")}
		>
			{label}
			{count > 0 ? <span className={cn("rounded-full px-1.5 font-mono text-2xs", danger ? "bg-danger/15 text-danger" : "bg-surface-3 text-muted-foreground")}>{count}</span> : null}
		</button>
	);

	return (
		<section aria-label={t("Page console")} className={cn("flex min-h-0 flex-col bg-surface-1", className)}>
			<header className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
				<div role="tablist" className="flex items-center gap-0.5">
					{tab("console", t("Console"), consoleEntries.length, errors > 0)}
					{tab("network", t("Network errors"), networkEntries.length, true)}
				</div>
				<span className="flex-1" />
				<Button variant="ghost" size="icon-sm" aria-label={t("Clear console")} onClick={onClear} disabled={entries.length === 0}>
					<Trash2 />
				</Button>
				<Button variant="ghost" size="icon-sm" aria-label={t("Close console")} onClick={onClose}>
					<X />
				</Button>
			</header>
			{shown.length === 0 ? (
				<p className="px-3 py-6 text-center text-xs text-subtle">{pane === "console" ? t("Nothing logged yet.") : t("No failed requests.")}</p>
			) : (
				<ul
					ref={listRef}
					onScroll={(e) => {
						const el = e.currentTarget;
						stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
					}}
					className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain"
				>
					{shown.map((e) => (
						<Entry key={e.id} entry={e} />
					))}
				</ul>
			)}
		</section>
	);
}
