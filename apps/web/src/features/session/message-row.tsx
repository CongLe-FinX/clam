import type { UiBlock, UiMessage } from "@clam/contracts";
import { AlertTriangle, BookMarked, Bot, Brain, ChevronRight } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { CollapsibleText } from "@/components/collapsible-text";
import { CopyButton } from "@/components/code-block";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { projectFile, type RichFile } from "@/components/rich/assets";
import { FileChip } from "@/components/rich/file-chip";
import { FileStrip } from "@/components/rich/file-strip";
import { LazyLightbox } from "@/components/rich/lazy-lightbox";
import { RichImage } from "@/components/rich/rich-image";
import { t } from "@/i18n";
import { MeshMessageBubble, parseMeshMessage } from "@/features/tasks/mesh-message";
import { cn, formatCompact, formatCost, formatDate, formatNumber, formatTime } from "@/lib/utils";
import { type AttachedFileRef, splitAttachmentNote } from "./attachment-note.ts";
import { AsyncResultCard } from "./async-result.tsx";
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

/**
 * Where an inline image's bytes are: the server URL of a history-page image, else a `data:` URL of a live one, built once per block object
 * (the store keeps unchanged blocks referentially stable).
 */
const dataUrls = new WeakMap<object, string>();
function dataUrl(block: { mimeType: string; data: string; url?: string }): string {
	if (block.url) return block.url;
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
		for (const o of outputs) for (const f of o.files) byPath.set(f.path, projectFile(o.projectId, f));
		return [...byPath.values()];
	}, [outputs]);
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

type ImageBlock = Extract<UiBlock, { type: "image" }>;

/** The pictures a message carried (what the model saw): one is shown larger, several as a grid; each opens the lightbox on the whole set. */
function UserImages({ images }: { images: ImageBlock[] }) {
	const [open, setOpen] = useState<number | null>(null);
	const close = useCallback(() => setOpen(null), []);
	if (images.length === 1) return <RichImage src={dataUrl(images[0] as ImageBlock)} alt={t("Image you attached")} className="mt-1.5 max-w-[16rem]" />;
	return (
		<>
			<ul aria-label={t("Images you attached")} className="mt-1.5 grid grid-cols-3 gap-1.5">
				{images.map((img, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: user message blocks are immutable
					<li key={i}>
						<button type="button" onClick={() => setOpen(i)} aria-label={t("View image {number} of {count}", { number: i + 1, count: images.length })} className="relative block aspect-square w-full overflow-hidden rounded-lg bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)] outline-none focus-visible:ring-2 focus-visible:ring-ring">
							<img src={dataUrl(img)} alt="" loading="lazy" decoding="async" className="size-full cursor-zoom-in object-cover" />
						</button>
					</li>
				))}
			</ul>
			{open !== null ? <LazyLightbox items={images.map((img, i) => ({ src: dataUrl(img), alt: t("Image {number} of {count}", { number: i + 1, count: images.length }) }))} index={open} onIndexChange={setOpen} onClose={close} /> : null}
		</>
	);
}

/** The files a message names in its attachment block, as chips under the text (pictures the model also saw are the thumbnails above instead). */
function UserFiles({ files }: { files: readonly AttachedFileRef[] }) {
	const env = useSessionEnv();
	if (files.length === 0) return null;
	return (
		<ul aria-label={t("Files you attached")} className="mt-1.5 flex flex-wrap gap-1">
			{files.map((f) => {
				const name = f.path.slice(f.path.lastIndexOf("/") + 1);
				return (
					<li key={f.path} className="min-w-0 max-w-full">
						<FileChip file={projectFile(env.checkoutId, { path: f.path, name, size: 0, mimeType: "" })}>{name}</FileChip>
					</li>
				);
			})}
		</ul>
	);
}

function UserRow({ stream, rowKey }: { stream: SessionStream; rowKey: string }) {
	const rec = useMsgRec(stream, rowKey);
	const parsed = useMemo(() => {
		if (!rec) return null;
		const texts: string[] = [];
		const files: AttachedFileRef[] = [];
		for (const b of rec.msg.content) {
			if (b.type !== "text") continue;
			const split = splitAttachmentNote(b.text);
			texts.push(split.text);
			files.push(...split.files);
		}
		const images = rec.msg.content.filter((b): b is ImageBlock => b.type === "image");
		// A picture the model saw is already on screen as a thumbnail.
		return { texts, images, files: images.length > 0 ? files.filter((f) => !f.seen) : files };
	}, [rec]);
	if (!rec || !parsed) return null;
	const { msg } = rec;
	const mesh = parseMeshMessage(rec.copyText);
	if (mesh) return <MeshMessageBubble message={mesh} />;
	const sending = rec.optimistic && !rec.sent;
	const text = parsed.texts.join("\n\n");
	return (
		<div className="group/msg ml-auto flex w-full max-w-3xl flex-col items-end gap-1">
			<div className={cn("max-w-[88%] rounded-2xl rounded-br-md bg-surface-3 px-3.5 py-2 text-sm leading-relaxed shadow-[inset_0_0_0_1px_var(--border)] transition-opacity sm:max-w-[80%]", sending && "opacity-60")}>
				{text.trim() ? (
					<CollapsibleText expandedKey={`${stream.sessionId}:${rowKey}`}>
						<UserText text={text} />
					</CollapsibleText>
				) : null}
				{parsed.images.length > 0 ? <UserImages images={parsed.images} /> : null}
				<UserFiles files={parsed.files} />
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
	if (rec.msg.customType === "async-result") return <AsyncResultCard stream={stream} rowKey={rowKey} text={rec.copyText} />;
	// Other notices arrive wrapped in a tag (`<system-notice>…</system-notice>`): the tag is framing, not content.
	const text = rec.copyText.replace(/^\s*<([a-z-]+)>\s*([\s\S]*?)\s*<\/\1>\s*$/i, "$2");
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
