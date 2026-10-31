import type { TerminalSession } from "@clam/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronUp, ClipboardPaste, Search, X } from "lucide-react";
import { type RefObject, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { type ConnectionState, TerminalConnection } from "./connection";
import { LINE_HEIGHT } from "./grid";
import { FONT_FAMILY, clampFont, terminalTheme } from "./theme";

export interface TerminalControls {
	focus(): void;
	copySelection(): Promise<boolean>;
	paste(): Promise<void>;
	clear(): void;
	toggleSearch(): void;
}

interface Props {
	session: TerminalSession;
	/** Do not connect yet (a remote session that must re-enter its password first). */
	blocked: boolean;
	fontSize: number;
	onFontSize: (size: number) => void;
	themeMode: "dark" | "light";
	/** Show the touch accessory keys (Esc, Tab, Ctrl, Alt, arrows, …). */
	touchKeys: boolean;
	controlsRef: RefObject<TerminalControls | null>;
	connectionRef: RefObject<TerminalConnection | null>;
	onState: (state: ConnectionState) => void;
	onSession: (session: TerminalSession) => void;
	onRefused: () => void;
}

const ARROWS = { up: ["\x1b[A", "\x1bOA"], down: ["\x1b[B", "\x1bOB"], right: ["\x1b[C", "\x1bOC"], left: ["\x1b[D", "\x1bOD"] } as const;

/** Ctrl+<char>: the control code of letters and `@ [ \ ] ^ _`; anything else passes through. */
function applyCtrl(char: string): string {
	const code = char.toUpperCase().charCodeAt(0);
	return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code & 0x1f) : char;
}

function KeyButton({ label, onPress, active, wide, children }: { label: string; onPress: () => void; active?: boolean; wide?: boolean; children?: React.ReactNode }) {
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={active}
			// Keeping focus in the terminal's input keeps the on-screen keyboard open while keys are tapped.
			onPointerDown={(e) => e.preventDefault()}
			onClick={onPress}
			className={cn(
				"grid h-11 shrink-0 place-items-center rounded-lg font-mono text-[13px] font-medium outline-none transition-[background-color,color,transform] duration-100 active:scale-95",
				wide ? "min-w-14 px-3" : "min-w-11 px-2",
				active ? "bg-accent text-accent-foreground" : "bg-surface-3 text-foreground active:bg-border-strong",
			)}
		>
			{children ?? label}
		</button>
	);
}

export default function TerminalView({ session, blocked, fontSize, onFontSize, themeMode, touchKeys, controlsRef, connectionRef, onState, onSession, onRefused }: Props) {
	const host = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const searchRef = useRef<SearchAddon | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const modifiers = useRef({ ctrl: false, alt: false });
	const [mods, setMods] = useState({ ctrl: false, alt: false });
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [noMatch, setNoMatch] = useState(false);
	const searchInput = useRef<HTMLInputElement>(null);
	// Latest props for long-lived callbacks (the terminal and the socket outlive renders).
	const latest = useRef({ onState, onSession, onRefused, onFontSize, fontSize });
	latest.current = { onState, onSession, onRefused, onFontSize, fontSize };
	const started = useRef(false);
	const [ready, setReady] = useState(false);

	const setModifier = useCallback((which: "ctrl" | "alt", on: boolean) => {
		modifiers.current = { ...modifiers.current, [which]: on };
		setMods(modifiers.current);
	}, []);

	// The terminal itself: created once per session (the parent keys this component by session id).
	useEffect(() => {
		const el = host.current;
		if (!el) return;
		let disposed = false;
		const disposers: Array<() => void> = [];
		void (async () => {
			try {
				await document.fonts.load(`${latest.current.fontSize}px "JetBrains Mono Variable"`);
			} catch {
				// the fallback monospace font is fine
			}
			if (disposed) return;
			const term = new Terminal({
				fontFamily: FONT_FAMILY,
				fontSize: latest.current.fontSize,
				lineHeight: LINE_HEIGHT,
				cursorBlink: true,
				cursorStyle: "bar",
				cursorWidth: 2,
				scrollback: 5000,
				allowProposedApi: true,
				macOptionIsMeta: true,
				macOptionClickForcesSelection: true,
				theme: terminalTheme(themeMode),
				drawBoldTextInBrightColors: false,
				smoothScrollDuration: 0,
			});
			termRef.current = term;
			const fit = new FitAddon();
			const search = new SearchAddon();
			fitRef.current = fit;
			searchRef.current = search;
			term.loadAddon(fit);
			term.loadAddon(search);
			term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, "_blank", "noopener,noreferrer")));
			term.loadAddon(new Unicode11Addon());
			term.unicode.activeVersion = "11";
			term.open(el);
			// GPU renderer when the browser has WebGL, canvas when it does not; the DOM renderer remains the last resort.
			// Both are loaded on demand so the first paint does not wait for them.
			const loadCanvas = async () => {
				try {
					const { CanvasAddon } = await import("@xterm/addon-canvas");
					if (disposed) return;
					term.loadAddon(new CanvasAddon());
					fit.fit(); // cell metrics change with the renderer
				} catch {
					// DOM renderer
				}
			};
			void (async () => {
				try {
					const { WebglAddon } = await import("@xterm/addon-webgl");
					if (disposed) return;
					const webgl = new WebglAddon();
					webgl.onContextLoss(() => {
						webgl.dispose();
						void loadCanvas();
					});
					term.loadAddon(webgl);
					fit.fit(); // cell metrics change with the renderer
				} catch {
					await loadCanvas();
				}
			})();
			fit.fit();

			// The GPU renderer keeps its canvas at the device pixel ratio it was created under: after the ratio changes (browser zoom, a window dragged to
			// another display, device emulation) the canvas stays at the old size, so the text is drawn small and offset from the top of the screen. Touching
			// a font option makes the renderer measure again and resize it.
			let reconciledAt = 0; // one repair per ratio: a canvas that stays off must not make this loop
			const reconcileRenderer = () => {
				if (disposed) return;
				const screen = el.querySelector<HTMLElement>(".xterm-screen");
				const canvas = el.querySelector<HTMLCanvasElement>(".xterm-screen canvas:not(.xterm-link-layer)");
				if (!screen || !canvas || screen.clientWidth === 0) return;
				const dpr = window.devicePixelRatio;
				if (Math.abs(canvas.width / screen.clientWidth - dpr) / dpr <= 0.1) {
					reconciledAt = 0;
					return;
				}
				if (reconciledAt === dpr) return;
				reconciledAt = dpr;
				const size = term.options.fontSize ?? latest.current.fontSize;
				term.options.fontSize = size + 1;
				term.options.fontSize = size;
				fit.fit();
			};
			const reconcileTimer = window.setInterval(reconcileRenderer, 1000);
			window.addEventListener("resize", reconcileRenderer);
			disposers.push(() => {
				window.clearInterval(reconcileTimer);
				window.removeEventListener("resize", reconcileRenderer);
			});

			term.attachCustomKeyEventHandler((e) => {
				if (e.type !== "keydown") return true;
				const mod = navigator.platform.toLowerCase().includes("mac") ? e.metaKey : e.ctrlKey && e.shiftKey;
				if (mod && e.key.toLowerCase() === "f") {
					e.preventDefault();
					setSearchOpen(true);
					return false;
				}
				// Ctrl+Shift+C copies on non-Mac keyboards (plain Ctrl+C stays the interrupt).
				if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c" && term.hasSelection()) {
					void navigator.clipboard?.writeText(term.getSelection());
					return false;
				}
				return true;
			});

			const conn = new TerminalConnection(session.id, {
				onAttached: () => {
					term.reset();
				},
				onBytes: (bytes) => term.write(bytes),
				onLive: () => {
					fit.fit();
					conn.resize(term.cols, term.rows);
				},
				onExit: () => undefined,
				onSession: (s) => latest.current.onSession(s),
				onState: (s) => latest.current.onState(s),
				onRefused: () => latest.current.onRefused(),
			});
			connectionRef.current = conn;
			disposers.push(() => {
				conn.dispose();
				connectionRef.current = null;
			});

			disposers.push(
				term.onData((data) => {
					let out = data;
					const m = modifiers.current;
					if (m.ctrl && out.length === 1) out = applyCtrl(out);
					if (m.alt) out = `\x1b${out}`;
					if (m.ctrl || m.alt) {
						modifiers.current = { ctrl: false, alt: false };
						setMods(modifiers.current);
					}
					conn.sendText(out);
				}).dispose,
				term.onBinary((data) => conn.sendBytes(Uint8Array.from(data, (c) => c.charCodeAt(0)))).dispose,
				term.onResize(({ cols, rows }) => conn.resize(cols, rows)).dispose,
			);

			// Fit on any size change, once per frame.
			let frame = 0;
			const observer = new ResizeObserver(() => {
				cancelAnimationFrame(frame);
				frame = requestAnimationFrame(() => {
					if (el.clientWidth > 0 && el.clientHeight > 0) {
						fit.fit();
						reconcileRenderer();
					}
				});
			});
			observer.observe(el);
			disposers.push(() => {
				cancelAnimationFrame(frame);
				observer.disconnect();
			});

			// Two-finger pinch changes the font size (and never zooms the page).
			let pinch: { distance: number; size: number } | null = null;
			const distance = (e: TouchEvent): number => Math.hypot((e.touches[0]?.clientX ?? 0) - (e.touches[1]?.clientX ?? 0), (e.touches[0]?.clientY ?? 0) - (e.touches[1]?.clientY ?? 0));
			const onTouchStart = (e: TouchEvent) => {
				if (e.touches.length === 2) pinch = { distance: distance(e), size: latest.current.fontSize };
			};
			const onTouchMove = (e: TouchEvent) => {
				if (!pinch || e.touches.length !== 2) return;
				e.preventDefault();
				const next = clampFont(pinch.size * (distance(e) / pinch.distance));
				if (next !== latest.current.fontSize) latest.current.onFontSize(next);
			};
			const onTouchEnd = (e: TouchEvent) => {
				if (e.touches.length < 2) pinch = null;
			};
			el.addEventListener("touchstart", onTouchStart, { passive: true });
			el.addEventListener("touchmove", onTouchMove, { passive: false });
			el.addEventListener("touchend", onTouchEnd, { passive: true });
			disposers.push(() => {
				el.removeEventListener("touchstart", onTouchStart);
				el.removeEventListener("touchmove", onTouchMove);
				el.removeEventListener("touchend", onTouchEnd);
			});
			term.focus();
			started.current = false;
			setReady(true);
		})();
		return () => {
			disposed = true;
			for (const dispose of disposers) dispose();
			termRef.current?.dispose();
			termRef.current = null;
			searchRef.current = null;
			fitRef.current = null;
			setReady(false);
		};
		// The terminal is rebuilt only for another session; theme and font changes are applied by their own effects.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session.id]);

	// Connect once the terminal exists and nothing blocks it (retry when the block lifts).
	useEffect(() => {
		if (!ready || blocked) return;
		const conn = connectionRef.current;
		if (!conn) return;
		if (started.current) conn.retryNow();
		else {
			started.current = true;
			conn.start();
		}
	}, [ready, blocked, connectionRef]);

	useEffect(() => {
		const term = termRef.current;
		if (!term) return;
		term.options.fontSize = fontSize;
		fitRef.current?.fit();
	}, [fontSize, ready]);

	useEffect(() => {
		const term = termRef.current;
		if (term) term.options.theme = terminalTheme(themeMode);
	}, [themeMode, ready]);

	useEffect(() => {
		if (searchOpen) searchInput.current?.focus();
	}, [searchOpen]);

	const findNext = useCallback((forward: boolean, text = query) => {
		if (!text) return;
		const opts = { incremental: false, decorations: { matchBackground: "#6a59f555", activeMatchBackground: "#8b7cffaa", matchOverviewRuler: "#8b7cff", activeMatchColorOverviewRuler: "#8b7cff" } };
		const found = forward ? searchRef.current?.findNext(text, opts) : searchRef.current?.findPrevious(text, opts);
		setNoMatch(found === false);
	}, [query]);

	useImperativeHandle(
		controlsRef,
		() => ({
			focus: () => termRef.current?.focus(),
			copySelection: async () => {
				const text = termRef.current?.getSelection() ?? "";
				if (!text) return false;
				await navigator.clipboard.writeText(text);
				return true;
			},
			paste: async () => {
				try {
					const text = await navigator.clipboard.readText();
					if (text) termRef.current?.paste(text);
				} catch {
					toast.error("The browser blocked clipboard access. Paste with your keyboard shortcut instead.");
				}
				termRef.current?.focus();
			},
			clear: () => termRef.current?.clear(),
			toggleSearch: () => setSearchOpen((open) => !open),
		}),
		[],
	);

	const arrow = (dir: keyof typeof ARROWS) => () => {
		const app = termRef.current?.modes.applicationCursorKeysMode ?? false;
		connectionRef.current?.sendText(ARROWS[dir][app ? 1 : 0]);
		termRef.current?.focus();
	};
	const send = (text: string) => () => {
		connectionRef.current?.sendText(modifiers.current.ctrl ? applyCtrl(text) : text);
		if (modifiers.current.ctrl) setModifier("ctrl", false);
		termRef.current?.focus();
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-surface-1">
			<div className="relative min-h-0 flex-1">
				{/* touch-action: pan-y keeps vertical scrollback swipes and drops the browser's own pinch zoom. */}
				<div ref={host} className="clam-xterm absolute inset-0 touch-pan-y overflow-hidden" data-testid="terminal-host" />
				{searchOpen ? (
					<div className="absolute right-3 top-3 z-10 flex animate-pop-in items-center gap-1 rounded-xl bg-overlay p-1.5 shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)]">
						<Search className="ml-1.5 size-3.5 shrink-0 text-subtle" aria-hidden />
						<input
							ref={searchInput}
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								setNoMatch(false);
								findNext(true, e.target.value);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") findNext(!e.shiftKey);
								if (e.key === "Escape") {
									setSearchOpen(false);
									termRef.current?.focus();
								}
							}}
							placeholder="Find in output"
							aria-label="Find in terminal output"
							aria-invalid={noMatch || undefined}
							className={cn("h-8 w-40 bg-transparent px-1 text-base outline-none placeholder:text-subtle sm:w-52 sm:text-[13px] coarse:h-11", noMatch && "text-danger")}
						/>
						<Button variant="ghost" size="icon-sm" aria-label="Previous match" onClick={() => findNext(false)}>
							<ChevronUp />
						</Button>
						<Button variant="ghost" size="icon-sm" aria-label="Next match" onClick={() => findNext(true)}>
							<ChevronDown />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Close search"
							onClick={() => {
								setSearchOpen(false);
								searchRef.current?.clearDecorations();
								termRef.current?.focus();
							}}
						>
							<X />
						</Button>
					</div>
				) : null}
			</div>
			{touchKeys ? (
				<div className="scrollbar-none flex shrink-0 items-center gap-1.5 overflow-x-auto border-t bg-surface-2 px-2 py-1.5" role="toolbar" aria-label="Terminal keys">
					<KeyButton label="Esc" onPress={send("\x1b")} />
					<KeyButton label="Tab" onPress={send("\t")} />
					<KeyButton label="Ctrl" active={mods.ctrl} onPress={() => setModifier("ctrl", !modifiers.current.ctrl)} />
					<KeyButton label="Alt" active={mods.alt} onPress={() => setModifier("alt", !modifiers.current.alt)} />
					<span aria-hidden className="mx-0.5 h-6 w-px shrink-0 bg-border-strong" />
					<KeyButton label="Left arrow" onPress={arrow("left")}>
						<ArrowLeft className="size-4" />
					</KeyButton>
					<KeyButton label="Down arrow" onPress={arrow("down")}>
						<ArrowDown className="size-4" />
					</KeyButton>
					<KeyButton label="Up arrow" onPress={arrow("up")}>
						<ArrowUp className="size-4" />
					</KeyButton>
					<KeyButton label="Right arrow" onPress={arrow("right")}>
						<ArrowRight className="size-4" />
					</KeyButton>
					<span aria-hidden className="mx-0.5 h-6 w-px shrink-0 bg-border-strong" />
					<KeyButton label="|" onPress={send("|")} />
					<KeyButton label="~" onPress={send("~")} />
					<KeyButton label="/" onPress={send("/")} />
					<KeyButton label="-" onPress={send("-")} />
					<KeyButton label="Paste" onPress={() => void controlsRef.current?.paste()}>
						<ClipboardPaste className="size-4" />
					</KeyButton>
				</div>
			) : null}
		</div>
	);
}
