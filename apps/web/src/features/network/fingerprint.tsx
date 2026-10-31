import { Check, Copy } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { useCopy } from "./components";
import { formatFingerprint } from "./format";

/** Short, easy-to-say words; four of them (24 bits) are a spoken checksum of a fingerprint. */
/** Well-separated hues so two machines rarely look alike. */
const HUES = [8, 28, 48, 96, 150, 176, 200, 226, 262, 296, 328] as const;

const WORDS = [
	"amber", "anchor", "apple", "arrow", "aspen", "atlas", "basil", "beach", "birch", "bison", "cedar", "cherry", "cliff", "cloud", "cobalt", "coral",
	"crane", "daisy", "delta", "dune", "eagle", "ember", "falcon", "fern", "fjord", "flint", "forest", "garnet", "glacier", "harbor", "hazel", "heron",
	"iris", "ivory", "jade", "jasper", "juniper", "kite", "lagoon", "lemon", "lotus", "maple", "marble", "meadow", "mint", "moss", "nectar", "oasis",
	"olive", "onyx", "orchid", "otter", "pearl", "pine", "plum", "quartz", "raven", "river", "saffron", "sage", "tulip", "violet", "willow", "zephyr",
] as const;

/** cyrb53: a small, well-distributed 53-bit string hash — enough to derive a stable picture, not a security primitive. */
function cyrb53(str: string, seed: number): number {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export interface FingerprintTraits {
	words: string[];
	hue: number;
	/** 5 rows × 3 columns; mirrored to 5×5 when drawn. */
	cells: boolean[][];
}

/** Deterministic words + colour + symmetric pattern derived from a fingerprint, for comparing two screens at a glance. */
export function fingerprintTraits(fingerprint: string): FingerprintTraits {
	const key = fingerprint.replace(/[\s:-]/g, "").toLowerCase();
	const w = cyrb53(key, 1);
	const words = [0, 1, 2, 3].map((i) => WORDS[Math.floor(w / 64 ** i) % 64] as string);
	const c = cyrb53(key, 2);
	const cells = Array.from({ length: 5 }, (_, r) => Array.from({ length: 3 }, (_, col) => Math.floor(c / 2 ** (r * 3 + col)) % 2 === 1));
	return { words, hue: HUES[cyrb53(key, 3) % HUES.length] as number, cells };
}

export function FingerprintIcon({ fingerprint, size = 64, className }: { fingerprint: string; size?: number; className?: string }) {
	const t = useMemo(() => fingerprintTraits(fingerprint), [fingerprint]);
	const fill = `hsl(${t.hue} 68% 52%)`;
	return (
		<svg
			role="img"
			aria-label={`Fingerprint picture: ${t.words.join(" ")}`}
			viewBox="0 0 50 50"
			width={size}
			height={size}
			className={cn("shrink-0 rounded-xl", className)}
			style={{ background: `hsl(${(t.hue + 40) % 360} 60% 50% / 0.2)`, boxShadow: `inset 0 0 0 1px hsl(${(t.hue + 40) % 360} 60% 50% / 0.4)` }}
		>
			{t.cells.map((row, r) =>
				row.map((on, col) =>
					on ? (
						<g key={`${r}-${col}`} fill={fill}>
							<rect x={5.6 + col * 8} y={5.6 + r * 8} width="6.8" height="6.8" rx="1.8" />
							{col < 2 ? <rect x={5.6 + (4 - col) * 8} y={5.6 + r * 8} width="6.8" height="6.8" rx="1.8" /> : null}
						</g>
					) : null,
				),
			)}
		</svg>
	);
}

/**
 * A fingerprint presented for comparison: picture + four words for a quick look, grouped blocks for the exact check.
 * `value` copied to the clipboard stays the raw fingerprint.
 */
export function FingerprintCompare({ label, fingerprint, children, className }: { label: string; fingerprint: string; children?: ReactNode; className?: string }) {
	const { copied, copy } = useCopy();
	const t = useMemo(() => fingerprintTraits(fingerprint), [fingerprint]);
	const blocks = formatFingerprint(fingerprint).split(" ");
	return (
		<div className={cn("flex flex-col gap-3 rounded-xl bg-surface-2 p-3.5 shadow-[inset_0_0_0_1px_var(--border-strong)]", className)}>
			<div className="flex items-center justify-between gap-2">
				<span className="text-2xs font-semibold uppercase tracking-wider text-subtle">{label}</span>
				<Button size="sm" variant="outline" onClick={() => void copy(fingerprint)} aria-label={`Copy ${label.toLowerCase()}`}>
					{copied ? <Check className="text-success" /> : <Copy />}
					{copied ? "Copied" : "Copy"}
				</Button>
			</div>
			<div className="flex items-center gap-3.5">
				<FingerprintIcon fingerprint={fingerprint} size={72} />
				<div className="flex min-w-0 flex-col gap-1.5">
					<span className="text-2xs text-subtle">Quick check — should look and read the same on both screens</span>
					<div className="flex flex-wrap gap-1.5" data-testid="fingerprint-words">
						{t.words.map((word, i) => (
							<span key={`${word}-${i}`} className="rounded-lg bg-surface-1 px-2 py-1 text-[13px] font-semibold capitalize shadow-[inset_0_0_0_1px_var(--border)]">
								{word}
							</span>
						))}
					</div>
				</div>
			</div>
			<p data-testid="fingerprint-value" aria-label={fingerprint} className="grid select-all grid-cols-4 gap-x-2 gap-y-1 font-mono text-[13px] leading-tight text-foreground sm:grid-cols-8 sm:text-sm">
				{blocks.map((b, i) => (
					<span key={`${b}-${i}`} className={cn("rounded-md px-1 py-0.5 text-center", Math.floor(i / 4) % 2 === 0 ? "bg-surface-1" : "bg-surface-3/70")}>
						{b}
					</span>
				))}
			</p>
			{children}
		</div>
	);
}
