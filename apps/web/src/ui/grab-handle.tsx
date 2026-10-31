import { useRef } from "react";
import { cn } from "@/lib/utils";

const CLOSE_DISTANCE = 90;

/**
 * Grab handle of a bottom sheet: drag it down to dismiss (a short drag springs back). It moves the enclosing dialog with the
 * `translate` property, so it never fights the sheet's own enter/exit animation, which animates `transform`.
 */
export function GrabHandle({ onClose, className }: { onClose: () => void; className?: string }) {
	const drag = useRef<{ y: number; el: HTMLElement; dy: number } | null>(null);
	return (
		<div
			aria-hidden
			className={cn("-mt-2 flex h-7 shrink-0 cursor-grab touch-none items-center justify-center", className)}
			onPointerDown={(e) => {
				const el = e.currentTarget.closest<HTMLElement>('[role="dialog"]');
				if (!el) return;
				e.currentTarget.setPointerCapture(e.pointerId);
				el.style.transition = "none";
				drag.current = { y: e.clientY, el, dy: 0 };
			}}
			onPointerMove={(e) => {
				const d = drag.current;
				if (!d) return;
				d.dy = Math.max(0, e.clientY - d.y);
				d.el.style.translate = `0 ${d.dy}px`;
			}}
			onPointerUp={() => {
				const d = drag.current;
				drag.current = null;
				if (!d) return;
				if (d.dy > CLOSE_DISTANCE) {
					onClose();
					return;
				}
				d.el.style.transition = "translate 180ms var(--ease-out-quint)";
				d.el.style.translate = "0 0";
			}}
			onPointerCancel={() => {
				const d = drag.current;
				drag.current = null;
				if (d) d.el.style.translate = "0 0";
			}}
		>
			<span className="h-1 w-9 rounded-full bg-border-strong" />
		</div>
	);
}
