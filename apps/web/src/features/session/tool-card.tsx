import { Check, ChevronRight, CircleSlash, Loader2, PanelRight, X } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { CodeBlock } from "@/components/code-block";
import { isMeshTool, meshSummary } from "@/features/tasks/mesh-tools";
import { cn, formatDuration } from "@/lib/utils";
import { Tip } from "@/ui/tooltip";
import { isBusy, type SessionStream, type ToolRec, useStreamMeta, useToolRec } from "./stream-store.ts";
import { prettyJson, summarizeArgs, toolIcon } from "./tool-meta.tsx";
import { ompToolSurface } from "./omp/tool-surfaces.tsx";

export interface ToolBlock {
	id: string;
	name: string;
	arguments: unknown;
	intent?: string;
}

const RESULT_PREVIEW_CHARS = 6000;
const RESULT_MAX_CHARS = 200_000;

/** Ticks while `active`; returns the current time for duration displays. */
export function useNow(active: boolean, intervalMs = 500): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const t = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(t);
	}, [active, intervalMs]);
	return now;
}

export function toolDuration(rec: ToolRec | undefined, now: number): number | null {
	if (!rec || rec.startedAt === undefined) return null;
	return Math.max(0, (rec.endedAt ?? now) - rec.startedAt);
}

type Shown = "preparing" | "queued" | "running" | "ok" | "error" | "interrupted" | "none";

function shownStatus(block: ToolBlock, rec: ToolRec | undefined, busy: boolean): Shown {
	if (rec) return rec.status;
	if (block.id.startsWith("pending:")) return "preparing";
	return busy ? "queued" : "none";
}

const statusLabel: Record<Shown, string> = {
	preparing: "Preparing",
	queued: "Queued",
	running: "Running",
	ok: "Done",
	error: "Failed",
	interrupted: "Interrupted",
	none: "No result",
};

export function StatusGlyph({ status, className }: { status: Shown; className?: string }) {
	const cls = cn("size-3.5 shrink-0", className);
	switch (status) {
		case "running":
		case "preparing":
			return <Loader2 className={cn(cls, "animate-spin text-accent")} aria-label={statusLabel[status]} />;
		case "ok":
			return <Check className={cn(cls, "text-success")} aria-label="Done" />;
		case "error":
			return <X className={cn(cls, "text-danger")} aria-label="Failed" />;
		case "interrupted":
			return <CircleSlash className={cn(cls, "text-warning")} aria-label="Interrupted" />;
		default:
			return <span className={cn(cls, "grid place-items-center")} aria-label={statusLabel[status]}><span className="size-1.5 rounded-full bg-subtle" /></span>;
	}
}

export function ResultView({ text, className }: { text: string; className?: string }) {
	const [full, setFull] = useState(false);
	const capped = text.length > RESULT_MAX_CHARS ? text.slice(0, RESULT_MAX_CHARS) : text;
	const shown = full || capped.length <= RESULT_PREVIEW_CHARS ? capped : capped.slice(0, RESULT_PREVIEW_CHARS);
	const hidden = capped.length - shown.length;
	return (
		<div className={cn("flex flex-col gap-1.5", className)}>
			<CodeBlock code={shown} lang="text" maxHeight={full ? 560 : 280} />
			{hidden > 0 ? (
				<button type="button" onClick={() => setFull(true)} className="self-start rounded-md px-1.5 py-0.5 text-2xs font-medium text-accent outline-none hover:bg-accent-soft coarse:py-2">
					Show {hidden.toLocaleString("en-US")} more characters
				</button>
			) : null}
			{text.length > RESULT_MAX_CHARS ? <span className="text-2xs text-subtle">Output truncated to {RESULT_MAX_CHARS.toLocaleString("en-US")} characters.</span> : null}
		</div>
	);
}

/** Arguments + result, shared by the inline card and the context-panel inspector. */
export function ToolDetails({ name, args, rec }: { name: string; args: unknown; rec: ToolRec | undefined }) {
	const command = useMemo(() => {
		if (args && typeof args === "object") {
			const c = (args as Record<string, unknown>).command;
			if (typeof c === "string" && /^(bash|shell|exec|run|terminal)/i.test(name)) return c;
		}
		return null;
	}, [args, name]);
	const json = useMemo(() => (command === null ? prettyJson(args) : ""), [args, command]);
	const result = rec?.result ?? (rec?.status === "running" ? rec.preview : undefined);
	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex flex-col gap-1">
				<span className="text-2xs font-medium uppercase tracking-wider text-subtle">{command !== null ? "Command" : "Arguments"}</span>
				{command !== null ? <CodeBlock code={command} lang="bash" maxHeight={220} /> : json ? <CodeBlock code={json} lang="json" maxHeight={260} /> : <span className="text-xs text-subtle">No arguments</span>}
			</div>
			<div className="flex flex-col gap-1">
				<span className="text-2xs font-medium uppercase tracking-wider text-subtle">{rec?.status === "running" ? "Output (live)" : "Result"}</span>
				{result ? <ResultView text={result} /> : <span className="text-xs text-subtle">{rec?.status === "running" ? "Waiting for output…" : "No output recorded"}</span>}
			</div>
		</div>
	);
}

export const ToolCard = memo(function ToolCard({ stream, block }: { stream: SessionStream; block: ToolBlock }) {
	const rec = useToolRec(stream, block.id);
	const busy = useStreamMeta(stream, isBusy);
	const selected = useStreamMeta(stream, (m) => m.selectedToolId === block.id);
	const [open, setOpen] = useState(false);
	const status = shownStatus(block, rec, busy);
	const running = status === "running";
	const now = useNow(running);
	const duration = toolDuration(rec, now);
	const name = block.name || rec?.name || "tool";
	const args = rec?.args ?? block.arguments;
	const Icon = toolIcon(name);
	const preparing = status === "preparing";
	const intent = preparing ? "Preparing tool call…" : (block.intent ?? rec?.intent);
	const summary = preparing ? "" : summarizeArgs(args);
	const mesh = preparing || !isMeshTool(name) ? null : meshSummary(name, args, rec);
	const bodyId = `tool-${block.id}`;
	const Surface = preparing ? null : ompToolSurface(name);
	if (Surface) return <Surface stream={stream} block={block} rec={rec} status={status} args={args} />;
	return (
		<div
			data-tool-status={status}
			className={cn(
				"max-w-3xl overflow-hidden rounded-lg bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)] transition-shadow",
				status === "error" && "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--danger)_40%,transparent)]",
				selected && "shadow-[inset_0_0_0_1px_var(--accent)]",
			)}
		>
			<div className="flex min-h-9 items-center gap-1 pr-1 coarse:min-h-11">
				<button
					type="button"
					aria-expanded={open}
					aria-controls={bodyId}
					onClick={() => setOpen((v) => !v)}
					className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-2.5 pr-1 text-left outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
				>
					<ChevronRight className={cn("size-3.5 shrink-0 text-subtle transition-transform duration-150", open && "rotate-90")} aria-hidden />
					<Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
					<span className="shrink-0 font-mono text-xs font-medium">{name}</span>
					<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{mesh?.headline ?? intent ?? summary}</span>
					{duration !== null ? <span className="tabular shrink-0 font-mono text-2xs text-subtle">{formatDuration(duration)}</span> : null}
					<StatusGlyph status={status} />
				</button>
				<Tip label="Inspect in side panel">
					<button
						type="button"
						aria-label="Inspect tool call"
						onClick={() => stream.selectTool(block.id)}
						className="grid size-7 shrink-0 place-items-center rounded-md text-subtle outline-none transition-colors hover:bg-surface-3 hover:text-foreground coarse:size-11"
					>
						<PanelRight className="size-3.5" />
					</button>
				</Tip>
			</div>
			{mesh?.extra}
			{!open && running && rec?.preview ? (
				<pre className="line-clamp-3 overflow-hidden whitespace-pre-wrap break-all border-t px-3 py-1.5 font-mono text-2xs leading-4 text-subtle">{rec.preview.slice(-400)}</pre>
			) : null}
			{open ? (
				<div id={bodyId} className="animate-fade-in border-t p-3">
					{intent && summary ? <div className="mb-2.5 truncate font-mono text-2xs text-subtle">{summary}</div> : null}
					<ToolDetails name={name} args={args} rec={rec} />
				</div>
			) : null}
		</div>
	);
});
