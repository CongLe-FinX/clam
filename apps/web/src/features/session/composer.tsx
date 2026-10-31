import { ArrowUp, Clock, CornerDownRight, Loader2, RotateCw, Square } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useIsMobile } from "@/hooks/use-breakpoint";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Kbd } from "@/ui/kbd";
import { Tip } from "@/ui/tooltip";
import { ModelPicker, ThinkingPicker } from "./model-pickers.tsx";
import { isBusy, type SessionStream, useStreamMeta } from "./stream-store.ts";

const draftKey = (id: string) => `clam.draft:${id}`;
function readDraft(id: string): string {
	try {
		return sessionStorage.getItem(draftKey(id)) ?? "";
	} catch {
		return "";
	}
}
function writeDraft(id: string, value: string): void {
	try {
		if (value) sessionStorage.setItem(draftKey(id), value);
		else sessionStorage.removeItem(draftKey(id));
	} catch {
		/* storage unavailable: the draft just isn't kept */
	}
}

const coarsePointer = typeof matchMedia === "function" ? matchMedia("(pointer: coarse)") : null;

/** Why sending is blocked right now, or null when the composer can send. */
function useBlockedReason(stream: SessionStream): { reason: string | null; restartable: boolean; loading: boolean } {
	const live = useStreamMeta(stream, (m) => m.live);
	const status = useStreamMeta(stream, (m) => m.liveStatus);
	if (!live) {
		if (status === "error") return { reason: "Runtime unavailable — see the banner above", restartable: false, loading: false };
		return { reason: "Starting runtime…", restartable: false, loading: true };
	}
	switch (live.runtime.state) {
		case "crashed":
			return { reason: "The runtime crashed", restartable: true, loading: false };
		case "stopped":
			return { reason: "The runtime is stopped", restartable: true, loading: false };
		case "starting":
		case "restarting":
			return { reason: "Runtime is starting…", restartable: false, loading: true };
		default:
			return { reason: null, restartable: false, loading: false };
	}
}

export function Composer({
	stream,
	fill,
	keyboardOpen,
	className,
}: {
	stream: SessionStream;
	/** Replaces the draft when `nonce` changes (starter prompts). */
	fill: { text: string; nonce: number } | null;
	keyboardOpen: boolean;
	className?: string;
}) {
	const sessionId = stream.sessionId;
	const [value, setValue] = useState(() => readDraft(sessionId));
	const [mode, setMode] = useState<"steer" | "followUp">("steer");
	const [restarting, setRestarting] = useState(false);
	const ref = useRef<HTMLTextAreaElement>(null);
	const mobile = useIsMobile();
	const touch = mobile || (coarsePointer?.matches ?? false);
	const busy = useStreamMeta(stream, isBusy);
	const aborting = useStreamMeta(stream, (m) => m.aborting);
	const queued = useStreamMeta(stream, (m) => m.live?.queued);
	const blocked = useBlockedReason(stream);
	const trimmed = value.trim();
	const placeholder = blocked.reason ?? (busy ? (mode === "steer" ? "Steer the agent…" : "Queue a follow-up…") : "Message the agent…");

	// Draft persistence (debounced; flushed on unmount).
	const latest = useRef(value);
	latest.current = value;
	useEffect(() => {
		const t = setTimeout(() => writeDraft(sessionId, value), 250);
		return () => clearTimeout(t);
	}, [value, sessionId]);
	useEffect(() => () => writeDraft(sessionId, latest.current), [sessionId]);

	useEffect(() => {
		if (fill) {
			setValue(fill.text);
			ref.current?.focus();
		}
	}, [fill]);

	// Auto-grow. Re-measured when the width changes (placeholder/text wrapping depends on it).
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const fit = () => {
			el.style.height = "auto";
			el.style.height = `${Math.min(el.scrollHeight, touch ? 132 : 240)}px`;
		};
		fit();
		let width = el.clientWidth;
		const ro = new ResizeObserver(() => {
			if (el.clientWidth === width) return;
			width = el.clientWidth;
			fit();
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [value, touch, placeholder]);

	const submit = useCallback(async () => {
		const text = value.trim();
		if (!text || blocked.reason) return;
		setValue("");
		writeDraft(sessionId, "");
		try {
			await stream.sendPrompt(text, mode);
		} catch (e) {
			setValue((cur) => (cur.trim() ? `${text}\n${cur}` : text));
			toast.error(`Message not sent: ${errorMessage(e)}`);
			ref.current?.focus();
		}
	}, [value, blocked.reason, sessionId, stream, mode]);

	const abort = useCallback(() => {
		stream.abort().catch((e) => toast.error(`Could not stop the agent: ${errorMessage(e)}`));
	}, [stream]);

	// Esc stops the running turn from anywhere on the page (unless a dialog/popover owns Esc).
	const abortRef = useRef(abort);
	abortRef.current = abort;
	const canAbort = busy && !aborting;
	useEffect(() => {
		if (!canAbort) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
			if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"]')) return;
			abortRef.current();
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, [canAbort]);

	const restart = async () => {
		setRestarting(true);
		try {
			await stream.restartRuntime();
		} catch (e) {
			toast.error(`Could not restart the runtime: ${errorMessage(e)}`);
		} finally {
			setRestarting(false);
		}
	};

	const steering = queued?.steering ?? [];
	const followUps = queued?.followUp ?? [];

	return (
		<div className={cn("shrink-0 px-3 pt-1 sm:px-4", keyboardOpen ? "pb-2" : "pb-3 pb-safe", className)}>
			<div className="mx-auto w-full max-w-3xl">
				{steering.length + followUps.length > 0 ? (
					<ul aria-label="Queued messages" className="scrollbar-none mb-2 flex gap-1.5 overflow-x-auto">
						{steering.map((q, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: queue strings are not unique ids
							<li key={`s${i}`} title={q} className="flex max-w-[16rem] shrink-0 items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-2xs text-accent">
								<CornerDownRight className="size-3 shrink-0" aria-hidden />
								<span className="sr-only">Steering:</span>
								<span className="truncate">{q}</span>
							</li>
						))}
						{followUps.map((q, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: queue strings are not unique ids
							<li key={`f${i}`} title={q} className="flex max-w-[16rem] shrink-0 items-center gap-1.5 rounded-full bg-surface-3 px-2.5 py-1 text-2xs text-muted-foreground">
								<Clock className="size-3 shrink-0" aria-hidden />
								<span className="sr-only">Queued follow-up:</span>
								<span className="truncate">{q}</span>
							</li>
						))}
					</ul>
				) : null}

				{blocked.reason ? (
					<div role="status" className="mb-2 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-1.5 text-xs text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
						{blocked.loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
						<span className="min-w-0 flex-1 truncate">{blocked.reason}</span>
						{blocked.restartable ? (
							<Button size="sm" variant="outline" loading={restarting} onClick={() => void restart()}>
								<RotateCw /> Restart
							</Button>
						) : null}
					</div>
				) : null}

				<div className="flex flex-col rounded-2xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border-strong)] transition-shadow focus-within:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)]">
					<textarea
						ref={ref}
						value={value}
						rows={1}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
							const meta = e.metaKey || e.ctrlKey;
							if (meta || (!e.shiftKey && !touch)) {
								e.preventDefault();
								void submit();
							}
						}}
						placeholder={placeholder}
						aria-label="Message"
						enterKeyHint={touch ? "enter" : "send"}
						autoCapitalize="sentences"
						className="scrollbar-thin block max-h-60 min-h-11 w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-sm leading-relaxed outline-none placeholder:text-subtle"
					/>
					<div className="flex items-center gap-1.5 px-2 pb-2">
						<div className="flex min-w-0 flex-1 items-center gap-1.5">
							{busy ? (
								<div role="radiogroup" aria-label="Delivery while the agent is working" className="flex shrink-0 rounded-lg bg-surface-2 p-0.5 shadow-[inset_0_0_0_1px_var(--border)]">
									{(
										[
											["steer", "Steer", "Redirect the agent after its current step"],
											["followUp", "Queue", "Send after the agent finishes this turn"],
										] as const
									).map(([id, label, tip]) => (
										<Tip key={id} label={tip}>
											<button
												type="button"
												role="radio"
												aria-checked={mode === id}
												onClick={() => setMode(id)}
												className={cn(
													"h-6 rounded-md px-2.5 text-2xs font-medium outline-none transition-colors coarse:h-9 coarse:px-3",
													mode === id ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:text-foreground",
												)}
											>
												{label}
											</button>
										</Tip>
									))}
								</div>
							) : null}
							<div className="flex min-w-0 items-center gap-1.5 md:hidden">
								<ModelPicker stream={stream} className="max-w-[9.5rem]" />
								<ThinkingPicker stream={stream} />
							</div>
							{touch ? null : (
								<span className="hidden truncate text-2xs text-subtle md:inline">
									<Kbd>↵</Kbd> send · <Kbd>⇧↵</Kbd> newline{busy ? " · " : ""}
									{busy ? <Kbd>Esc</Kbd> : null}
									{busy ? " stop" : ""}
								</span>
							)}
						</div>
						{busy ? (
							<Tip label={aborting ? "Stopping…" : "Stop the agent"} shortcut="Esc">
								<Button size="icon" variant="outline" aria-label="Stop the agent" onClick={abort} disabled={aborting} className="rounded-xl">
									{aborting ? <Loader2 className="animate-spin" /> : <Square className="fill-current" />}
								</Button>
							</Tip>
						) : null}
						<Button size="icon" variant="primary" aria-label={busy ? (mode === "steer" ? "Send steering message" : "Queue follow-up") : "Send message"} disabled={!trimmed || blocked.reason !== null} onClick={() => void submit()} className="rounded-xl">
							<ArrowUp />
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
