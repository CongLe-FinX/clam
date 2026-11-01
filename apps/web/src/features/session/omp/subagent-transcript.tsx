import type { SubagentMessagesPage, UiBlock, UiMessage } from "@clam/contracts";
import { routes } from "@clam/contracts";
import { Brain, Check, ChevronRight, Loader2, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { t } from "@/i18n";
import { api, errorText } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";
import { prettyJson, summarizeArgs, toolIcon } from "../tool-meta.tsx";
import { type OmpStore, type SubagentRec, useSubagentVersion } from "./omp-store.ts";
import { isLive } from "./subagent-ui.tsx";

const RESULT_CAP = 4000;
const SAFETY_POLL_MS = 5000;

interface Transcript {
	messages: UiMessage[];
	nextByte: number;
	status: "loading" | "ready" | "error";
	error: string | null;
}

/**
 * A subagent's transcript, read incrementally (`fromByte`/`nextByte`). It refetches when the subagent reports a change (the
 * store's per-subagent version) and, as a safety net while it runs, every few seconds; a final fetch follows its end.
 */
function useTranscript(store: OmpStore, s: SubagentRec): Transcript & { reload: () => void } {
	const [data, setData] = useState<Transcript>({ messages: [], nextByte: 0, status: "loading", error: null });
	const version = useSubagentVersion(store, s.id);
	const live = isLive(s);
	const nextByte = useRef(0);
	const inflight = useRef(false);
	const again = useRef(false);
	const alive = useRef(true);

	const fetchMore = useCallback(async (): Promise<void> => {
		if (inflight.current) {
			again.current = true;
			return;
		}
		inflight.current = true;
		try {
			const page = await api.get<SubagentMessagesPage>(routes.sessionSubagentMessages(store.sessionId, s.id), { fromByte: nextByte.current });
			if (!alive.current) return;
			nextByte.current = page.nextByte;
			setData((prev) => {
				const base = page.reset ? [] : prev.messages;
				const known = new Set(base.map((m) => m.id));
				const fresh = page.messages.filter((m) => !known.has(m.id));
				return { messages: fresh.length > 0 || page.reset ? [...base, ...fresh] : prev.messages, nextByte: page.nextByte, status: "ready", error: null };
			});
		} catch (e) {
			if (alive.current) setData((prev) => ({ ...prev, status: prev.messages.length > 0 ? "ready" : "error", error: errorText(e) }));
		} finally {
			inflight.current = false;
			if (again.current && alive.current) {
				again.current = false;
				void fetchMore();
			}
		}
	}, [store.sessionId, s.id]);

	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the change trigger
	useEffect(() => {
		const id = setTimeout(() => void fetchMore(), 150);
		return () => clearTimeout(id);
	}, [version, fetchMore]);

	useEffect(() => {
		if (!live) return;
		const id = setInterval(() => void fetchMore(), SAFETY_POLL_MS);
		return () => clearInterval(id);
	}, [live, fetchMore]);

	return {
		...data,
		reload: () => {
			nextByte.current = 0;
			setData({ messages: [], nextByte: 0, status: "loading", error: null });
			void fetchMore();
		},
	};
}

// ───────────────────────────── rendering ─────────────────────────────

function textOf(blocks: readonly UiBlock[]): string {
	return blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
}

interface ToolRun {
	id: string;
	name: string;
	args: unknown;
	intent?: string;
	result?: string;
	error?: boolean;
}

function ToolRow({ run }: { run: ToolRun }) {
	const [open, setOpen] = useState(false);
	const Icon = toolIcon(run.name);
	const summary = run.intent ?? summarizeArgs(run.args);
	const pending = run.result === undefined;
	return (
		<div className="overflow-hidden rounded-lg bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]">
			<button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex min-h-9 w-full items-center gap-2 px-2.5 py-1.5 text-left outline-none hover:bg-surface-2 focus-visible:bg-surface-2 coarse:min-h-11">
				<ChevronRight className={cn("size-3.5 shrink-0 text-subtle transition-transform duration-150", open && "rotate-90")} aria-hidden />
				<Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
				<span className="shrink-0 font-mono text-xs font-medium">{run.name}</span>
				<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summary}</span>
				{pending ? <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" aria-label={t("Running")} /> : run.error ? <X className="size-3.5 shrink-0 text-danger" aria-label={t("Failed")} /> : <Check className="size-3.5 shrink-0 text-success" aria-label={t("Done")} />}
			</button>
			{open ? (
				<div className="animate-fade-in flex flex-col gap-2 border-t p-2.5">
					<pre className="scrollbar-thin max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-2xs leading-4 text-muted-foreground">{prettyJson(run.args)}</pre>
					{run.result !== undefined ? (
						<pre className="scrollbar-thin max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-2 p-2 font-mono text-2xs leading-4">{run.result.length > RESULT_CAP ? `${run.result.slice(0, RESULT_CAP)}…` : run.result || t("(no output)")}</pre>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function Thought({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex flex-col gap-1">
			<button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-fit items-center gap-1.5 rounded-md py-0.5 pr-2 text-xs text-muted-foreground outline-none hover:text-foreground coarse:py-2">
				<ChevronRight className={cn("size-3 transition-transform duration-150", open && "rotate-90")} aria-hidden />
				<Brain className="size-3.5" aria-hidden /> {t("Thought")}
			</button>
			{open ? <div className="animate-fade-in ml-1.5 whitespace-pre-wrap border-l pl-3 text-[13px] leading-relaxed text-muted-foreground">{text}</div> : null}
		</div>
	);
}

const AssistantBlocks = memo(function AssistantBlocks({ msg, results }: { msg: UiMessage; results: ReadonlyMap<string, UiMessage> }) {
	return (
		<div className="flex flex-col gap-2">
			{msg.content.map((b, i) => {
				if (b.type === "text") return b.text.trim() ? <LazyMarkdown key={`t${i}`} text={b.text} /> : null;
				if (b.type === "thinking") return b.text.trim() ? <Thought key={`k${i}`} text={b.text} /> : null;
				if (b.type === "toolCall") {
					const r = results.get(b.id);
					return <ToolRow key={b.id || `c${i}`} run={{ id: b.id, name: b.name, args: b.arguments, intent: b.intent, result: r ? textOf(r.content) : undefined, error: r?.isError }} />;
				}
				return null;
			})}
			{msg.errorMessage ? <p className="rounded-lg bg-danger/8 px-3 py-2 text-xs text-danger">{msg.errorMessage}</p> : null}
		</div>
	);
});

function Assignment({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	const long = text.length > 220 || text.split("\n").length > 4;
	return (
		<div className="rounded-xl bg-surface-2 px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--border)]">
			<div className="mb-1 text-2xs font-medium uppercase tracking-wider text-subtle">{t("Assignment")}</div>
			<p className={cn("whitespace-pre-wrap break-words text-[13px] leading-relaxed text-muted-foreground", !open && long && "line-clamp-4")}>{text}</p>
			{long ? (
				<button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 text-xs font-medium text-accent outline-none hover:underline focus-visible:underline">
					{open ? t("Show less") : t("Show more")}
				</button>
			) : null}
		</div>
	);
}

/** Subagent transcript body: assignment, messages, tool calls with their results, steering messages. Follows new output while at the bottom. */
export default function SubagentTranscript({ store, s }: { store: OmpStore; s: SubagentRec }) {
	const log = useTranscript(store, s);
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const results = useMemo(() => new Map(log.messages.filter((m) => m.role === "toolResult" && m.toolCallId).map((m) => [m.toolCallId as string, m])), [log.messages]);
	const items = useMemo(() => log.messages.filter((m) => m.role === "user" || (m.role === "assistant" && m.content.length > 0)), [log.messages]);
	const firstUser = items.findIndex((m) => m.role === "user");

	// Follow the end while the reader is there; reading older output is never interrupted.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on content growth
	useEffect(() => {
		const el = scroller.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [items.length, results.size, s.recentOutput.length]);

	return (
		<div
			ref={scroller}
			onScroll={(e) => {
				const el = e.currentTarget;
				stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
			}}
			className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3"
		>
			{log.status === "loading" ? (
				<div className="flex flex-col gap-3" aria-busy="true" aria-label={t("Loading transcript")}>
					<Skeleton className="h-16 w-full rounded-xl" />
					<Skeleton className="h-4 w-4/5" />
					<Skeleton className="h-9 w-full rounded-lg" />
				</div>
			) : log.status === "error" ? (
				<div className="flex flex-col items-start gap-2 rounded-xl bg-danger/8 p-3 text-xs text-danger" role="alert">
					<span>{t("Could not load the transcript. {error}", { error: log.error ?? "" })}</span>
					<Button size="sm" variant="outline" onClick={log.reload}>
						{t("Retry")}
					</Button>
				</div>
			) : items.length === 0 ? (
				<p className="py-8 text-center text-xs text-muted-foreground">{isLive(s) ? t("Nothing written yet. It will appear as the subagent works.") : t("Nothing written yet.")}</p>
			) : (
				<div className="flex flex-col gap-4">
					{items.map((m, i) =>
						m.role === "user" ? (
							i === firstUser ? (
								<Assignment key={m.id} text={textOf(m.content)} />
							) : (
								<div key={m.id} className="animate-slide-up flex flex-col items-end gap-0.5">
									<span className="text-2xs font-medium text-subtle">{t("You")}</span>
									<p className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-accent-soft px-3 py-2 text-[13px] leading-relaxed">{textOf(m.content)}</p>
								</div>
							)
						) : (
							<div key={m.id} className="animate-slide-up">
								<AssistantBlocks msg={m} results={results} />
							</div>
						),
					)}
					{isLive(s) && (s.currentTool || s.stage) ? (
						<div className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
							<Loader2 className="size-3.5 animate-spin text-accent" aria-hidden />
							<span className="min-w-0 truncate">{s.currentTool ? `${s.currentTool}${s.currentToolArgs ? ` · ${s.currentToolArgs}` : ""}` : s.stage}</span>
						</div>
					) : null}
				</div>
			)}
		</div>
	);
}
