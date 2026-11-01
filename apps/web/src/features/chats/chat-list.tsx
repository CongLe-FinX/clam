import type { AgentSession } from "@clam/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import { SessionRow } from "@/components/session-row";
import { ChatRowMenu } from "./chat-actions";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/** Above this many rows (chats plus day headings) the list is virtualized; shorter lists are plain DOM. */
const VIRTUALIZE_AFTER = 60;

type Item = { kind: "heading"; key: string; label: string } | { kind: "chat"; key: string; chat: AgentSession };

const DAY = 86_400_000;

function startOfDay(ts: number): number {
	const d = new Date(ts);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function bucket(updatedAt: string, today: number): string {
	const day = startOfDay(Date.parse(updatedAt));
	if (day >= today) return t("Today");
	if (day >= today - DAY) return t("Yesterday");
	if (day >= today - 6 * DAY) return t("Previous 7 days");
	if (day >= today - 29 * DAY) return t("Previous 30 days");
	return t("Earlier");
}

/** Chats are already sorted by recency; a heading is inserted whenever the day bucket changes. */
function groupByDay(chats: readonly AgentSession[]): Item[] {
	const today = startOfDay(Date.now());
	const items: Item[] = [];
	let current = "";
	for (const chat of chats) {
		const label = bucket(chat.updatedAt, today);
		if (label !== current) {
			current = label;
			items.push({ kind: "heading", key: `h:${label}`, label });
		}
		items.push({ kind: "chat", key: chat.id, chat });
	}
	return items;
}

function Heading({ label }: { label: string }) {
	return <h2 className="border-b bg-surface-1 px-4 pb-1.5 pt-3.5 text-2xs font-semibold uppercase tracking-wider text-subtle">{label}</h2>;
}

/** A chat row with its "⋯" menu (hover/focus on desktop, always on touch). */
function ChatRow({ chat }: { chat: AgentSession }) {
	return (
		<div className="group/row flex items-center pr-2">
			<SessionRow session={chat} className="min-w-0 flex-1 border-b-0" />
			<ChatRowMenu session={chat} />
		</div>
	);
}

/**
 * The chats of this machine grouped by day (Today / Yesterday / …). Long lists render only the rows in view. The list is its
 * own scroll area that shrinks to its content, so a short list sits under the header and a long one scrolls.
 */
export function ChatList({ chats, className }: { chats: readonly AgentSession[]; className?: string }) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const items = useMemo(() => groupByDay(chats), [chats]);
	const virtual = items.length > VIRTUALIZE_AFTER;
	const v = useVirtualizer({
		count: virtual ? items.length : 0,
		getScrollElement: () => scrollRef.current,
		estimateSize: (i) => (items[i]?.kind === "heading" ? 38 : 60),
		overscan: 10,
		getItemKey: (i) => items[i]?.key ?? i,
	});

	return (
		<div ref={scrollRef} className={cn("scrollbar-thin min-h-0 overflow-y-auto overscroll-contain rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]", className)}>
			{virtual ? (
				<div className="relative w-full" style={{ height: v.getTotalSize() }}>
					{v.getVirtualItems().map((item) => {
						const it = items[item.index];
						if (!it) return null;
						return (
							<div key={item.key} data-index={item.index} ref={v.measureElement} className={cn("absolute left-0 top-0 w-full", it.kind === "chat" && "border-b")} style={{ transform: `translateY(${item.start}px)` }}>
								{it.kind === "heading" ? <Heading label={it.label} /> : <ChatRow chat={it.chat} />}
							</div>
						);
					})}
				</div>
			) : (
				items.map((it) =>
					it.kind === "heading" ? (
						<Heading key={it.key} label={it.label} />
					) : (
						<div key={it.key} className="border-b last:border-b-0">
							<ChatRow chat={it.chat} />
						</div>
					),
				)
			)}
		</div>
	);
}
