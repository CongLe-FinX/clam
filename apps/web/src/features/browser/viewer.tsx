import type { BrowserClientMessage, BrowserDevice, BrowserViewport } from "@clam/contracts";
import { Keyboard, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { clamp, cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { copyAnswerToClipboard } from "./clipboard.ts";
import type { ConnState, TabConnection, ViewerParams } from "./connection.ts";
import { browserStats } from "./stats.ts";

export interface ViewerHandle {
	/** Focus the hidden text sink (raises the soft keyboard on touch devices). */
	focusKeyboard(): void;
	blurKeyboard(): void;
}

interface Size {
	width: number;
	height: number;
}

interface ViewerProps {
	conn: TabConnection | null;
	state: ConnState;
	viewport: BrowserViewport | null;
	device: BrowserDevice;
	/** Called with the measured viewer area so the next socket (another tab) starts with the right size. */
	onViewerSize: (params: Omit<ViewerParams, "device">) => void;
	onFocusAddress: () => void;
	onRetry: () => void;
	ref?: Ref<ViewerHandle>;
	className?: string;
}

const RESIZE_DEBOUNCE_MS = 150;
const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 500;
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;
const BUTTON_NAMES = ["left", "middle", "right", "back", "forward"] as const;

const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
	(e.altKey ? MOD.alt : 0) | (e.ctrlKey ? MOD.ctrl : 0) | (e.metaKey ? MOD.meta : 0) | (e.shiftKey ? MOD.shift : 0);

/** Keys the browser's IME/soft keyboard resolves itself: they arrive through composition / `input` events instead. */
const isImeKey = (e: KeyboardEvent): boolean => e.isComposing || e.keyCode === 229 || e.key === "Unidentified" || e.key === "Dead" || e.key === "Process";

export function BrowserViewer({ conn, state, viewport, device, onViewerSize, onFocusAddress, onRetry, ref, className }: ViewerProps) {
	const areaRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const textRef = useRef<HTMLTextAreaElement>(null);
	const [area, setArea] = useState<Size>({ width: 0, height: 0 });
	const [frameVp, setFrameVp] = useState<Size | null>(null);
	const [hasFrame, setHasFrame] = useState(false);
	const [kbdFocused, setKbdFocused] = useState(false);
	const [composing, setComposing] = useState("");

	// What coordinates map to: the viewport the latest frame was captured at, else the announced one, else the area (fit).
	const vp: Size = frameVp ?? (viewport ? { width: viewport.width, height: viewport.height } : null) ?? (area.width > 0 ? area : { width: 1, height: 1 });
	const vpRef = useRef(vp);
	const mobileRef = useRef(false);
	const onFocusAddressRef = useRef(onFocusAddress);
	useLayoutEffect(() => {
		vpRef.current = vp;
		mobileRef.current = viewport?.mobile ?? device === "iphone";
		onFocusAddressRef.current = onFocusAddress;
	});

	useImperativeHandle(ref, () => ({
		focusKeyboard: () => textRef.current?.focus({ preventScroll: true }),
		blurKeyboard: () => textRef.current?.blur(),
	}));

	// Letterbox: the viewport's aspect inside the area. iPhone mode never upscales (a 440 px page stays 440 px at most).
	const maxScale = device === "iphone" ? 1 : 2;
	const scale = area.width > 0 && vp.width > 0 ? Math.min(area.width / vp.width, area.height / vp.height, maxScale) : 1;
	const cssWidth = Math.floor(vp.width * scale);
	const cssHeight = Math.floor(vp.height * scale);

	// ── viewer size (+ device) → server, debounced; the area state itself updates immediately for the letterbox.
	useEffect(() => {
		const el = areaRef.current;
		if (!el) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const push = () => {
			const r = el.getBoundingClientRect();
			const width = Math.round(r.width);
			const height = Math.round(r.height);
			if (width < 50 || height < 50) return;
			const params = { width, height, dpr: clamp(window.devicePixelRatio || 1, 1, 4) };
			onViewerSize(params);
			conn?.setViewer({ ...params, device });
		};
		push();
		const ro = new ResizeObserver((entries) => {
			const box = entries[0]?.contentRect;
			if (box) setArea((prev) => (prev.width === Math.round(box.width) && prev.height === Math.round(box.height) ? prev : { width: Math.round(box.width), height: Math.round(box.height) }));
			clearTimeout(timer);
			timer = setTimeout(push, RESIZE_DEBOUNCE_MS);
		});
		ro.observe(el);
		return () => {
			clearTimeout(timer);
			ro.disconnect();
		};
	}, [conn, device, onViewerSize]);

	// ── screencast visibility: tab visible AND the viewer on screen.
	useEffect(() => {
		const el = areaRef.current;
		if (!conn || !el) return;
		let intersecting = true;
		const update = () => conn.setVisible(intersecting && document.visibilityState === "visible");
		const io = new IntersectionObserver((entries) => {
			const last = entries[entries.length - 1];
			if (last) intersecting = last.isIntersecting;
			update();
		});
		io.observe(el);
		document.addEventListener("visibilitychange", update);
		update();
		return () => {
			io.disconnect();
			document.removeEventListener("visibilitychange", update);
		};
	}, [conn]);

	// ── debug stats + frame drawing: only the newest decoded frame is ever painted.
	useEffect(() => browserStats.acquire(), []);
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!conn || !canvas) return;
		const ctx = canvas.getContext("2d", { alpha: false });
		if (!ctx) return;
		let latest: ImageBitmap | null = null;
		let raf = 0;
		let lastVp: Size | null = null;
		const draw = () => {
			raf = 0;
			const bmp = latest;
			latest = null;
			if (!bmp) return;
			if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
				canvas.width = bmp.width;
				canvas.height = bmp.height;
			}
			ctx.drawImage(bmp, 0, 0);
			browserStats.frameDrawn(bmp.width, bmp.height);
			bmp.close();
			setHasFrame(true);
		};
		conn.setFrameSink((bmp, info) => {
			latest?.close();
			latest = bmp;
			if (info.viewportWidth > 0 && (!lastVp || lastVp.width !== info.viewportWidth || lastVp.height !== info.viewportHeight)) {
				lastVp = { width: info.viewportWidth, height: info.viewportHeight };
				setFrameVp(lastVp);
			}
			raf ||= requestAnimationFrame(draw);
		});
		return () => {
			conn.setFrameSink(null);
			cancelAnimationFrame(raf);
			latest?.close();
			latest = null;
		};
	}, [conn]);

	// ── input: pointer, wheel, touch, keyboard, IME.
	useEffect(() => {
		const canvas = canvasRef.current;
		const text = textRef.current;
		if (!conn || !canvas || !text) return;
		const send = (msg: BrowserClientMessage) => {
			browserStats.inputSent();
			conn.send(msg);
		};
		const toPage = (clientX: number, clientY: number) => {
			const rect = canvas.getBoundingClientRect();
			const v = vpRef.current;
			return { x: clamp(((clientX - rect.left) / rect.width) * v.width, 0, v.width), y: clamp(((clientY - rect.top) / rect.height) * v.height, 0, v.height), k: rect.width > 0 ? v.width / rect.width : 1 };
		};
		const mouse = (action: "move" | "down" | "up" | "wheel", x: number, y: number, extra: { button?: (typeof BUTTON_NAMES)[number] | "none"; buttons?: number; clickCount?: number; deltaX?: number; deltaY?: number; mods?: number }) =>
			send({ type: "mouse", action, x, y, button: extra.button ?? "none", buttons: extra.buttons ?? 0, clickCount: extra.clickCount ?? 0, deltaX: extra.deltaX ?? 0, deltaY: extra.deltaY ?? 0, modifiers: extra.mods ?? 0 });
		const focusText = () => text.focus({ preventScroll: true });

		// rAF-coalesced moves and wheel deltas keep the socket quiet under 120 Hz input.
		let raf = 0;
		let pendingMove: { x: number; y: number; buttons: number; mods: number } | null = null;
		let pendingWheel: { x: number; y: number; dx: number; dy: number; mods: number } | null = null;
		let pendingTouch: Array<{ id: number; x: number; y: number }> | null = null;
		let touchMods = 0;
		const flush = () => {
			raf = 0;
			if (pendingMove) {
				const m = pendingMove;
				pendingMove = null;
				mouse("move", m.x, m.y, { buttons: m.buttons, mods: m.mods });
			}
			if (pendingWheel) {
				const w = pendingWheel;
				pendingWheel = null;
				mouse("wheel", w.x, w.y, { deltaX: w.dx, deltaY: w.dy, mods: w.mods });
			}
			if (pendingTouch) {
				const points = pendingTouch;
				pendingTouch = null;
				send({ type: "touch", action: "move", points, modifiers: touchMods });
			}
		};
		const schedule = () => {
			raf ||= requestAnimationFrame(flush);
		};
		const flushNow = () => {
			cancelAnimationFrame(raf);
			flush();
		};
		const queueWheel = (x: number, y: number, dx: number, dy: number, mods: number) => {
			pendingWheel = pendingWheel ? { x, y, dx: pendingWheel.dx + dx, dy: pendingWheel.dy + dy, mods } : { x, y, dx, dy, mods };
			schedule();
		};

		// Mouse (and pen). Touch has its own path below; its compatibility mouse events are cancelled there.
		let dragging = false;
		let downCount = 1;
		const onMouseMove = (e: MouseEvent) => {
			if (dragging && e.currentTarget === canvas) return; // the window listener owns the drag
			const p = toPage(e.clientX, e.clientY);
			pendingMove = { x: p.x, y: p.y, buttons: e.buttons & 31, mods: modifiers(e) };
			schedule();
		};
		const onMouseDown = (e: MouseEvent) => {
			e.preventDefault(); // keep focus on the text sink, no native selection/drag
			focusText();
			flushNow();
			const p = toPage(e.clientX, e.clientY);
			downCount = Math.max(1, Math.min(5, e.detail || 1));
			mouse("down", p.x, p.y, { button: BUTTON_NAMES[e.button] ?? "left", buttons: e.buttons & 31, clickCount: downCount, mods: modifiers(e) });
			dragging = true;
			window.addEventListener("mousemove", onMouseMove);
			window.addEventListener("mouseup", onMouseUp);
		};
		const onMouseUp = (e: MouseEvent) => {
			flushNow();
			const p = toPage(e.clientX, e.clientY);
			mouse("up", p.x, p.y, { button: BUTTON_NAMES[e.button] ?? "left", buttons: e.buttons & 31, clickCount: downCount, mods: modifiers(e) });
			if (e.buttons === 0) {
				dragging = false;
				window.removeEventListener("mousemove", onMouseMove);
				window.removeEventListener("mouseup", onMouseUp);
			}
		};
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const p = toPage(e.clientX, e.clientY);
			const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vpRef.current.height : 1;
			queueWheel(p.x, p.y, e.deltaX * unit * p.k, e.deltaY * unit * p.k, modifiers(e));
		};
		const onContextMenu = (e: Event) => e.preventDefault();

		// Touch: real touch events on mobile viewports; on desktop viewports tap → click, drag → wheel.
		let gesture: { mobile: boolean; startX: number; startY: number; startAt: number; maxTouches: number; moved: boolean; lastCx: number; lastCy: number } | null = null;
		const touchPoints = (list: TouchList) =>
			Array.from(list, (t) => {
				const p = toPage(t.clientX, t.clientY);
				return { id: t.identifier, x: p.x, y: p.y };
			});
		const centroid = (list: TouchList) => {
			let cx = 0;
			let cy = 0;
			for (const t of Array.from(list)) {
				cx += t.clientX;
				cy += t.clientY;
			}
			return { cx: cx / Math.max(1, list.length), cy: cy / Math.max(1, list.length) };
		};
		const onTouchStart = (e: TouchEvent) => {
			if (e.cancelable) e.preventDefault();
			touchMods = modifiers(e);
			const { cx, cy } = centroid(e.touches);
			if (!gesture || e.touches.length === e.changedTouches.length) {
				gesture = { mobile: mobileRef.current, startX: cx, startY: cy, startAt: performance.now(), maxTouches: e.touches.length, moved: false, lastCx: cx, lastCy: cy };
			} else {
				gesture.maxTouches = Math.max(gesture.maxTouches, e.touches.length);
				gesture.lastCx = cx;
				gesture.lastCy = cy;
			}
			if (gesture.mobile) {
				flushNow();
				send({ type: "touch", action: "start", points: touchPoints(e.touches), modifiers: touchMods });
			}
		};
		const onTouchMove = (e: TouchEvent) => {
			if (e.cancelable) e.preventDefault();
			if (!gesture) return;
			const { cx, cy } = centroid(e.touches);
			if (gesture.mobile) {
				if (!gesture.moved && Math.hypot(cx - gesture.startX, cy - gesture.startY) >= TAP_SLOP_PX) gesture.moved = true;
				pendingTouch = touchPoints(e.touches);
				schedule();
				return;
			}
			if (!gesture.moved && Math.hypot(cx - gesture.startX, cy - gesture.startY) < TAP_SLOP_PX) return;
			gesture.moved = true;
			const p = toPage(cx, cy);
			// Natural scrolling: content follows the fingers.
			queueWheel(p.x, p.y, (gesture.lastCx - cx) * p.k, (gesture.lastCy - cy) * p.k, touchMods);
			gesture.lastCx = cx;
			gesture.lastCy = cy;
		};
		const onTouchEnd = (e: TouchEvent) => {
			if (e.cancelable) e.preventDefault();
			const g = gesture;
			if (!g) return;
			const remaining = e.touches.length;
			if (g.mobile) {
				flushNow();
				send({ type: "touch", action: e.type === "touchcancel" ? "cancel" : "end", points: touchPoints(e.touches), modifiers: touchMods });
			}
			if (remaining > 0) return;
			gesture = null;
			const isTap = e.type === "touchend" && g.maxTouches === 1 && !g.moved && performance.now() - g.startAt < TAP_MAX_MS;
			if (!g.mobile && isTap) {
				flushNow();
				const p = toPage(g.startX, g.startY);
				mouse("move", p.x, p.y, {});
				mouse("down", p.x, p.y, { button: "left", buttons: 1, clickCount: 1 });
				mouse("up", p.x, p.y, { button: "left", buttons: 0, clickCount: 1 });
			}
			if (isTap) focusText(); // inside the touchend gesture, so iOS raises the keyboard
		};

		// Keyboard. Typed characters go out as key events (keydown is cancelled, so no `input` follows); IME and soft
		// keyboards that cannot report real keys arrive via composition / `input`.
		let clipboardSeen = 0;
		const onKeyDown = (e: KeyboardEvent) => {
			if (isImeKey(e)) return;
			const cmd = e.metaKey || e.ctrlKey;
			const k = e.key.toLowerCase();
			if (cmd && !e.altKey) {
				if (k === "l") {
					e.preventDefault();
					onFocusAddressRef.current();
					return;
				}
				if (k === "r") {
					e.preventDefault();
					send({ type: "history", action: "reload" });
					return;
				}
				if (k === "c") {
					e.preventDefault();
					const seen = ++clipboardSeen;
					void copyAnswerToClipboard(conn.copySelection()).then((copied) => {
						if (seen === clipboardSeen && !copied) toast.message("Nothing selected on the page");
					});
					return;
				}
				if (k === "v") return; // the native `paste` event below delivers the text without a clipboard-read prompt
			}
			e.preventDefault();
			send({ type: "key", action: "down", key: e.key.slice(0, 32), code: e.code.slice(0, 32), keyCode: e.keyCode, location: e.location, modifiers: modifiers(e), repeat: e.repeat });
		};
		const onKeyUp = (e: KeyboardEvent) => {
			if (isImeKey(e)) return;
			const k = e.key.toLowerCase();
			if ((e.metaKey || e.ctrlKey) && !e.altKey && (k === "l" || k === "r" || k === "c" || k === "v")) return;
			e.preventDefault();
			send({ type: "key", action: "up", key: e.key.slice(0, 32), code: e.code.slice(0, 32), keyCode: e.keyCode, location: e.location, modifiers: modifiers(e), repeat: false });
		};
		const pressKey = (key: string, code: string, keyCode: number) => {
			send({ type: "key", action: "down", key, code, keyCode, location: 0, modifiers: 0, repeat: false });
			send({ type: "key", action: "up", key, code, keyCode, location: 0, modifiers: 0, repeat: false });
		};
		const clearText = () => {
			text.value = "";
		};
		let lastComposed = { data: "", at: 0 };
		const onCompositionStart = () => setComposing(" ");
		const onCompositionUpdate = (e: CompositionEvent) => setComposing(e.data || " ");
		const onCompositionEnd = (e: CompositionEvent) => {
			setComposing("");
			if (e.data) {
				send({ type: "text", text: e.data });
				lastComposed = { data: e.data, at: performance.now() };
			}
			setTimeout(clearText, 0);
		};
		const onInput = (e: Event) => {
			const ie = e as InputEvent;
			if (ie.isComposing || ie.inputType === "insertCompositionText") return;
			switch (ie.inputType) {
				case "insertText":
				case "insertReplacementText": {
					const data = ie.data ?? text.value;
					const echoOfComposition = data === lastComposed.data && performance.now() - lastComposed.at < 60;
					if (data && !echoOfComposition) send({ type: "text", text: data });
					break;
				}
				case "deleteContentBackward":
					pressKey("Backspace", "Backspace", 8);
					break;
				case "deleteContentForward":
					pressKey("Delete", "Delete", 46);
					break;
				case "insertLineBreak":
				case "insertParagraph":
					pressKey("Enter", "Enter", 13);
					break;
				default:
					if (ie.data) send({ type: "text", text: ie.data });
			}
			clearText();
		};
		const onPaste = (e: ClipboardEvent) => {
			e.preventDefault();
			const pasted = e.clipboardData?.getData("text/plain");
			if (pasted) send({ type: "text", text: pasted });
		};
		const onCanvasFocus = () => focusText(); // Tab / programmatic focus lands on the keyboard sink
		const onTextFocus = () => setKbdFocused(true);
		const onTextBlur = () => {
			setKbdFocused(false);
			setComposing("");
		};

		const passive = { passive: false } as const;
		canvas.addEventListener("mousedown", onMouseDown);
		canvas.addEventListener("mousemove", onMouseMove);
		canvas.addEventListener("wheel", onWheel, passive);
		canvas.addEventListener("contextmenu", onContextMenu);
		canvas.addEventListener("touchstart", onTouchStart, passive);
		canvas.addEventListener("touchmove", onTouchMove, passive);
		canvas.addEventListener("touchend", onTouchEnd, passive);
		canvas.addEventListener("touchcancel", onTouchEnd, passive);
		canvas.addEventListener("focus", onCanvasFocus);
		text.addEventListener("keydown", onKeyDown);
		text.addEventListener("keyup", onKeyUp);
		text.addEventListener("compositionstart", onCompositionStart);
		text.addEventListener("compositionupdate", onCompositionUpdate);
		text.addEventListener("compositionend", onCompositionEnd);
		text.addEventListener("input", onInput);
		text.addEventListener("paste", onPaste);
		text.addEventListener("focus", onTextFocus);
		text.addEventListener("blur", onTextBlur);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("mouseup", onMouseUp);
			canvas.removeEventListener("mousedown", onMouseDown);
			canvas.removeEventListener("mousemove", onMouseMove);
			canvas.removeEventListener("wheel", onWheel);
			canvas.removeEventListener("contextmenu", onContextMenu);
			canvas.removeEventListener("touchstart", onTouchStart);
			canvas.removeEventListener("touchmove", onTouchMove);
			canvas.removeEventListener("touchend", onTouchEnd);
			canvas.removeEventListener("touchcancel", onTouchEnd);
			canvas.removeEventListener("focus", onCanvasFocus);
			text.removeEventListener("keydown", onKeyDown);
			text.removeEventListener("keyup", onKeyUp);
			text.removeEventListener("compositionstart", onCompositionStart);
			text.removeEventListener("compositionupdate", onCompositionUpdate);
			text.removeEventListener("compositionend", onCompositionEnd);
			text.removeEventListener("input", onInput);
			text.removeEventListener("paste", onPaste);
			text.removeEventListener("focus", onTextFocus);
			text.removeEventListener("blur", onTextBlur);
		};
	}, [conn]);

	const showOverlay = state !== "open";
	return (
		<div ref={areaRef} data-focused={kbdFocused || undefined} className={cn("group/viewer relative min-h-0 min-w-0 select-none overflow-hidden bg-surface-2", className)}>
			<div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden bg-white shadow-pop group-data-[focused]/viewer:shadow-[0_0_0_2px_var(--accent)]" style={{ width: cssWidth, height: cssHeight, opacity: hasFrame ? 1 : 0 }}>
				<canvas ref={canvasRef} tabIndex={0} aria-label="Remote browser page" className="block size-full cursor-default touch-none outline-none" />
			</div>
			<textarea
				ref={textRef}
				aria-label="Keyboard input for the remote page"
				autoCapitalize="off"
				autoCorrect="off"
				autoComplete="off"
				spellCheck={false}
				tabIndex={-1}
				rows={1}
				className="pointer-events-none fixed left-0 top-0 size-px resize-none border-0 p-0 opacity-0 outline-none"
				style={{ fontSize: 16 }}
			/>
			{composing ? <div className="pointer-events-none absolute bottom-3 left-1/2 max-w-[80%] -translate-x-1/2 truncate rounded-md bg-foreground px-2 py-1 font-mono text-xs text-background shadow-pop">{composing}</div> : null}
			<Button
				variant="secondary"
				size="icon"
				aria-label={kbdFocused ? "Hide keyboard" : "Show keyboard"}
				className="absolute bottom-3 right-3 hidden rounded-full shadow-pop coarse:inline-flex"
				onMouseDown={(e) => e.preventDefault()}
				onClick={() => (document.activeElement === textRef.current ? textRef.current?.blur() : textRef.current?.focus({ preventScroll: true }))}
			>
				<Keyboard />
			</Button>
			{showOverlay ? (
				<ConnectionOverlay
					state={state}
					hasFrame={hasFrame}
					onRetry={() => {
						conn?.retry();
						onRetry();
					}}
				/>
			) : null}
		</div>
	);
}

function ConnectionOverlay({ state, hasFrame, onRetry }: { state: ConnState; hasFrame: boolean; onRetry: () => void }) {
	if (state === "connecting" || state === "reconnecting") {
		// With a frame on screen this is a small pill over the last picture; first connect gets a quiet full overlay.
		return hasFrame ? (
			<div role="status" className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full bg-overlay px-3 py-1.5 text-xs text-muted-foreground shadow-pop">
				<Loader2 className="size-3.5 animate-spin" /> {state === "reconnecting" ? "Reconnecting…" : "Connecting…"}
			</div>
		) : (
			<div role="status" className="pointer-events-none absolute inset-0 grid place-items-center">
				<div className="flex items-center gap-2 text-[13px] text-muted-foreground">
					<Loader2 className="size-4 animate-spin" /> Connecting to this machine's browser…
				</div>
			</div>
		);
	}
	const message =
		state === "tab-closed"
			? { title: "This tab was closed", body: "Pick another tab or open a new one.", retry: false }
			: state === "signed-out"
				? { title: "Session ended", body: "Your sign-in expired or the Browser was switched off for remote access.", retry: true }
				: { title: "Browser unavailable", body: "The browser on this machine is not running or could not start.", retry: true };
	return (
		<div role="alert" className="absolute inset-0 grid place-items-center bg-surface-2/85 p-6 backdrop-blur-[2px]">
			<div className="flex max-w-xs flex-col items-center gap-2 text-center">
				<TriangleAlert className="size-5 text-warning" />
				<h3 className="text-sm font-medium">{message.title}</h3>
				<p className="text-[13px] text-muted-foreground">{message.body}</p>
				{message.retry ? (
					<Button size="sm" onClick={onRetry}>
						<RefreshCw /> Retry
					</Button>
				) : null}
			</div>
		</div>
	);
}
