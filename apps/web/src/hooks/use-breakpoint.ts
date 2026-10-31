import { useSyncExternalStore } from "react";

export type Breakpoint = "mobile" | "tablet" | "desktop";

const mqMobile = typeof matchMedia === "function" ? matchMedia("(max-width: 767.98px)") : null;
const mqDesktop = typeof matchMedia === "function" ? matchMedia("(min-width: 1280px)") : null;

function subscribe(cb: () => void): () => void {
	mqMobile?.addEventListener("change", cb);
	mqDesktop?.addEventListener("change", cb);
	return () => {
		mqMobile?.removeEventListener("change", cb);
		mqDesktop?.removeEventListener("change", cb);
	};
}
const snapshot = (): Breakpoint => (mqMobile?.matches ? "mobile" : mqDesktop?.matches ? "desktop" : "tablet");

/** <768 mobile · 768–1279 tablet · ≥1280 desktop. */
export function useBreakpoint(): Breakpoint {
	return useSyncExternalStore(subscribe, snapshot, () => "desktop" as Breakpoint);
}
export const useIsMobile = (): boolean => useBreakpoint() === "mobile";
