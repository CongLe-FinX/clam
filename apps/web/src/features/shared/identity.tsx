import type { SharedMessage } from "@clam/contracts";
import { Bot } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * Who said it, as a colour. Every author (node + agent, or a person on a machine) gets one of eight hues, stable across sessions and nodes
 * because it only depends on ids. The hue feeds OKLCH lightness steps picked for contrast in both themes: white-on-500 avatars and
 * 0.44/0.80 lightness names (≥ 4.5:1 on the surfaces), a faint tint for bubbles.
 */
const HUES = [20, 55, 95, 150, 190, 235, 275, 330] as const;

/** Stable 32-bit FNV-1a. */
function hash(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

const hueCache = new Map<string, number>();
export function hueOf(nodeId: string, agentId: string | null): number {
	const key = `${nodeId}\u0000${agentId ?? ""}`;
	let h = hueCache.get(key);
	if (h === undefined) {
		h = HUES[hash(key) % HUES.length] as number;
		hueCache.set(key, h);
	}
	return h;
}

/** Same author = same person or same agent on the same node. */
export const authorKey = (a: SharedMessage["author"]): string => `${a.kind}:${a.nodeId}:${a.agentId ?? ""}`;

export const hueStyle = (hue: number): CSSProperties => ({ "--hue": hue }) as CSSProperties;

/** 3px accent bar on the left edge of an agent's bubble: the only place the hue touches the bubble. */
export const TINT_BAR = "before:absolute before:inset-y-2.5 before:left-0 before:w-[3px] before:rounded-full before:bg-[oklch(0.6_0.15_var(--hue))] dark:before:bg-[oklch(0.74_0.12_var(--hue))]";
export const TINT_NAME = "text-[oklch(0.44_0.14_var(--hue))] dark:text-[oklch(0.8_0.11_var(--hue))]";
const TINT_AVATAR = "bg-[oklch(0.5_0.14_var(--hue))] text-white dark:bg-[oklch(0.76_0.11_var(--hue))] dark:text-[oklch(0.2_0.03_var(--hue))]";

export function initialsOf(name: string): string {
	const words = name.split(/[\s\-_@.]+/).filter(Boolean);
	const letters = words.length > 1 ? [words[0]?.[0], words[1]?.[0]] : [words[0]?.[0], words[0]?.[1]];
	return letters.filter(Boolean).join("").toUpperCase() || "?";
}

/** Agents are circles with a bot mark, people rounded squares: the two never look alike even in one colour. */
export function AuthorAvatar({ name, hue, agent, badge = true, className }: { name: string; hue: number; agent: boolean; badge?: boolean; className?: string }) {
	return (
		<span aria-hidden style={hueStyle(hue)} className={cn("relative grid size-8 shrink-0 select-none place-items-center text-[11px] font-semibold", agent ? "rounded-full" : "rounded-lg", TINT_AVATAR, className)}>
			{initialsOf(name)}
			{agent && badge ? (
				<span className="absolute -bottom-0.5 -right-0.5 grid size-3.5 place-items-center rounded-full bg-surface-1 text-foreground shadow-[0_0_0_1px_var(--border-strong)]">
					<Bot className="size-2.5" />
				</span>
			) : null}
		</span>
	);
}

/** The machine an author or participant runs on, as a muted chip (never a raw `@HOST` string). */
export function MachineChip({ name, className }: { name: string; className?: string }) {
	return <span className={cn("inline-block max-w-[40vw] truncate rounded bg-surface-2 px-1.5 py-px align-middle text-2xs leading-4 text-muted-foreground", className)}>{name}</span>;
}
