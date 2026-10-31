import { useRef } from "react";

interface Drag {
	startY: number;
	startAt: number;
	dy: number;
	sheet: HTMLElement;
}

const DISMISS_DISTANCE = 96;
const FLICK_DISTANCE = 32;
const FLICK_VELOCITY = 0.5; // px per ms

/**
 * Invisible drag strip over the grab handle of a bottom sheet: dragging down follows the finger (transform only) and
 * releasing past a threshold, or with a flick, dismisses. Must be a child of the (positioned) sheet content.
 */
export function SwipeZone({ onDismiss }: { onDismiss: () => void }) {
	const drag = useRef<Drag | null>(null);
	const finish = () => {
		const d = drag.current;
		drag.current = null;
		if (!d) return;
		const velocity = d.dy / Math.max(1, performance.now() - d.startAt);
		if (d.dy > DISMISS_DISTANCE || (d.dy > FLICK_DISTANCE && velocity > FLICK_VELOCITY)) {
			d.sheet.style.transition = "transform 160ms ease-in";
			d.sheet.style.transform = "translateY(100%)";
			setTimeout(onDismiss, 150);
		} else {
			d.sheet.style.transition = "transform 180ms ease-out";
			d.sheet.style.transform = "";
		}
	};
	return (
		<div
			aria-hidden
			className="absolute inset-x-0 top-0 z-10 h-9 touch-none"
			onPointerDown={(e) => {
				const sheet = e.currentTarget.parentElement;
				if (!sheet) return;
				e.currentTarget.setPointerCapture(e.pointerId);
				// Inline animation:none lets the inline transform win over the open animation's fill.
				sheet.style.animation = "none";
				sheet.style.transition = "none";
				drag.current = { startY: e.clientY, startAt: performance.now(), dy: 0, sheet };
			}}
			onPointerMove={(e) => {
				const d = drag.current;
				if (!d) return;
				d.dy = Math.max(0, e.clientY - d.startY);
				d.sheet.style.transform = `translateY(${d.dy}px)`;
			}}
			onPointerUp={finish}
			onPointerCancel={finish}
		/>
	);
}
