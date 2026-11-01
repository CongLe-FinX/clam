import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, Bot, CheckCircle2, ChevronDown, Info, ShieldQuestion, Terminal, Trash2, Zap } from "lucide-react";
import { memo, type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { t } from "@/i18n";
import { cn, formatDuration, formatTime } from "@/lib/utils";
import { Tip } from "@/ui/tooltip";
import { type LogEntry, type SessionStream, useLog, useToolRec } from "./stream-store.ts";
import { StatusGlyph, toolDuration, useNow } from "./tool-card.tsx";
import { summarizeArgs, toolIcon } from "./tool-meta.tsx";

const ROW = 28;
const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };

function Time({ at }: { at: number }) {
	return <span className="tabular w-[4.5rem] shrink-0 font-mono text-2xs text-subtle">{formatTime(at, TIME_OPTS)}</span>;
}

const ToolLogRow = memo(function ToolLogRow({ stream, entry }: { stream: SessionStream; entry: LogEntry }) {
	const rec = useToolRec(stream, entry.toolCallId);
	const now = useNow(rec?.status === "running");
	const duration = toolDuration(rec, now);
	const Icon = toolIcon(entry.text);
	const detail = entry.detail ?? (rec ? summarizeArgs(rec.args) : "");
	return (
		<button
			type="button"
			onClick={() => entry.toolCallId && stream.selectTool(entry.toolCallId)}
			className="flex h-full w-full items-center gap-2 px-3 text-left outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
		>
			<Time at={entry.at} />
			<StatusGlyph status={rec?.status ?? "running"} />
			<Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
			<span className="shrink-0 font-mono text-xs font-medium">{entry.text}</span>
			<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{detail}</span>
			{duration !== null ? <span className="tabular shrink-0 font-mono text-2xs text-subtle">{formatDuration(duration)}</span> : null}
		</button>
	);
});

const icons = { tool: Terminal, runtime: Zap, notice: Info, prompt: CheckCircle2, agent: Bot, approval: ShieldQuestion } as const;
const tone = { info: "text-muted-foreground", success: "text-success", warning: "text-warning", error: "text-danger" } as const;

const EventRow = memo(function EventRow({ entry }: { entry: LogEntry }) {
	const Icon = entry.level === "error" ? AlertTriangle : icons[entry.kind];
	return (
		<div className="flex h-full items-center gap-2 px-3" title={entry.detail ? `${entry.text}\n${entry.detail}` : entry.text}>
			<Time at={entry.at} />
			<Icon className={cn("size-3.5 shrink-0", tone[entry.level])} aria-hidden />
			<span className={cn("shrink-0 text-xs", tone[entry.level])}>{entry.text}</span>
			{entry.detail ? <span className="min-w-0 flex-1 truncate font-mono text-2xs text-subtle">{entry.detail}</span> : null}
		</div>
	);
});

/** Chronological timeline of tool executions and runtime events. Virtualized; follows the tail until the user scrolls away. */
export function RuntimeLog({ stream, onCollapse, className, headerLead }: { stream: SessionStream; onCollapse?: () => void; className?: string; headerLead?: ReactNode }) {
	const log = useLog(stream);
	const ref = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const [following, setFollowing] = useState(true);
	const v = useVirtualizer({
		count: log.length,
		getScrollElement: () => ref.current,
		estimateSize: () => ROW,
		overscan: 12,
		getItemKey: (i) => log[i]?.id ?? i,
	});

	const onScroll = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		const near = el.scrollHeight - el.scrollTop - el.clientHeight < ROW * 1.5;
		stick.current = near;
		setFollowing(near);
	}, []);

	useLayoutEffect(() => {
		const el = ref.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	});

	return (
		<div className={cn("flex h-full min-h-0 flex-col bg-surface-1", className)}>
			<div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 coarse:h-11">
				{headerLead ?? <h2 className="text-2xs font-semibold uppercase tracking-wider text-subtle">{t("Runtime log")}</h2>}
				{headerLead ? null : <span className="tabular font-mono text-2xs text-subtle">{log.length}</span>}
				<div className="ml-auto flex items-center gap-0.5">
					{!following ? (
						<button
							type="button"
							onClick={() => {
								stick.current = true;
								setFollowing(true);
								const el = ref.current;
								if (el) el.scrollTop = el.scrollHeight;
							}}
							className="h-6 rounded-md px-2 text-2xs font-medium text-accent outline-none hover:bg-accent-soft coarse:h-9"
						>
							{t("Follow")}
						</button>
					) : null}
					<Tip label={t("Clear log")}>
						<button
							type="button"
							aria-label={t("Clear log")}
							disabled={log.length === 0}
							onClick={stream.clearLog}
							className="grid size-6 place-items-center rounded-md text-subtle outline-none transition-colors hover:bg-surface-3 hover:text-foreground disabled:pointer-events-none disabled:opacity-40 coarse:size-9"
						>
							<Trash2 className="size-3.5" />
						</button>
					</Tip>
					{onCollapse ? (
						<Tip label={t("Collapse")}>
							<button type="button" aria-label={t("Collapse runtime log")} onClick={onCollapse} className="grid size-6 place-items-center rounded-md text-subtle outline-none transition-colors hover:bg-surface-3 hover:text-foreground">
								<ChevronDown className="size-3.5" />
							</button>
						</Tip>
					) : null}
				</div>
			</div>
			{log.length === 0 ? (
				<div className="grid flex-1 place-items-center px-4 text-center text-xs text-subtle">{t("Tool executions and runtime events appear here.")}</div>
			) : (
				<div ref={ref} onScroll={onScroll} role="log" aria-label={t("Runtime log")} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]">
					<div className="relative w-full" style={{ height: v.getTotalSize() }}>
						{v.getVirtualItems().map((item) => {
							const entry = log[item.index];
							if (!entry) return null;
							return (
								<div key={item.key} className="absolute left-0 top-0 w-full" style={{ height: ROW, transform: `translateY(${item.start}px)` }}>
									{entry.kind === "tool" && entry.toolCallId ? <ToolLogRow stream={stream} entry={entry} /> : <EventRow entry={entry} />}
								</div>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}
