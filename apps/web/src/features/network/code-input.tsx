import { useState } from "react";
import { cn } from "@/lib/utils";

export const CODE_LENGTH = 8;
const sanitize = (raw: string): string => raw.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, CODE_LENGTH);

/** Pulls `ABCD-1234` out of a whole pasted invitation message; otherwise just cleans what was pasted. */
const fromPaste = (text: string): string => {
	const m = /\b([A-Z0-9]{4})-([A-Z0-9]{4})\b/i.exec(text);
	return sanitize(m ? `${m[1]}${m[2]}` : text);
};

/**
 * Segmented XXXX-XXXX code field. One real (invisible) input sits over the cells, so paste, autofill, the mobile keyboard
 * and screen readers all behave natively; the cells only draw its value.
 */
export function CodeInput({ id, value, onChange, invalid, autoFocus, disabled }: { id?: string; value: string; onChange: (next: string) => void; invalid?: boolean; autoFocus?: boolean; disabled?: boolean }) {
	const [focused, setFocused] = useState(false);
	const active = Math.min(value.length, CODE_LENGTH - 1);
	return (
		<div className="relative mx-auto w-full max-w-sm">
			<div aria-hidden className="flex items-center justify-center gap-1.5 sm:gap-2">
				{Array.from({ length: CODE_LENGTH }, (_, i) => {
					const ch = value[i];
					const isActive = focused && i === active && !disabled;
					return (
						<span key={i} className="contents">
							{i === 4 ? <span className="w-1.5 text-center font-mono text-xl text-subtle sm:w-3">–</span> : null}
							<span
								className={cn(
									"relative grid h-14 min-w-0 flex-1 place-items-center rounded-xl bg-surface-2 font-mono text-2xl font-semibold shadow-[inset_0_0_0_1px_var(--border-strong)] transition-[box-shadow,transform] coarse:h-16",
									ch ? "text-foreground" : "text-subtle/50",
									isActive && "shadow-[inset_0_0_0_2px_var(--accent)]",
									invalid && "shadow-[inset_0_0_0_1.5px_var(--danger)]",
									ch && "animate-pop-in",
								)}
							>
								{ch ?? ""}
								{isActive && !ch ? <span className="animate-caret absolute h-6 w-px bg-accent" /> : null}
							</span>
						</span>
					);
				})}
			</div>
			<input
				id={id}
				value={value}
				onChange={(e) => onChange(sanitize(e.target.value))}
				onPaste={(e) => {
					e.preventDefault();
					onChange(fromPaste(e.clipboardData.getData("text")));
				}}
				onFocus={() => setFocused(true)}
				onBlur={() => setFocused(false)}
				autoFocus={autoFocus}
				disabled={disabled}
				inputMode="text"
				enterKeyHint="go"
				autoCapitalize="characters"
				autoCorrect="off"
				autoComplete="one-time-code"
				spellCheck={false}
				aria-label="Invitation code, 8 characters"
				aria-invalid={invalid}
				data-testid="code-input"
				className="absolute inset-0 size-full cursor-text bg-transparent text-transparent caret-transparent opacity-0 outline-none"
			/>
		</div>
	);
}
