import { useSyncExternalStore } from "react";

export type ThemePref = "dark" | "light" | "system";
const KEY = "clam.theme";
const listeners = new Set<() => void>();
const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

function readPref(): ThemePref {
	try {
		const v = localStorage.getItem(KEY);
		return v === "dark" || v === "light" || v === "system" ? v : "system";
	} catch {
		return "system";
	}
}

let pref: ThemePref = readPref();

export function resolveTheme(p: ThemePref = pref): "dark" | "light" {
	return p === "system" ? (mq?.matches ? "dark" : "light") : p;
}

function apply(): void {
	const dark = resolveTheme() === "dark";
	const root = document.documentElement;
	root.classList.toggle("dark", dark);
	root.style.colorScheme = dark ? "dark" : "light";
	document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0b0c0f" : "#f6f6f4");
}

/** Cross-fades the switch (View Transitions, opacity only) unless reduced motion is requested or unsupported. */
export function setThemePref(next: ThemePref): void {
	const commit = () => {
		pref = next;
		try {
			localStorage.setItem(KEY, next);
		} catch {}
		apply();
		for (const l of listeners) l();
	};
	const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
	const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
	if (doc.startViewTransition && !reduced && resolveTheme(next) !== resolveTheme()) doc.startViewTransition(commit);
	else commit();
}

export function toggleTheme(): void {
	setThemePref(resolveTheme() === "dark" ? "light" : "dark");
}

const ORDER: readonly ThemePref[] = ["system", "light", "dark"];
/** System → Light → Dark → System. */
export function cycleTheme(): void {
	setThemePref(ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length] ?? "system");
}

export const THEME_LABEL: Record<ThemePref, string> = { system: "System", light: "Light", dark: "Dark" };

mq?.addEventListener("change", () => {
	if (pref === "system") {
		apply();
		for (const l of listeners) l();
	}
});

const subscribe = (cb: () => void) => {
	listeners.add(cb);
	return () => listeners.delete(cb);
};

export function useThemePref(): ThemePref {
	return useSyncExternalStore(subscribe, () => pref, () => pref);
}
export function useResolvedTheme(): "dark" | "light" {
	return useSyncExternalStore(subscribe, () => resolveTheme(), () => "dark");
}
