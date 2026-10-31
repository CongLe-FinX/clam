import { useEffect, useRef, useState } from "react";

/** True while the element is within `margin` px of the viewport. With `once`, stays true after the first sighting. */
export function useInView<T extends Element>(margin = 300, once = false) {
	const ref = useRef<T>(null);
	const [inView, setInView] = useState(false);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		if (typeof IntersectionObserver === "undefined") {
			setInView(true);
			return;
		}
		const io = new IntersectionObserver(
			(entries) => {
				const hit = entries.some((e) => e.isIntersecting);
				if (hit && once) {
					setInView(true);
					io.disconnect();
				} else if (!once) setInView(hit);
			},
			{ rootMargin: `${margin}px 0px` },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [margin, once]);
	return [ref, inView] as const;
}
