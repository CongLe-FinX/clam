import type { UiBlock, UiMessage } from "@clam/contracts";
import { AlertTriangle, Brain, ChevronRight } from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { CopyButton } from "@/components/code-block";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { MeshMessageBubble, parseMeshMessage } from "@/features/tasks/mesh-message";
import { cn, formatCompact, formatCost } from "@/lib/utils";
import { type SessionStream, useMsgRec, useMsgRole } from "./stream-store.ts";
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
				{streaming ? <Shimmer>Thinking…</Shimmer> : <span>{redacted ? "Reasoning (redacted)" : words ? `Thought · ${words} words` : "Thought"}</span>}
			</button>
			{open ? (
				<div className="animate-fade-in ml-1.5 border-l pl-3.5">
					<div className="scrollbar-thin max-h-72 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">{redacted ? "This reasoning is not available." : text || "…"}</div>
				</div>
			) : null}
		</div>
	);
});

const BlockView = memo(function BlockView({ stream, block, streaming, last }: { stream: SessionStream; block: UiBlock; streaming: boolean; last: boolean }) {
	switch (block.type) {
		case "text":
			return block.text ? <LazyMarkdown text={block.text} /> : null;
		case "thinking":
			return <ThinkingBlock text={block.text} redacted={block.redacted} streaming={streaming && last} />;
		case "toolCall":
			return <ToolCard stream={stream} block={{ id: block.id, name: block.name, arguments: block.arguments, intent: block.intent }} />;
		case "image":
			return <img alt="" src={`data:${block.mimeType};base64,${block.data}`} className="max-h-80 max-w-full rounded-lg object-contain shadow-[inset_0_0_0_1px_var(--border)]" loading="lazy" />;
	}
});

const time = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" });

function stopNote(msg: UiMessage): { label: string; tone: "warning" | "danger" } | null {
	switch (msg.stopReason) {
		case "aborted":
			return { label: "Interrupted", tone: "warning" };
		case "length":
			return { label: "Cut off at the output limit", tone: "warning" };
		case "error":
			return { label: "Failed", tone: "danger" };
		default:
			return null;
	}
}

function UsageFooter({ msg, copyText }: { msg: UiMessage; copyText: string }) {
	const u = msg.usage;
	return (
		<div className="flex min-h-7 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-2xs text-subtle">
			<span className="tabular">{time.format(msg.timestamp)}</span>
			{msg.model ? <span className="max-w-[16rem] truncate font-mono">{msg.model}</span> : null}
			{u ? (
				<>
					<span className="tabular font-mono" title={`input ${u.tokens.input} · output ${u.tokens.output} · cache read ${u.tokens.cacheRead} · cache write ${u.tokens.cacheWrite}`}>
						↑{formatCompact(u.tokens.input)} ↓{formatCompact(u.tokens.output)}
						{u.tokens.cacheRead ? ` ⚡${formatCompact(u.tokens.cacheRead)}` : ""}
					</span>
					<span className="tabular font-mono">{formatCost(u.cost)}</span>
				</>
			) : null}
			{copyText ? <CopyButton text={copyText} label="Copy message" className="size-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/msg:opacity-100 coarse:opacity-100" /> : null}
		</div>
	);
}

function AssistantRow({ stream, rowKey }: { stream: SessionStream; rowKey: string }) {
	const rec = useMsgRec(stream, rowKey);
	if (!rec) return null;
	const { msg, streaming } = rec;
	const blocks = msg.content;
	const visible = blocks.some((b) => (b.type === "text" ? b.text.length > 0 : true));
	const note = streaming ? null : stopNote(msg);
	const error = msg.errorMessage ?? (msg.stopReason === "error" ? "The model returned an error." : null);
	const lastIsThinking = blocks[blocks.length - 1]?.type === "thinking";
	return (
		<div className="group/msg flex flex-col gap-2.5">
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
			{streaming && !visible ? (
				<div className="text-[13px]">
					<Shimmer>Working…</Shimmer>
				</div>
			) : null}
			{streaming && visible && !lastIsThinking ? <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-accent" /> : null}
			{error ? (
				<div role="alert" className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--danger)_30%,transparent)]">
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

function UserRow({ stream, rowKey }: { stream: SessionStream; rowKey: string }) {
	const rec = useMsgRec(stream, rowKey);
	if (!rec) return null;
	const { msg } = rec;
	const mesh = parseMeshMessage(rec.copyText);
	if (mesh) return <MeshMessageBubble message={mesh} />;
	const sending = rec.optimistic && !rec.sent;
	return (
		<div className="group/msg flex flex-col items-end gap-1">
			<div className={cn("max-w-[88%] rounded-2xl rounded-br-md bg-surface-3 px-3.5 py-2 text-sm leading-relaxed shadow-[inset_0_0_0_1px_var(--border)] transition-opacity sm:max-w-[80%]", sending && "opacity-60")}>
				{msg.content.map((b, i) =>
					b.type === "text" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: user message blocks are immutable
						<p key={i} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
							{b.text}
						</p>
					) : b.type === "image" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: user message blocks are immutable
						<img key={i} alt="" src={`data:${b.mimeType};base64,${b.data}`} className="mt-1 max-h-60 rounded-lg" loading="lazy" />
					) : null,
				)}
			</div>
			<div className="flex min-h-6 items-center gap-1.5 text-2xs text-subtle">
				{sending ? <span>Sending…</span> : <span className="tabular">{time.format(msg.timestamp)}</span>}
				{rec.copyText ? <CopyButton text={rec.copyText} label="Copy prompt" className="size-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/msg:opacity-100 coarse:opacity-100" /> : null}
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

/** One conversation row. Subscribes to a single message record, so list re-renders never touch it. */
export const MessageRow = memo(function MessageRow({ stream, rowKey }: { stream: SessionStream; rowKey: string }) {
	const role = useMsgRole(stream, rowKey);
	if (role === "user") return <UserRow stream={stream} rowKey={rowKey} />;
	if (role === "assistant") return <AssistantRow stream={stream} rowKey={rowKey} />;
	if (role === "custom") return <CustomRow stream={stream} rowKey={rowKey} />;
	return null;
});
