import type { ITheme } from "@xterm/xterm";

/** The app's own tokens (index.css) for the surface; the ANSI palette is tuned per theme for contrast. */
const css = (name: string, fallback: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const DARK: Omit<ITheme, "background" | "foreground" | "cursor" | "cursorAccent" | "selectionBackground"> = {
	black: "#2a2f38",
	red: "#f2616d",
	green: "#3ecf8e",
	yellow: "#f5c451",
	blue: "#6cb0ff",
	magenta: "#c49bff",
	cyan: "#4fd6d0",
	white: "#c9ced8",
	brightBlack: "#5d6470",
	brightRed: "#ff8a93",
	brightGreen: "#6ee7b0",
	brightYellow: "#ffd97a",
	brightBlue: "#97c8ff",
	brightMagenta: "#dcbfff",
	brightCyan: "#7fe8e3",
	brightWhite: "#f2f4f8",
};

const LIGHT: typeof DARK = {
	black: "#2b2f38",
	red: "#c4283a",
	green: "#0d7a54",
	yellow: "#8f6200",
	blue: "#1d62c4",
	magenta: "#7d45d0",
	cyan: "#0c7f87",
	white: "#7b818d",
	brightBlack: "#5d6470",
	brightRed: "#df4458",
	brightGreen: "#14966a",
	brightYellow: "#b07a00",
	brightBlue: "#2f7de1",
	brightMagenta: "#9a63ea",
	brightCyan: "#1596a0",
	brightWhite: "#15171c",
};

export function terminalTheme(mode: "dark" | "light"): ITheme {
	const dark = mode === "dark";
	return {
		...(dark ? DARK : LIGHT),
		background: css("--surface-1", dark ? "#101216" : "#fcfcfb"),
		foreground: css("--foreground", dark ? "#e8eaee" : "#15171c"),
		cursor: css("--accent", dark ? "#8b7cff" : "#6a59f5"),
		cursorAccent: css("--surface-1", dark ? "#101216" : "#fcfcfb"),
		selectionBackground: dark ? "rgba(139, 124, 255, 0.34)" : "rgba(106, 89, 245, 0.24)",
		selectionInactiveBackground: dark ? "rgba(139, 124, 255, 0.18)" : "rgba(106, 89, 245, 0.14)",
	};
}

const FONT_KEY = "clam.terminal.fontSize";
export const FONT_MIN = 9;
export const FONT_MAX = 24;

const coarse = typeof matchMedia === "function" ? matchMedia("(pointer: coarse)") : null;

export function readFontSize(): number {
	try {
		const stored = Number(localStorage.getItem(FONT_KEY));
		if (Number.isFinite(stored) && stored >= FONT_MIN && stored <= FONT_MAX) return Math.round(stored);
	} catch {
		// private mode: fall through
	}
	return coarse?.matches ? 12 : 13;
}

export function saveFontSize(size: number): void {
	try {
		localStorage.setItem(FONT_KEY, String(size));
	} catch {
		// not persisted; the session still uses it
	}
}

export const clampFont = (size: number): number => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(size)));
export const FONT_FAMILY = '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
