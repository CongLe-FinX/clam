import { cloneElement, isValidElement, Suspense, useEffect, useRef, useState } from "react";
import { lazyPreload } from "@/lib/lazy-preload";
import type { FocusEvent, PointerEvent, ReactElement, ReactNode } from "react";

// The tooltip engine (Radix Tooltip + Popper + floating-ui, ~25 KB gzip) is a lazy chunk: a tip's trigger is plain DOM until the
// pointer or keyboard focus first reaches it, so none of that code is on the boot path.
const { Component: TipOverlay, preload: preloadOverlay } = lazyPreload(() => import("./tip-overlay.tsx"));
/** Warm the tooltip chunk (call when idle) so the first tooltip appears without a network round trip. */
export const preloadTooltips = (): void => void preloadOverlay();

const coarse = typeof matchMedia === "function" ? matchMedia("(pointer: coarse)") : null;
const DELAY_MS = 350;
const SKIP_DELAY_MS = 200;
/** When a tip closed last: moving between adjacent triggers shows the next one at once (Radix `skipDelayDuration`). */
let lastClosedAt = 0;

interface TriggerProps {
	onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
	onPointerLeave?: (e: PointerEvent<HTMLElement>) => void;
	onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
	onFocus?: (e: FocusEvent<HTMLElement>) => void;
	onBlur?: (e: FocusEvent<HTMLElement>) => void;
}

/** Convenience: `<Tip label="Copy"><Button/></Tip>`. Tooltips are skipped on touch devices (they would stick after focus). */
export function Tip({ label, children, side, shortcut }: { label: ReactNode; children: ReactNode; side?: "top" | "right" | "bottom" | "left"; shortcut?: string }) {
	const [anchor, setAnchor] = useState<HTMLElement | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	if (coarse?.matches || !isValidElement(children)) return <>{children}</>;

	const child = children as ReactElement<TriggerProps>;
	const own = child.props;
	const close = () => {
		clearTimeout(timer.current);
		setAnchor((a) => {
			if (a) lastClosedAt = Date.now();
			return null;
		});
	};
	const arm = (el: HTMLElement, instant: boolean) => {
		void preloadOverlay();
		clearTimeout(timer.current);
		const wait = instant || Date.now() - lastClosedAt < SKIP_DELAY_MS ? 0 : DELAY_MS;
		timer.current = setTimeout(() => setAnchor(el), wait);
	};

	return (
		<>
			{cloneElement(child, {
				onPointerEnter: (e) => {
					own.onPointerEnter?.(e);
					if (e.pointerType !== "touch") arm(e.currentTarget, false);
				},
				onPointerLeave: (e) => {
					own.onPointerLeave?.(e);
					close();
				},
				onPointerDown: (e) => {
					own.onPointerDown?.(e);
					close();
				},
				onFocus: (e) => {
					own.onFocus?.(e);
					if (e.currentTarget.matches(":focus-visible")) arm(e.currentTarget, true);
				},
				onBlur: (e) => {
					own.onBlur?.(e);
					close();
				},
			})}
			{anchor ? (
				<Suspense fallback={null}>
					<TipOverlay anchor={anchor} label={label} side={side} shortcut={shortcut} onClose={close} />
				</Suspense>
			) : null}
		</>
	);
}
