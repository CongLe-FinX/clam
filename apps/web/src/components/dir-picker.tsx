import { type DirSuggestion, routes } from "@clam/contracts";
import { useQuery } from "@tanstack/react-query";
import { FolderGit2, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Input } from "@/ui/input";

export function DirPicker({ value, onChange, invalid }: { value: string; onChange: (v: string) => void; invalid?: boolean }) {
	const [focused, setFocused] = useState(false);
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setDebounced(value), 160);
		return () => clearTimeout(t);
	}, [value]);
	const suggestions = useQuery({
		queryKey: ["local", "fs-suggest", debounced],
		queryFn: ({ signal }) => api.get<DirSuggestion[]>(routes.dirSuggestions, { prefix: debounced }, { signal }),
		enabled: focused,
		staleTime: 10_000,
		placeholderData: (prev) => prev,
	});
	const items = (suggestions.data ?? []).filter((s) => s.path !== value).slice(0, 8);
	return (
		<div className="relative">
			<Input
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onFocus={() => setFocused(true)}
				onBlur={() => setTimeout(() => setFocused(false), 120)}
				placeholder="/Users/you/code/my-project"
				spellCheck={false}
				autoCapitalize="off"
				autoCorrect="off"
				className="font-mono text-xs"
				aria-invalid={invalid || undefined}
				aria-autocomplete="list"
			/>
			{focused && items.length > 0 ? (
				<ul role="listbox" className="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-xl bg-overlay p-1 shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)] scrollbar-thin animate-pop-in">
					{items.map((s) => (
						<li key={s.path}>
							<button
								type="button"
								role="option"
								aria-selected={false}
								onMouseDown={(e) => {
									e.preventDefault();
									onChange(s.path);
								}}
								className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs hover:bg-surface-3 coarse:py-2.5"
							>
								{s.isGitRepo ? <GitBranch className="size-3.5 shrink-0 text-accent" /> : <FolderGit2 className="size-3.5 shrink-0 text-subtle" />}
								<span className="truncate">{s.path}</span>
							</button>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
