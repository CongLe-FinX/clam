import { useEffect, useState } from "react";

export interface ViewportBox {
	top: number;
	height: number;
	/** The on-screen keyboard covers part of the layout viewport. */
	keyboardOpen: boolean;
}

/**
 * The part of the screen that is actually visible: on iOS the keyboard shrinks the *visual* viewport but not the layout one,
 * so a full-screen tool must size itself from here to keep its bottom row (the key bar) right above the keyboard.
 * `null` when the browser has no Visual Viewport API (the layout viewport is then the right box already).
 */
export function useVisualViewport(enabled: boolean): ViewportBox | null {
	const [box, setBox] = useState<ViewportBox | null>(null);
	useEffect(() => {
		const vv = window.visualViewport;
		if (!enabled || !vv) {
			setBox(null);
			return;
		}
		let frame = 0;
		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				setBox((prev) => {
					const next = { top: Math.round(vv.offsetTop), height: Math.round(vv.height), keyboardOpen: window.innerHeight - vv.height > 120 };
					return prev && prev.top === next.top && prev.height === next.height && prev.keyboardOpen === next.keyboardOpen ? prev : next;
				});
			});
		};
		update();
		vv.addEventListener("resize", update);
		vv.addEventListener("scroll", update);
		return () => {
			cancelAnimationFrame(frame);
			vv.removeEventListener("resize", update);
			vv.removeEventListener("scroll", update);
		};
	}, [enabled]);
	return box;
}
