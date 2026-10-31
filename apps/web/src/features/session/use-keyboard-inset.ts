import { useEffect, useState } from "react";

/**
 * Height (px) of the on-screen keyboard overlapping the layout viewport, via `visualViewport`.
 * 0 when the keyboard is closed or when the browser resizes the layout viewport itself.
 */
export function useKeyboardInset(enabled: boolean): number {
	const [inset, setInset] = useState(0);
	useEffect(() => {
		const vv = window.visualViewport;
		if (!enabled || !vv) {
			setInset(0);
			return;
		}
		let raf = 0;
		const measure = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				const covered = Math.round(window.innerHeight - vv.height - vv.offsetTop);
				// Small deltas are browser chrome (URL bar), not a keyboard.
				setInset(covered > 80 ? covered : 0);
			});
		};
		vv.addEventListener("resize", measure);
		vv.addEventListener("scroll", measure);
		measure();
		return () => {
			cancelAnimationFrame(raf);
			vv.removeEventListener("resize", measure);
			vv.removeEventListener("scroll", measure);
		};
	}, [enabled]);
	return inset;
}
