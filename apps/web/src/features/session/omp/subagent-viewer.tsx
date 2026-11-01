import { Send, Square, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { t } from "@/i18n";
import { errorText } from "@/lib/api";
import { cn, formatDuration } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/ui/sheet";
import { Skeleton } from "@/ui/skeleton";
import { Tip } from "@/ui/tooltip";
import { type OmpStore, type SubagentRec, useOmpState } from "./omp-store.ts";
import { Avatar, StatusChip, SubagentStats, elapsedMs, isLive, modelParts, useClock, useStop } from "./subagent-ui.tsx";

const Transcript = lazy(() => import("./subagent-transcript.tsx"));

function SteerBox({ store, s }: { store: OmpStore; s: SubagentRec }) {
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const ref = useRef<HTMLTextAreaElement>(null);
	const send = async (): Promise<void> => {
		const message = text.trim();
		if (!message || sending) return;
		setSending(true);
		try {
			await store.steerSubagent(s.id, message);
			setText("");
			toast.success(t("Sent to {id}", { id: s.id }));
		} catch (e) {
			toast.error(t("{id} did not take the message: {error}", { id: s.id, error: errorText(e) }));
		} finally {
			setSending(false);
			ref.current?.focus();
		}
	};
	return (
		<div className="flex shrink-0 items-end gap-2 border-t bg-surface-1 px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
			<textarea
				ref={ref}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
						e.preventDefault();
						void send();
					}
				}}
				rows={1}
				placeholder={t("Message {id}…", { id: s.id })}
				aria-label={t("Message {id}", { id: s.id })}
				className="scrollbar-thin max-h-32 min-h-10 flex-1 resize-none rounded-xl bg-surface-2 px-3 py-2.5 text-[13.5px] leading-snug shadow-[inset_0_0_0_1px_var(--border)] outline-none [field-sizing:content] placeholder:text-subtle focus-visible:shadow-[inset_0_0_0_1.5px_var(--accent)]"
			/>
			<Tip label={t("Send")} shortcut="Enter">
				<Button variant="primary" size="icon" aria-label={t("Send message")} loading={sending} disabled={text.trim() === ""} onClick={() => void send()} className="size-10 coarse:size-11">
					<Send />
				</Button>
			</Tip>
		</div>
	);
}

function ViewerHeader({ store, s, onClose }: { store: OmpStore; s: SubagentRec; onClose: () => void }) {
	const live = isLive(s);
	const now = useClock(live);
	const model = modelParts(s.model);
	const { stopping, stop } = useStop(store, s);
	return (
		<div className="flex shrink-0 flex-col gap-2 border-b px-4 pt-3 pb-3">
			<div className="flex items-center gap-3">
				<Avatar name={s.id} index={s.index} />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<SheetTitle className="truncate text-[15px]">{s.id}</SheetTitle>
					<SheetDescription className="flex min-w-0 items-center gap-1.5 truncate">
						<span className="shrink-0">{s.agent}</span>
						{model ? (
							<>
								<span aria-hidden>·</span>
								<span className="truncate font-mono text-2xs" title={s.model ?? undefined}>
									{model.name}
									{model.thinking ? ` · ${model.thinking}` : ""}
								</span>
							</>
						) : null}
					</SheetDescription>
				</div>
				{live ? (
					<Button variant="outline" size="sm" loading={stopping} onClick={stop} className="text-danger">
						<Square className="fill-current" /> {t("Stop")}
					</Button>
				) : null}
				<Button variant="ghost" size="icon" aria-label={t("Close transcript")} onClick={onClose}>
					<X />
				</Button>
			</div>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<StatusChip status={s.status} />
				<span className="tabular font-mono text-2xs text-subtle">{formatDuration(elapsedMs(s, now))}</span>
				<SubagentStats s={s} />
			</div>
			{s.description ? <p className="line-clamp-2 text-xs text-muted-foreground">{s.description}</p> : null}
		</div>
	);
}

/**
 * The open subagent's transcript: a right-hand drawer on desktop/tablet, a full-screen sheet on phones. Opens from a Team
 * card row or the Subagents tab; steering and stopping work from here too.
 */
export function SubagentViewer({ store }: { store: OmpStore }) {
	const { viewing, subagents } = useOmpState(store);
	const bp = useBreakpoint();
	const mobile = bp === "mobile";
	const found = subagents.find((s) => s.id === viewing);
	// Keep the last subagent while the sheet animates out.
	const last = useRef<SubagentRec | undefined>(undefined);
	if (found) last.current = found;
	const s = found ?? last.current;

	// A subagent that disappears (removed) closes its viewer.
	useEffect(() => {
		if (viewing && subagents.length > 0 && !found) store.openSubagent(null);
	}, [viewing, found, subagents.length, store]);

	return (
		<Sheet open={viewing !== null && s !== undefined} onOpenChange={(open) => !open && store.openSubagent(null)}>
			<SheetContent
				side={mobile ? "bottom" : "right"}
				className={cn("p-0", mobile ? "h-[100dvh] max-h-[100dvh] rounded-none pt-safe" : "w-[min(96vw,640px)]")}
				aria-describedby={s ? undefined : undefined}
			>
				{s ? (
					<>
						<ViewerHeader store={store} s={s} onClose={() => store.openSubagent(null)} />
						<Suspense
							fallback={
								<div className="flex flex-col gap-3 p-4" aria-busy="true">
									<Skeleton className="h-16 w-full rounded-xl" />
									<Skeleton className="h-4 w-4/5" />
								</div>
							}
						>
							<Transcript key={s.id} store={store} s={s} />
						</Suspense>
						{isLive(s) ? <SteerBox key={s.id} store={store} s={s} /> : null}
					</>
				) : null}
			</SheetContent>
		</Sheet>
	);
}
