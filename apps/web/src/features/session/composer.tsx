import { PROMPT_IMAGES_MAX_COUNT, type PromptImage, routes } from "@clam/contracts";
import { ArrowUp, Clock, CornerDownRight, EyeOff, Loader2, Paperclip, RotateCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ComposerChips } from "@/components/composer/chips.tsx";
import { DropOverlay } from "@/components/composer/drop-overlay.tsx";
import { LargePasteBar } from "@/components/composer/large-paste-bar.tsx";
import { useFileDrop } from "@/components/composer/use-file-drop.ts";
import { useIsMobile } from "@/hooks/use-breakpoint";
import { T, t } from "@/i18n";
import { errorText, localUrl } from "@/lib/api";
import { readDraft, writeDraft } from "@/lib/draft-store.ts";
import { imageBudgetBytes, isVisionImage, prepareImage } from "@/lib/image-prep.ts";
import { type LargePaste, measurePaste, pasteAsFile } from "@/lib/large-paste.ts";
import { filesFromClipboard } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Kbd } from "@/ui/kbd";
import { Tip } from "@/ui/tooltip";
import { withAttachmentNote } from "./attachment-note.ts";
import { type ComposerFile, useComposerFiles } from "./composer-files.ts";
import { ModelPicker, ModelSettings, ThinkingPicker, useVisionInput } from "./model-pickers.tsx";
import { useSessionEnv } from "./session-env.ts";
import { isBusy, type SessionStream, useStreamMeta } from "./stream-store.ts";

const MOD_KEY = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform) ? "⌘" : "Ctrl";

/** The pictures of a send as vision input: the original bytes when small, else scaled down to fit; one that cannot be read stays a file. */
async function visionImages(files: readonly ComposerFile[], projectId: string): Promise<Map<number, PromptImage>> {
	const candidates = files.filter((f) => f.kind === "image" && isVisionImage({ type: f.type })).slice(0, PROMPT_IMAGES_MAX_COUNT);
	const budget = imageBudgetBytes(candidates.length);
	const out = new Map<number, PromptImage>();
	await Promise.all(
		candidates.map(async (f) => {
			try {
				const blob = f.file ?? (await (await fetch(localUrl(routes.projectRaw(projectId), { path: f.path }))).blob());
				const prepared = await prepareImage(blob, budget);
				if (prepared) out.set(f.id, { mimeType: prepared.mimeType, data: prepared.data });
			} catch {
				/* sent as a file only */
			}
		}),
	);
	return out;
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
		return { reason: t("Connecting to the runtime…"), restartable: false, loading: true };
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
	const [draft] = useState(() => readDraft("session", sessionId));
	const [value, setValue] = useState(draft.text);
	const [mode, setMode] = useState<"steer" | "followUp">("steer");
	const [restarting, setRestarting] = useState(false);
	const [sending, setSending] = useState(false);
	const [paste, setPaste] = useState<{ start: number; text: string; stats: LargePaste } | null>(null);
	const ref = useRef<HTMLTextAreaElement>(null);
	const { checkoutId } = useSessionEnv();
	const files = useComposerFiles(checkoutId, draft.files);
	const vision = useVisionInput(stream);
	const fileInput = useRef<HTMLInputElement>(null);
	const { dragging, handlers: drop } = useFileDrop(files.add);
	const mobile = useIsMobile();
	const touch = mobile || (coarsePointer?.matches ?? false);
	const busy = useStreamMeta(stream, isBusy);
	const aborting = useStreamMeta(stream, (m) => m.aborting);
	const queued = useStreamMeta(stream, (m) => m.live?.queued);
	const blocked = useBlockedReason(stream);
	const trimmed = value.trim();
	const readyCount = files.items.filter((i) => i.status === "ready").length;
	const hasContent = trimmed !== "" || readyCount > 0;
	const sendBlocked = blocked.reason !== null || files.uploading > 0 || files.failed > 0 || sending;
	const placeholder = blocked.reason ?? (busy ? (mode === "steer" ? t("Steer the agent…") : t("Queue a follow-up…")) : t("Message the agent…"));
	const pasted = paste && value.slice(paste.start, paste.start + paste.text.length) === paste.text ? paste : null;
	const hasPictures = files.items.some((i) => i.kind === "image");

	// Draft persistence (debounced; flushed on unmount): the text and the files that are already uploaded.
	const latest = useRef({ text: value, files: files.draftFiles });
	latest.current = { text: value, files: files.draftFiles };
	// biome-ignore lint/correctness/useExhaustiveDependencies: `latest` carries both
	useEffect(() => {
		const timer = setTimeout(() => writeDraft("session", sessionId, latest.current), 250);
		return () => clearTimeout(timer);
	}, [value, files.draftFiles, sessionId]);
	useEffect(() => () => writeDraft("session", sessionId, latest.current), [sessionId]);

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

	const submit = useCallback(
		async (behavior: "steer" | "followUp") => {
			const text = value.trim();
			if ((!text && readyCount === 0) || sendBlocked) return;
			setSending(true);
			let taken: ComposerFile[] = [];
			try {
				const ready = files.items.filter((i) => i.status === "ready");
				const seen = vision.supported ? await visionImages(ready, checkoutId) : new Map<number, PromptImage>();
				if (vision.supported && ready.some((f) => f.kind === "image" && isVisionImage({ type: f.type }) && !seen.has(f.id))) {
					toast.warning(t("Some pictures could not be prepared for the model; only their file paths are sent."));
				}
				taken = files.take();
				setValue("");
				setPaste(null);
				writeDraft("session", sessionId, { text: "", files: [] });
				const message = withAttachmentNote(
					text,
					taken.flatMap((f) => (f.path ? [{ path: f.path, seen: seen.has(f.id) }] : [])),
				);
				await stream.sendPrompt(
					message,
					behavior,
					taken.flatMap((f) => seen.get(f.id) ?? []),
				);
			} catch (e) {
				setValue((cur) => (cur.trim() ? `${text}\n${cur}` : text));
				files.restore(taken);
				toast.error(t("Message not sent: {error}", { error: errorText(e) }));
				ref.current?.focus();
			} finally {
				setSending(false);
			}
		},
		[value, readyCount, sendBlocked, files, vision.supported, checkoutId, sessionId, stream],
	);

	const attachPasteAsFile = () => {
		if (!pasted) return;
		files.add([pasteAsFile(pasted.text)]);
		setValue((cur) => cur.slice(0, pasted.start) + cur.slice(pasted.start + pasted.text.length));
		setPaste(null);
		ref.current?.focus();
	};

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
						"relative flex flex-col rounded-[1.375rem] bg-surface-1 transition-shadow duration-300",
						"shadow-[0_0_0_1px_var(--border-strong),0_12px_32px_-20px_rgb(15_18_25/0.4),0_2px_6px_-3px_rgb(15_18_25/0.08)]",
						"focus-within:shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent)_60%,transparent),0_0_0_4px_var(--accent-soft),0_14px_34px_-18px_color-mix(in_oklab,var(--accent)_50%,transparent)]",
						dragging && "shadow-[0_0_0_2px_var(--accent)]",
					)}
					{...drop}
				>
					{busy ? <span aria-hidden className="clam-orbit-ring" /> : null}
					<ComposerChips
						chips={files.chips.map((c) => (c.kind === "image" && !vision.supported ? { ...c, unseen: t("The model cannot see this picture; only its file path is sent") } : c))}
						onRemove={(id) => files.remove(id as number)}
						onRetry={(id) => files.retry(id as number)}
					/>
					{hasPictures && !vision.supported ? (
						<p role="status" className="mx-3 mt-2 flex items-start gap-1.5 text-2xs text-warning">
							<EyeOff aria-hidden className="mt-px size-3.5 shrink-0" />
							<span>{t("{model} cannot see pictures. They are saved in the project folder and the agent only gets their file paths.", { model: vision.modelName ?? t("This model") })}</span>
						</p>
					) : null}
					{pasted ? <LargePasteBar paste={pasted.stats} onAttach={attachPasteAsFile} onKeep={() => setPaste(null)} /> : null}
					<textarea
						ref={ref}
						onPaste={(e) => {
							const text = e.clipboardData.getData("text/plain");
							// Screenshots and copied files become attachments; cells copied from a spreadsheet (text + picture) paste as text.
							if (!text) {
								const pastedFiles = filesFromClipboard(e);
								if (pastedFiles.length > 0) {
									e.preventDefault();
									files.add(pastedFiles);
									return;
								}
							}
							const stats = measurePaste(text);
							if (stats) setPaste({ start: e.currentTarget.selectionStart, text: text.replace(/\r\n?/g, "\n"), stats });
						}}
						value={value}
						rows={1}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape" && pasted) {
								e.stopPropagation();
								setPaste(null);
								return;
							}
							// 229 = Safari reports the Enter that commits an IME composition after `compositionend`.
							if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
							const meta = e.metaKey || e.ctrlKey;
							if (meta || (!e.shiftKey && !touch)) {
								e.preventDefault();
								// While the agent works, Enter delivers the way the Steer/Queue switch says and Ctrl/Cmd+Enter the other way.
								void submit(busy && meta ? (mode === "steer" ? "followUp" : "steer") : mode);
							}
						}}
						placeholder={placeholder}
						aria-label={t("Message")}
						enterKeyHint={touch ? "enter" : "send"}
						autoCapitalize="sentences"
						className="scrollbar-thin block max-h-32 min-h-11 w-full resize-none overflow-y-auto bg-transparent px-4 pb-1 pt-3.5 text-base leading-relaxed outline-none [field-sizing:content] placeholder:text-subtle md:max-h-[12.5rem] md:text-sm"
					/>
					{dragging ? <DropOverlay>{t("Drop to attach to your message")}</DropOverlay> : null}
					<div className="flex items-center gap-1.5 px-2 pb-2">
						<div className="flex min-w-0 flex-1 items-center gap-1.5">
							<input
								ref={fileInput}
								type="file"
								multiple
								hidden
								onChange={(e) => {
									files.add(Array.from(e.target.files ?? []));
									e.target.value = "";
								}}
							/>
							<Tip label={t("Attach pictures and files (saved in the project folder)")}>
								<Button size="icon" variant="ghost" aria-label={t("Attach files")} onClick={() => fileInput.current?.click()} className="rounded-full text-muted-foreground hover:text-foreground">
									<Paperclip />
								</Button>
							</Tip>
							{busy ? (
								<div
									role="radiogroup"
									aria-label={t("Delivery while the agent is working")}
									className="relative grid shrink-0 animate-pop-in grid-cols-2 rounded-full bg-surface-2 p-0.5 shadow-[inset_0_0_0_1px_var(--border)]"
								>
									{/* The thumb slides under the chosen option; each column is half of the padded track, so 100% of its width is one column. */}
									<span
										aria-hidden
										className={cn(
											"absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-full bg-surface-1 shadow-[0_1px_3px_rgb(15_18_25/0.14),0_0_0_1px_var(--border)] transition-transform duration-300 ease-[var(--ease-spring)]",
											mode === "followUp" && "translate-x-full",
										)}
									/>
									{(
										[
											["steer", CornerDownRight, t("Steer"), t("Redirect the agent after its current step")],
											["followUp", Clock, t("Queue"), t("Send after the agent finishes this turn")],
										] as const
									).map(([id, Icon, label, tip]) => (
										<Tip key={id} label={`${label} · ${tip}`}>
											<button
												type="button"
												role="radio"
												aria-checked={mode === id}
												onClick={() => setMode(id)}
												className={cn(
													// Phones show the icon alone (the same arrow/clock that marks steering and queued messages above); wider screens add the word.
													"relative inline-flex h-6 items-center justify-center gap-1 rounded-full px-2.5 text-2xs font-medium outline-none transition-colors duration-200 focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-9 max-sm:w-9 max-sm:px-0 sm:coarse:px-3 [&_svg]:size-3.5 max-sm:[&_svg]:size-4",
													mode === id ? (id === "steer" ? "text-accent" : "text-foreground") : "text-subtle hover:text-foreground",
												)}
											>
												<Icon aria-hidden className={cn("transition-transform duration-300 ease-[var(--ease-spring)]", mode === id ? "scale-110" : "scale-95")} />
												<span className="max-sm:sr-only">{label}</span>
											</button>
										</Tip>
									))}
								</div>
							) : null}
							<ModelSettings stream={stream} className="sm:hidden" />
							<div className="hidden min-w-0 items-center gap-1.5 sm:flex md:hidden">
								<ModelPicker stream={stream} className="max-w-[9.5rem]" />
								<ThinkingPicker stream={stream} />
							</div>
							{files.uploading > 0 || files.failed > 0 ? (
								<span role="status" className={cn("flex min-w-0 items-center gap-1.5 truncate text-2xs", files.failed > 0 && files.uploading === 0 ? "text-danger" : "text-muted-foreground")}>
									{files.uploading > 0 ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden /> : <TriangleAlert className="size-3.5 shrink-0" aria-hidden />}
									<span className="truncate">
										{files.uploading > 0
											? t("{count, plural, one {Uploading # file…} other {Uploading # files…}}", { count: files.uploading })
											: t("{count, plural, one {# upload failed: retry or remove it to send} other {# uploads failed: retry or remove them to send}}", { count: files.failed })}
									</span>
								</span>
							) : touch ? null : (
								<span className="hidden truncate text-2xs text-subtle md:inline">
									{busy ? (
										<T
											text="<k1>↵</k1> {first} · <k2>{mod}↵</k2> {second} · <k3>Esc</k3> stop"
											params={{ first: mode === "steer" ? t("steer") : t("queue"), second: mode === "steer" ? t("queue") : t("steer"), mod: MOD_KEY }}
											tags={{ k1: <Kbd />, k2: <Kbd />, k3: <Kbd /> }}
										/>
									) : (
										<T text="<k1>↵</k1> send · <k2>⇧↵</k2> newline · <k3>{mod}V</k3> paste pictures" params={{ mod: MOD_KEY }} tags={{ k1: <Kbd />, k2: <Kbd />, k3: <Kbd /> }} />
									)}
								</span>
							)}
						</div>
						{busy ? (
							<Tip label={aborting ? t("Stopping…") : t("Stop the agent")} shortcut="Esc">
								{/* Stop sits inside a turning arc: the button itself says the agent is working. */}
								<button
									type="button"
									aria-label={t("Stop the agent")}
									onClick={abort}
									disabled={aborting}
									className="relative grid size-8 shrink-0 animate-pop-in place-items-center rounded-full bg-surface-2 text-foreground outline-none transition-[background-color,transform] duration-200 hover:bg-surface-3 focus-visible:shadow-[0_0_0_2px_var(--accent)] active:scale-90 disabled:opacity-60 coarse:size-11"
								>
									<svg viewBox="0 0 36 36" aria-hidden className="absolute inset-0 size-full animate-spin [animation-duration:1.6s]">
										<circle cx="18" cy="18" r="16.75" fill="none" strokeWidth="1.5" className="stroke-border" />
										<circle cx="18" cy="18" r="16.75" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="28 78" className="stroke-accent" />
									</svg>
									{aborting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <span aria-hidden className="size-2.5 rounded-[3px] bg-current coarse:size-3" />}
								</button>
							</Tip>
						) : null}
						<button
							type="button"
							aria-label={busy ? (mode === "steer" ? t("Send steering message") : t("Queue follow-up")) : t("Send message")}
							disabled={!hasContent || sendBlocked}
							onClick={() => void submit(mode)}
							className={cn(
								"grid size-8 shrink-0 place-items-center rounded-full outline-none transition-[background-color,color,box-shadow,transform,filter] duration-300 ease-[var(--ease-spring)] focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:size-11 [&_svg]:size-4 coarse:[&_svg]:size-5",
								hasContent && !sendBlocked
									? "scale-100 bg-[linear-gradient(145deg,color-mix(in_oklab,var(--accent)_78%,#fff),var(--accent)_55%,color-mix(in_oklab,var(--accent)_82%,#000))] text-accent-foreground shadow-[0_6px_16px_-6px_color-mix(in_oklab,var(--accent)_75%,transparent),inset_0_1px_0_rgb(255_255_255/0.25)] hover:brightness-110 active:scale-90"
									: "scale-95 bg-surface-2 text-subtle",
							)}
						>
							{sending ? <Loader2 className="animate-spin" aria-hidden /> : <ArrowUp aria-hidden strokeWidth={2.5} />}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
