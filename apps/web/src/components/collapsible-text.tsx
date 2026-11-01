import { ChevronDown } from "lucide-react";
import { type ReactNode, useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/** Messages the user expanded, kept for the life of the page: a virtualized list recycles rows, a recycled row must come back as the user left it. */
const EXPANDED = new Set<string>();

/** Where the text is cut: about 12 lines (18rem) on a desktop bubble, 14rem on a phone. Must match `CLAMP` below. */
const limitPx = (): number => {
	const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
	return (matchMedia("(min-width: 640px)").matches ? 18 : 14) * rem;
};
/** Content only counts as long when more than one line would be hidden: a bubble a line over the limit is shown whole. */
const SLACK_PX = 28;
const CLAMP = "max-h-56 sm:max-h-72";

/** Fired on the scroll container just before a message grows or shrinks by the user's hand: a chat that follows its tail must stop following, or the click would scroll the page. */
export const RELEASE_TAIL = "clam:release-tail";

function scrollParent(el: HTMLElement): HTMLElement | null {
	for (let p = el.parentElement; p; p = p.parentElement) {
		const overflow = getComputedStyle(p).overflowY;
		if ((overflow === "auto" || overflow === "scroll") && p.scrollHeight > p.clientHeight) return p;
	}
	return null;
}

/**
 * A sent message's text, cut to about 12 lines with a fade and a Show more button when it renders taller than that (measured, not
 * counted). Expanding grows the clip with a Web Animations `max-height` tween (will-change only while it runs; none under reduced
 * motion); collapsing a message whose top is scrolled out of view keeps the button where it was instead of jumping the page.
 * The row's own ResizeObserver (the virtualizer's `measureElement`) picks the height change up.
 */
export function CollapsibleText({ expandedKey, children, className }: { expandedKey: string; children: ReactNode; className?: string }) {
	const regionId = useId();
	const clip = useRef<HTMLDivElement>(null);
	const inner = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const [long, setLong] = useState(false);
	const [expanded, setExpanded] = useState(() => EXPANDED.has(expandedKey));
	const collapsed = long && !expanded;

	const measure = useCallback(() => {
		const el = inner.current;
		if (!el) return;
		const next = el.offsetHeight > limitPx() + SLACK_PX;
		setLong((prev) => (prev === next ? prev : next));
	}, []);
	// Before the first paint, so a long message never shows whole for a frame and then snaps shut.
	useLayoutEffect(() => {
		measure();
		const el = inner.current;
		if (!el) return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [measure]);

	const toggle = () => {
		const el = clip.current;
		const btn = button.current;
		if (!el || !btn) return;
		const scroller = scrollParent(el);
		const from = el.getBoundingClientRect().height;
		// Collapsing a message whose top is above the viewport: hold the button still.
		const holdButton = expanded && scroller !== null && el.getBoundingClientRect().top < scroller.getBoundingClientRect().top ? btn.getBoundingClientRect().top : null;
		scroller?.dispatchEvent(new Event(RELEASE_TAIL));
		const next = !expanded;
		if (next) EXPANDED.add(expandedKey);
		else EXPANDED.delete(expandedKey);
		flushSync(() => setExpanded(next));
		if (holdButton !== null && scroller && button.current) {
			scroller.scrollTop += button.current.getBoundingClientRect().top - holdButton;
			return;
		}
		const to = el.getBoundingClientRect().height;
		if (Math.abs(to - from) < 2 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		el.style.willChange = "max-height";
		const animation = el.animate([{ maxHeight: `${from}px` }, { maxHeight: `${to}px` }], { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
		const done = () => {
			el.style.willChange = "";
		};
		animation.onfinish = done;
		animation.oncancel = done;
	};

	return (
		<div className={className}>
			<div ref={clip} id={regionId} data-collapsed={long ? collapsed : undefined} className={cn("min-w-0", long && "clam-clip overflow-hidden", collapsed && CLAMP)}>
				<div ref={inner}>{children}</div>
			</div>
			{long ? (
				<button
					ref={button}
					type="button"
					aria-expanded={expanded}
					aria-controls={regionId}
					onClick={toggle}
					className="mt-1.5 inline-flex h-6 items-center gap-1 rounded-md pr-1.5 text-xs font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring coarse:h-11"
				>
					<ChevronDown aria-hidden className={cn("size-3.5 transition-transform duration-200", expanded && "rotate-180")} />
					{expanded ? t("Show less") : t("Show more")}
				</button>
			) : null}
		</div>
	);
}
