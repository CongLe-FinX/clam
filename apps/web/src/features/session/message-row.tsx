import type { UiBlock, UiMessage } from "@clam/contracts";
import { AlertTriangle, BookMarked, Bot, Brain, ChevronRight } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { CopyButton } from "@/components/code-block";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { projectFile, type RichFile } from "@/components/rich/assets";
import { FileStrip } from "@/components/rich/file-strip";
import { RichImage } from "@/components/rich/rich-image";
import { t } from "@/i18n";
import { MeshMessageBubble, parseMeshMessage } from "@/features/tasks/mesh-message";
import { cn, formatCompact, formatCost, formatDate, formatNumber, formatTime } from "@/lib/utils";
import { useSessionEnv } from "./session-env.ts";
import { type SessionStream, useMsgRec, useMsgRole, useMsgSlice, useRowOutputs } from "./stream-store.ts";
import { ToolCard } from "./tool-card.tsx";

function Shimmer({ children }: { children: ReactNode }) {
	return (
		<span className="relative inline-block overflow-hidden text-muted-foreground before:absolute before:inset-0 before:-translate-x-full before:animate-[clam-shimmer_1.6s_ease-in-out_infinite] before:bg-gradient-to-r before:from-transparent before:via-foreground/20 before:to-transparent">
			{children}
		</span>
	);
}

const ThinkingBlock = memo(function ThinkingBlock({ text, streaming, redacted }: { text: string; streaming: boolean; redacted?: boolean }) {
	const [open, setOpen] = useState(false);
	const words = text.trim() ? text.trim().split(/\s+/).length : 0;
	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="group/think flex w-fit items-center gap-1.5 rounded-md py-0.5 pr-2 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground coarse:py-2"
			>
				<ChevronRight className={cn("size-3 transition-transform duration-150", open && "rotate-90")} aria-hidden />
				<Brain className="size-3.5" aria-hidden />
				{streaming ? <Shimmer>{t("Thinking…")}</Shimmer> : <span>{redacted ? t("Reasoning (redacted)") : words ? t("Thought · {count, plural, one {# word} other {# words}}", { count: words }) : t("Thought")}</span>}
			</button>
			{open ? (
				<div className="animate-fade-in ml-1.5 border-l pl-3.5">
					<div className="scrollbar-thin max-h-72 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">{redacted ? t("This reasoning is not available.") : text || "…"}</div>
				</div>
			) : null}
		</div>
	);
});

/** `data:` URL of an inline image, built once per block object (the store keeps unchanged blocks referentially stable). */
const dataUrls = new WeakMap<object, string>();
function dataUrl(block: { mimeType: string; data: string }): string {
	let url = dataUrls.get(block);
	if (!url) {
		url = `data:${block.mimeType};base64,${block.data}`;
		dataUrls.set(block, url);
	}
	return url;
}

const BlockView = memo(function BlockView({ stream, block, streaming, last }: { stream: SessionStream; block: UiBlock; streaming: boolean; last: boolean }) {
	const env = useSessionEnv();
	switch (block.type) {
		case "text":
			return block.text ? (
				<div className="w-full min-w-0">
					<LazyMarkdown text={block.text} assets={env.assets} />
				</div>
			) : null;
		case "thinking":
			return <ThinkingBlock text={block.text} redacted={block.redacted} streaming={streaming && last} />;
		case "toolCall":
			return <ToolCard stream={stream} block={{ id: block.id, name: block.name, arguments: block.arguments, intent: block.intent }} />;
		case "image":
			return <RichImage src={dataUrl(block)} alt={t("Image from the agent")} className="self-start" />;
	}
});

function stopNote(msg: UiMessage): { label: string; tone: "warning" | "danger" } | null {
	switch (msg.stopReason) {
		case "aborted":
			return { label: t("Interrupted"), tone: "warning" };
		case "length":
			return { label: t("Cut off at the output limit"), tone: "warning" };
		case "error":
			return { label: t("Failed"), tone: "danger" };
		default:
			return null;
	}
}

function UsageFooter({ msg, copyText }: { msg: UiMessage; copyText: string }) {
	const u = msg.usage;
	return (
		<div className="flex min-h-7 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-2xs text-subtle">
			<span className="tabular">{formatTime(msg.timestamp)}</span>
			{msg.model ? <span className="max-w-[16rem] truncate font-mono">{msg.model}</span> : null}
			{u ? (
				<>
					<span className="tabular font-mono" title={t("input {input} · output {output} · cache read {cacheRead} · cache write {cacheWrite}", { input: formatNumber(u.tokens.input), output: formatNumber(u.tokens.output), cacheRead: formatNumber(u.tokens.cacheRead), cacheWrite: formatNumber(u.tokens.cacheWrite) })}>
						↑{formatCompact(u.tokens.input)} ↓{formatCompact(u.tokens.output)}
						{u.tokens.cacheRead ? ` ⚡${formatCompact(u.tokens.cacheRead)}` : ""}
					</span>
					<span className="tabular font-mono">{formatCost(u.cost)}</span>
				</>
			) : null}
			{copyText ? <CopyButton text={copyText} label={t("Copy message")} className="size-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/msg:opacity-100 coarse:size-11 coarse:opacity-100" /> : null}
		</div>
	);
}

/** Files the agent's turn created or changed, shown under the turn's last assistant message. Subscribes to its own row only. */
const TurnFiles = memo(function TurnFiles({ stream, rowKey }: { stream: SessionStream; rowKey: string }) {
	const outputs = useRowOutputs(stream, rowKey);
	const env = useSessionEnv();
	const files = useMemo(() => {
		if (!outputs) return [];
		// A path touched by several turns of the same message is listed once (latest entry wins).
		const byPath = new Map<string, RichFile>();
		for (const o of outputs) for (const f of o.files) byPath.set(f.path, projectFile(env.projectId, f));
		return [...byPath.values()];
	}, [outputs, env.projectId]);
	const { openFile } = env;
	const onOpen = useCallback(
		(file: RichFile) => {
			if (file.path) openFile(file.path);
		},
		[openFile],
	);
	if (!outputs || files.length === 0) return null;
	return (
		<div className="flex flex-col gap-1.5">
			<FileStrip files={files} onOpen={onOpen} />
			{outputs.some((o) => o.truncated) ? <p className="text-2xs text-subtle">{t("+ more files changed. Open the Files panel to see them all.")}</p> : null}
		</div>
	);
});

function AssistantRow({ stream, rowKey, first }: { stream: SessionStream; rowKey: string; first: boolean }) {
	const rec = useMsgRec(stream, rowKey);
	const env = useSessionEnv();
	if (!rec) return null;
	const { msg, streaming } = rec;
	const blocks = msg.content;
	const visible = blocks.some((b) => (b.type === "text" ? b.text.length > 0 : true));
	const note = streaming ? null : stopNote(msg);
	const error = msg.errorMessage ?? (msg.stopReason === "error" ? t("The model returned an error.") : null);
	const lastIsThinking = blocks[blocks.length - 1]?.type === "thinking";
	return (
		<div className="group/msg flex flex-col gap-2.5">
			{first ? (
				<div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
					<span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
						<Bot className="size-3.5" />
					</span>
					<span className="truncate font-medium text-foreground/90">{env.agentName}</span>
					{msg.model ? <span className="max-w-[12rem] truncate rounded-md bg-surface-2 px-1.5 py-px font-mono text-2xs text-subtle">{msg.model.split("/").pop()}</span> : null}
				</div>
			) : null}
			{blocks.map((b, i) => (
				<BlockView
					// Content order is append-only while streaming, so the index is a stable identity; tool calls key by their id.
					key={b.type === "toolCall" ? b.id : i}
					stream={stream}
					block={b}
					streaming={streaming}
					last={i === blocks.length - 1}
				/>
			))}
			{streaming && visible && !lastIsThinking ? <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-accent" /> : null}
			{streaming ? null : <TurnFiles stream={stream} rowKey={rowKey} />}
			{error ? (
				<div role="alert" className="flex max-w-3xl items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--danger)_30%,transparent)]">
					<AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
					<span className="min-w-0 whitespace-pre-wrap break-words">{error}</span>
				</div>
			) : note ? (
				<span className={cn("w-fit rounded-md px-1.5 py-0.5 text-2xs font-medium", note.tone === "warning" ? "bg-warning/14 text-warning" : "bg-danger/13 text-danger")}>{note.label}</span>
			) : null}
			{!streaming && (visible || msg.usage) ? <UsageFooter msg={msg} copyText={rec.copyText} /> : null}
		</div>
	);
}

/** The first prompt of a new session in a project with shared context starts with a project-memory block (written by the server). */
const MEMORY_END = "\n[end of project memory]\n\n";
function splitMemoryPreface(text: string): { memory: string; header: string; rest: string } | null {
	if (!text.startsWith("[CL Agent Mesh] project memory")) return null;
	const end = text.indexOf(MEMORY_END);
	if (end < 0) return null;
	const block = text.slice(0, end);
	const nl = block.indexOf("\n");
	return { header: (nl < 0 ? block : block.slice(0, nl)).replace("[CL Agent Mesh] ", ""), memory: nl < 0 ? "" : block.slice(nl + 1), rest: text.slice(end + MEMORY_END.length) };
}

function UserText({ text }: { text: string }) {
	const pre = splitMemoryPreface(text);
	if (!pre) return <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{text}</p>;
	return (
		<>
			<details className="mb-1.5 rounded-lg bg-surface-2/70 px-2.5 py-1.5 text-xs text-muted-foreground">
				<summary className="flex min-h-6 cursor-pointer select-none items-center gap-1.5 coarse:min-h-11">
					<BookMarked aria-hidden className="size-3.5 shrink-0" />
					<span className="min-w-0 flex-1 truncate">{pre.header}</span>
				</summary>
				<pre className="mt-1.5 max-h-60 overflow-y-auto whitespace-pre-wrap break-words font-sans text-2xs leading-relaxed [overflow-wrap:anywhere]">{pre.memory}</pre>
			</details>
			<p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{pre.rest}</p>
		</>
	);
}

function UserRow({ stream, rowKey }: { stream: SessionStream; rowKey: string }) {
	const rec = useMsgRec(stream, rowKey);
	if (!rec) return null;
	const { msg } = rec;
	const mesh = parseMeshMessage(rec.copyText);
	if (mesh) return <MeshMessageBubble message={mesh} />;
	const sending = rec.optimistic && !rec.sent;
	return (
		<div className="group/msg ml-auto flex w-full max-w-3xl flex-col items-end gap-1">
			<div className={cn("max-w-[88%] rounded-2xl rounded-br-md bg-surface-3 px-3.5 py-2 text-sm leading-relaxed shadow-[inset_0_0_0_1px_var(--border)] transition-opacity sm:max-w-[80%]", sending && "opacity-60")}>
				{msg.content.map((b, i) =>
					b.type === "text" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: user message blocks are immutable
						<UserText key={i} text={b.text} />
					) : b.type === "image" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: user message blocks are immutable
						<RichImage key={i} src={dataUrl(b)} alt={t("Image you attached")} className="mt-1 max-w-[16rem]" />
					) : null,
				)}
			</div>
			<div className="flex min-h-6 items-center gap-1.5 text-2xs text-subtle">
				{sending ? <span>{t("Sending…")}</span> : <span className="tabular">{formatTime(msg.timestamp)}</span>}
				{rec.copyText ? <CopyButton text={rec.copyText} label={t("Copy prompt")} className="size-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/msg:opacity-100 coarse:size-11 coarse:opacity-100" /> : null}
			</div>
		</div>
	);
}

function CustomRow({ stream, rowKey }: { stream: SessionStream; rowKey: string }) {
	const rec = useMsgRec(stream, rowKey);
	if (!rec) return null;
	const text = rec.copyText;
	return (
		<div className="flex flex-col gap-1 rounded-lg bg-surface-1 px-3 py-2 text-xs text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
			{rec.msg.customType ? <span className="font-mono text-2xs uppercase tracking-wider text-subtle">{rec.msg.customType}</span> : null}
			{text ? <div className="line-clamp-6 whitespace-pre-wrap break-words">{text}</div> : null}
		</div>
	);
}

const DAY_LABEL: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
const DAY_LABEL_YEAR: Intl.DateTimeFormatOptions = { ...DAY_LABEL, year: "numeric" };
const GAP_MS = 15 * 60_000;

const startOfDay = (ts: number): number => {
	const d = new Date(ts);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Divider text between two rows: a day label for the first row / a new day, a clock time after a quiet gap, else null. Stable primitive. */
function gapLabel(ts: number, prevTs: number | undefined): string | null {
	if (prevTs !== undefined && startOfDay(prevTs) === startOfDay(ts)) return ts - prevTs < GAP_MS ? null : formatTime(ts);
	const day = startOfDay(ts);
	const rel = day === startOfDay(Date.now()) ? t("Today") : day === startOfDay(Date.now() - 86_400_000) ? t("Yesterday") : new Date(ts).getFullYear() === new Date().getFullYear() ? formatDate(ts, DAY_LABEL) : formatDate(ts, DAY_LABEL_YEAR);
	return t("{day} · {time}", { day: rel, time: formatTime(ts) });
}

/** Plays the enter animation for rows that arrived live only; a virtualizer remount of a seen row never replays it. */
function useEnter(stream: SessionStream, rowKey: string): boolean {
	const [live] = useState(() => stream.isLiveRow(rowKey));
	useEffect(() => {
		stream.seenRow(rowKey);
	}, [stream, rowKey]);
	return live;
}

const ENTER = "animate-[clam-slide-up_160ms_var(--ease-out-quint)_both]";

/** One conversation row. Subscribes to a single message record, so list re-renders never touch it. */
export const MessageRow = memo(function MessageRow({ stream, rowKey, prevKey }: { stream: SessionStream; rowKey: string; prevKey: string | undefined }) {
	const role = useMsgRole(stream, rowKey);
	const prevRole = useMsgRole(stream, prevKey ?? "");
	const gap = useMsgSlice(stream, rowKey, (rec) => (rec ? gapLabel(rec.msg.timestamp, prevKey ? stream.getRec(prevKey)?.msg.timestamp : undefined) : null));
	const live = useEnter(stream, rowKey);
	if (role !== "user" && role !== "assistant" && role !== "custom") return null;
	const tight = role === "assistant" && prevRole === "assistant" && gap === null;
	return (
		<div className={cn(tight ? "pt-2" : "pt-5", live && ENTER)}>
			{gap ? (
				<div role="separator" aria-label={gap} className="mb-4 flex justify-center">
					<span className="tabular rounded-full bg-surface-2 px-2.5 py-0.5 text-2xs text-subtle shadow-[inset_0_0_0_1px_var(--border)]">{gap}</span>
				</div>
			) : null}
			{role === "user" ? <UserRow stream={stream} rowKey={rowKey} /> : role === "assistant" ? <AssistantRow stream={stream} rowKey={rowKey} first={prevRole !== "assistant" || gap !== null} /> : <CustomRow stream={stream} rowKey={rowKey} />}
		</div>
	);
});
