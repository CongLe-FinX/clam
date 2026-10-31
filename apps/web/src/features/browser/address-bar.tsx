import { Globe, Lock } from "lucide-react";
import { type RefObject, useState } from "react";
import { cn } from "@/lib/utils";
import { fieldClass } from "@/ui/input";

const displayUrl = (url: string | undefined): string => (!url || url === "about:blank" ? "" : url);

/** Address field with the page-load progress bar under it. The active tab's URL is shown unless the user is typing. */
export function AddressBar({
	url,
	loading,
	progress,
	disabled,
	onSubmit,
	inputRef,
	className,
}: {
	url: string | undefined;
	loading: boolean;
	progress: number;
	disabled?: boolean;
	onSubmit: (value: string) => void;
	inputRef: RefObject<HTMLInputElement | null>;
	className?: string;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const shown = editing ? draft : displayUrl(url);
	const secure = !editing && url?.startsWith("https:");
	return (
		<form
			className={cn("relative min-w-0 flex-1", className)}
			onSubmit={(e) => {
				e.preventDefault();
				const value = draft.trim();
				if (value) onSubmit(value);
				inputRef.current?.blur();
			}}
		>
			<span aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle [&_svg]:size-3.5">
				{secure ? <Lock /> : <Globe />}
			</span>
			<input
				ref={inputRef}
				value={shown}
				disabled={disabled}
				onChange={(e) => setDraft(e.target.value)}
				onFocus={(e) => {
					const el = e.currentTarget;
					setDraft(displayUrl(url));
					setEditing(true);
					requestAnimationFrame(() => el.select());
				}}
				onBlur={() => setEditing(false)}
				onKeyDown={(e) => {
					if (e.key === "Escape") e.currentTarget.blur();
				}}
				type="text"
				inputMode="url"
				enterKeyHint="go"
				autoCapitalize="off"
				autoCorrect="off"
				autoComplete="off"
				spellCheck={false}
				placeholder="Type localhost:1234 or a web address"
				aria-label="Address"
				className={cn(fieldClass, "h-8 truncate pl-8 pr-3 coarse:h-11 coarse:text-base")}
			/>
			<div aria-hidden className={cn("pointer-events-none absolute inset-x-1 bottom-0 h-0.5 overflow-hidden rounded-full transition-opacity duration-200", loading ? "opacity-100" : "opacity-0")}>
				<div className="h-full origin-left bg-accent transition-transform duration-300 ease-out" style={{ transform: `scaleX(${Math.min(1, Math.max(0.06, progress))})` }} />
			</div>
		</form>
	);
}
