import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { msg, t, tr, type Msg } from "@/i18n";
import { setThemePref, type ThemePref, useThemePref } from "@/lib/theme";
import { cn } from "@/lib/utils";

const OPTIONS: readonly { value: ThemePref; icon: LucideIcon; label: Msg; hint: Msg }[] = [
	{ value: "system", icon: Monitor, label: msg("System"), hint: msg("Follows this device") },
	{ value: "light", icon: Sun, label: msg("Light"), hint: msg("Always light") },
	{ value: "dark", icon: Moon, label: msg("Dark"), hint: msg("Always dark") },
];

/** System / Light / Dark. Stored per browser (each device can differ), applied instantly with a cross-fade. */
export function ThemePicker() {
	const pref = useThemePref();
	return (
		<div role="radiogroup" aria-label={t("Theme")} className="grid grid-cols-3 gap-2">
			{OPTIONS.map(({ value, icon: Icon, label, hint }) => {
				const active = pref === value;
				return (
					<button
						key={value}
						type="button"
						role="radio"
						aria-checked={active}
						onClick={() => setThemePref(value)}
						className={cn(
							"group flex min-h-11 flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-center outline-none transition-[background-color,border-color,box-shadow] duration-150",
							"focus-visible:ring-2 focus-visible:ring-accent/60",
							active ? "border-accent bg-accent/10 shadow-[inset_0_0_0_1px_var(--accent)]" : "border-border bg-surface-2 hover:bg-surface-3",
						)}
					>
						<ThemeSwatch value={value} />
						<span className="flex items-center gap-1.5 text-[13px] font-medium">
							<Icon className={cn("size-3.5", active ? "text-accent" : "text-muted-foreground")} />
							{tr(label)}
						</span>
						<span className="text-2xs text-subtle">{tr(hint)}</span>
					</button>
				);
			})}
		</div>
	);
}

/** Tiny static preview of the theme (fixed colours on purpose: it must look the same whatever theme is active). */
function ThemeSwatch({ value }: { value: ThemePref }) {
	const light = <Mini bg="#f6f6f4" bar="#e4e4e0" line="#c9c9c3" accent="#7c5cff" />;
	const dark = <Mini bg="#0b0c0f" bar="#1a1c22" line="#2c2f37" accent="#8b6dff" />;
	if (value === "light") return <div className="h-12 w-full overflow-hidden rounded-lg ring-1 ring-black/10">{light}</div>;
	if (value === "dark") return <div className="h-12 w-full overflow-hidden rounded-lg ring-1 ring-white/10">{dark}</div>;
	return (
		<div className="relative h-12 w-full overflow-hidden rounded-lg ring-1 ring-border">
			<div className="absolute inset-0">{light}</div>
			<div className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">{dark}</div>
		</div>
	);
}

function Mini({ bg, bar, line, accent }: { bg: string; bar: string; line: string; accent: string }) {
	return (
		<div className="flex h-full w-full" style={{ background: bg }}>
			<div className="h-full w-1/4" style={{ background: bar }} />
			<div className="flex flex-1 flex-col justify-center gap-1 px-2">
				<div className="h-1.5 w-3/4 rounded-full" style={{ background: line }} />
				<div className="h-1.5 w-1/2 rounded-full" style={{ background: line }} />
				<div className="h-1.5 w-1/3 rounded-full" style={{ background: accent }} />
			</div>
		</div>
	);
}
