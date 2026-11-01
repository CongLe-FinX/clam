import { ArrowUp, Clock, CornerDownRight, Loader2, Paperclip, RotateCw, Square } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { UploadDock, useProjectUploads } from "@/features/projects/uploads.tsx";
import { useIsMobile } from "@/hooks/use-breakpoint";
import { T, t } from "@/i18n";
import { errorText } from "@/lib/api";
import { filesFromClipboard, hasFiles } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Kbd } from "@/ui/kbd";
import { Tip } from "@/ui/tooltip";
import { ModelPicker, ModelSettings, ThinkingPicker } from "./model-pickers.tsx";
import { useSessionEnv } from "./session-env.ts";
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
/** Browsers with `field-sizing: content` grow the textarea natively: no JS measuring per keystroke. */
const NATIVE_SIZING = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");

/** Why sending is blocked right now, or null when the composer can send. */
function useBlockedReason(stream: SessionStream): { reason: string | null; restartable: boolean; loading: boolean } {
	const live = useStreamMeta(stream, (m) => m.live);
	const status = useStreamMeta(stream, (m) => m.liveStatus);
	if (!live) {
		if (status === "error") return { reason: t("Runtime unavailable — see the banner above"), restartable: false, loading: false };
		return { reason: t("Starting runtime…"), restartable: false, loading: true };
	}
	switch (live.runtime.state) {
		case "crashed":
			return { reason: t("The runtime crashed"), restartable: true, loading: false };
		case "stopped":
			return { reason: t("The runtime is stopped"), restartable: true, loading: false };
		case "starting":
		case "restarting":
			return { reason: t("Runtime is starting…"), restartable: false, loading: true };
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
	const { projectId } = useSessionEnv();
	const uploads = useProjectUploads(projectId);
	const fileInput = useRef<HTMLInputElement>(null);
	const dragDepth = useRef(0);
	const [dragging, setDragging] = useState(false);
	const announced = useRef(new Set<number>());
	const mobile = useIsMobile();
	const touch = mobile || (coarsePointer?.matches ?? false);
	const busy = useStreamMeta(stream, isBusy);
	const aborting = useStreamMeta(stream, (m) => m.aborting);
	const queued = useStreamMeta(stream, (m) => m.live?.queued);
	const blocked = useBlockedReason(stream);
	const trimmed = value.trim();
	const placeholder = blocked.reason ?? (busy ? (mode === "steer" ? t("Steer the agent…") : t("Queue a follow-up…")) : t("Message the agent…"));

	// Draft persistence (debounced; flushed on unmount).
	const latest = useRef(value);
	latest.current = value;
	useEffect(() => {
		const timer = setTimeout(() => writeDraft(sessionId, value), 250);
		return () => clearTimeout(timer);
	}, [value, sessionId]);
	useEffect(() => () => writeDraft(sessionId, latest.current), [sessionId]);

	useEffect(() => {
		if (fill) {
			setValue(fill.text);
			ref.current?.focus();
		}
	}, [fill]);

	// Auto-grow (fallback for browsers without `field-sizing`): one scrollHeight read per change, plus a single width observer
	// because wrapping (and so the height) depends on the width.
	const fit = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, touch ? 132 : 200)}px`;
	}, [touch]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: value/placeholder change the height
	useLayoutEffect(() => {
		if (!NATIVE_SIZING) fit();
	}, [fit, value, placeholder]);
	useEffect(() => {
		const el = ref.current;
		if (NATIVE_SIZING || !el) return;
		let width = el.clientWidth;
		const ro = new ResizeObserver(() => {
			if (el.clientWidth === width) return;
			width = el.clientWidth;
			fit();
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [fit]);

	// A finished upload lands in the project folder: reference it in the draft so the agent knows which file is meant.
	useEffect(() => {
		const done = uploads.items.filter((i) => i.status === "done" && !announced.current.has(i.id));
		if (done.length === 0) return;
		for (const i of done) announced.current.add(i.id);
		const refs = done.map((i) => `\`${i.path}\``).join(" ");
		setValue((cur) => (cur.trim() ? `${cur.replace(/\s+$/, "")} ${refs} ` : `${refs} `));
		ref.current?.focus();
	}, [uploads.items]);

	const submit = useCallback(async () => {
		const text = value.trim();
		if (!text || blocked.reason) return;
		setValue("");
		writeDraft(sessionId, "");
		try {
			await stream.sendPrompt(text, mode);
		} catch (e) {
			setValue((cur) => (cur.trim() ? `${text}\n${cur}` : text));
			toast.error(t("Message not sent: {error}", { error: errorText(e) }));
			ref.current?.focus();
		}
	}, [value, blocked.reason, sessionId, stream, mode]);

	const abort = useCallback(() => {
		stream.abort().catch((e) => toast.error(t("Could not stop the agent: {error}", { error: errorText(e) })));
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
			toast.error(t("Could not restart the runtime: {error}", { error: errorText(e) }));
		} finally {
			setRestarting(false);
		}
	};

	const steering = queued?.steering ?? [];
	const followUps = queued?.followUp ?? [];

	return (
		<div className={cn("shrink-0 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-1 sm:px-4", keyboardOpen ? "pb-2" : "pb-3 pb-safe", className)}>
			<div className="mx-auto w-full max-w-[60rem]">
				{steering.length + followUps.length > 0 ? (
					<ul aria-label={t("Queued messages")} className="scrollbar-none mb-2 flex gap-1.5 overflow-x-auto">
						{steering.map((q, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: queue strings are not unique ids
							<li key={`s${i}`} title={q} className="flex max-w-[16rem] shrink-0 items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-2xs text-accent">
								<CornerDownRight className="size-3 shrink-0" aria-hidden />
								<span className="sr-only">{t("Steering:")}</span>
								<span className="truncate">{q}</span>
							</li>
						))}
						{followUps.map((q, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: queue strings are not unique ids
							<li key={`f${i}`} title={q} className="flex max-w-[16rem] shrink-0 items-center gap-1.5 rounded-full bg-surface-3 px-2.5 py-1 text-2xs text-muted-foreground">
								<Clock className="size-3 shrink-0" aria-hidden />
								<span className="sr-only">{t("Queued follow-up:")}</span>
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
								<RotateCw /> {t("Restart")}
							</Button>
						) : null}
					</div>
				) : null}

				<div
					className={cn(
						"relative flex flex-col rounded-2xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border-strong)] transition-shadow focus-within:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)]",
						dragging && "shadow-[inset_0_0_0_2px_var(--accent)]",
					)}
					onDragEnter={(e) => {
						if (!hasFiles(e)) return;
						dragDepth.current++;
						setDragging(true);
					}}
					onDragOver={(e) => {
						if (!hasFiles(e)) return;
						e.preventDefault();
						e.dataTransfer.dropEffect = "copy";
					}}
					onDragLeave={(e) => {
						if (!hasFiles(e)) return;
						dragDepth.current = Math.max(0, dragDepth.current - 1);
						if (dragDepth.current === 0) setDragging(false);
					}}
					onDrop={(e) => {
						if (!hasFiles(e)) return;
						e.preventDefault();
						dragDepth.current = 0;
						setDragging(false);
						uploads.upload(Array.from(e.dataTransfer.files), "");
					}}
				>
					<textarea
						ref={ref}
						onPaste={(e) => {
							// Screenshots and copied files become uploads; rich text (e.g. spreadsheet cells) pastes as text.
							if (e.clipboardData.types.includes("text/html")) return;
							const files = filesFromClipboard(e);
							if (files.length === 0) return;
							e.preventDefault();
							uploads.upload(files, "");
						}}
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
						aria-label={t("Message")}
						enterKeyHint={touch ? "enter" : "send"}
						autoCapitalize="sentences"
						className="scrollbar-thin block max-h-32 min-h-11 w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-base leading-relaxed outline-none [field-sizing:content] placeholder:text-subtle md:max-h-[12.5rem] md:text-sm"
					/>
					<UploadDock uploads={uploads} />
					{dragging ? (
						<div aria-hidden className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl bg-accent-soft text-xs font-medium text-accent">
							{t("Drop to add to the project folder")}
						</div>
					) : null}
					<div className="flex items-center gap-1.5 px-2 pb-2">
						<div className="flex min-w-0 flex-1 items-center gap-1.5">
							<input
								ref={fileInput}
								type="file"
								multiple
								hidden
								onChange={(e) => {
									uploads.upload(Array.from(e.target.files ?? []), "");
									e.target.value = "";
								}}
							/>
							<Tip label={t("Attach files to the project folder")}>
								<Button size="icon" variant="ghost" aria-label={t("Attach files")} onClick={() => fileInput.current?.click()} className="rounded-xl">
									<Paperclip />
								</Button>
							</Tip>
							{busy ? (
								<div role="radiogroup" aria-label={t("Delivery while the agent is working")} className="flex shrink-0 rounded-lg bg-surface-2 p-0.5 shadow-[inset_0_0_0_1px_var(--border)]">
									{(
										[
											["steer", t("Steer"), t("Redirect the agent after its current step")],
											["followUp", t("Queue"), t("Send after the agent finishes this turn")],
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
							<ModelSettings stream={stream} className="max-w-[10.5rem] sm:hidden" />
							<div className="hidden min-w-0 items-center gap-1.5 sm:flex md:hidden">
								<ModelPicker stream={stream} className="max-w-[9.5rem]" />
								<ThinkingPicker stream={stream} />
							</div>
							{touch ? null : (
								<span className="hidden truncate text-2xs text-subtle md:inline">
									{busy ? (
										<T text="<k1>↵</k1> send · <k2>⇧↵</k2> newline · <k3>Esc</k3> stop" tags={{ k1: <Kbd />, k2: <Kbd />, k3: <Kbd /> }} />
									) : (
										<T text="<k1>↵</k1> send · <k2>⇧↵</k2> newline" tags={{ k1: <Kbd />, k2: <Kbd /> }} />
									)}
								</span>
							)}
						</div>
						{busy ? (
							<Tip label={aborting ? t("Stopping…") : t("Stop the agent")} shortcut="Esc">
								<Button size="icon" variant="outline" aria-label={t("Stop the agent")} onClick={abort} disabled={aborting} className="rounded-xl">
									{aborting ? <Loader2 className="animate-spin" /> : <Square className="fill-current" />}
								</Button>
							</Tip>
						) : null}
						<Button size="icon" variant={trimmed && blocked.reason === null ? "primary" : "secondary"} aria-label={busy ? (mode === "steer" ? t("Send steering message") : t("Queue follow-up")) : t("Send message")} disabled={!trimmed || blocked.reason !== null} onClick={() => void submit()} className="rounded-xl">
							<ArrowUp />
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
