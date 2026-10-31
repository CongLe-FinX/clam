import { TERMINAL_LIMITS } from "@clam/contracts";
import { FONT_FAMILY } from "./theme";

/** The `lineHeight` the terminal view is created with. */
export const LINE_HEIGHT = 1.05;
/** The row of touch keys under the screen (padding, 36 px buttons, border) and the terminal's padding around it (`terminal.css`). */
const KEY_BAR_PX = 56;
const THIN_SCROLLBAR_PX = 8;

/**
 * The columns × rows a terminal opened in `pane` is going to have, estimated before it exists (nothing to fit yet), so the shell is
 * spawned at about the right size instead of 80×24 and then resized under its first prompt. The mounted terminal fits itself
 * exactly afterwards; this only has to be close. Null while the pane has no size (hidden).
 */
export function estimateGrid(pane: HTMLElement, fontSize: number, touchKeys: boolean): { cols: number; rows: number } | null {
	const width = pane.clientWidth;
	const height = pane.clientHeight - (touchKeys ? KEY_BAR_PX : 0);
	if (width < 40 || height < 40) return null;
	const probe = document.createElement("span");
	probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${fontSize}px ${FONT_FAMILY};line-height:normal`;
	probe.textContent = "W".repeat(40);
	document.body.append(probe);
	const box = probe.getBoundingClientRect();
	probe.remove();
	if (box.width === 0 || box.height === 0) return null;
	const wide = window.matchMedia("(min-width: 640px)").matches;
	const padX = wide ? 16 : 12;
	const padY = wide ? 12 : 8;
	const cols = Math.floor((width - 2 * padX - THIN_SCROLLBAR_PX) / (box.width / 40));
	const rows = Math.floor((height - 2 * padY) / (box.height * LINE_HEIGHT));
	const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
	return { cols: clamp(cols, TERMINAL_LIMITS.minCols, TERMINAL_LIMITS.maxCols), rows: clamp(rows, TERMINAL_LIMITS.minRows, TERMINAL_LIMITS.maxRows) };
}
