import { Check } from "lucide-react";
import { LOCALES, setLocale, t, useLocale } from "@/i18n";
import { cn } from "@/lib/utils";

/** English / Tiếng Việt. Stored per browser (`clam.locale`), applied instantly without a reload. Native names are never translated. */
export function LanguagePicker() {
	const current = useLocale();
	return (
		<div role="radiogroup" aria-label={t("Language")} className="grid grid-cols-2 gap-2">
			{LOCALES.map(({ id, label }) => {
				const active = current === id;
				return (
					<button
						key={id}
						type="button"
						role="radio"
						lang={id}
						aria-checked={active}
						onClick={() => void setLocale(id)}
						className={cn(
							"flex min-h-11 items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-left text-[13px] font-medium outline-none transition-[background-color,border-color,box-shadow] duration-150",
							"focus-visible:ring-2 focus-visible:ring-accent/60",
							active ? "border-accent bg-accent/10 shadow-[inset_0_0_0_1px_var(--accent)]" : "border-border bg-surface-2 hover:bg-surface-3",
						)}
					>
						<span className="min-w-0 truncate">{label}</span>
						{active ? <Check className="size-3.5 shrink-0 text-accent" /> : <span className="shrink-0 text-2xs uppercase text-subtle">{id}</span>}
					</button>
				);
			})}
		</div>
	);
}
