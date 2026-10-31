import { type ModelInfo, routes } from "@clam/contracts";
import { useQuery } from "@tanstack/react-query";
import { Brain, Check, ChevronDown, Cpu, RefreshCw, Search } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queries";
import { cn, formatCompact } from "@/lib/utils";
import { Button } from "@/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Skeleton } from "@/ui/skeleton";
import { Tip } from "@/ui/tooltip";
import { type SessionStream, useStreamMeta } from "./stream-store.ts";

const chip =
	"inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg bg-surface-2 px-2 text-xs font-medium text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[background-color,color] hover:bg-surface-3 hover:text-foreground focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-50 coarse:h-10 coarse:px-3 [&_svg]:size-3.5 [&_svg]:shrink-0";

function useModels() {
	return useQuery({
		queryKey: qk.ompModels,
		queryFn: ({ signal }) => api.get<ModelInfo[]>(routes.ompModels, undefined, { signal }),
		staleTime: 5 * 60_000,
	});
}

interface Group {
	provider: string;
	models: ModelInfo[];
}

export function ModelPicker({ stream, className }: { stream: SessionStream; className?: string }) {
	const model = useStreamMeta(stream, (m) => m.live?.model ?? null);
	const ready = useStreamMeta(stream, (m) => m.live !== null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const deferred = useDeferredValue(query);
	const [active, setActive] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);
	const models = useModels();
	const current = model ? `${model.provider}/${model.id}` : null;

	const { groups, flat } = useMemo(() => {
		const q = deferred.trim().toLowerCase();
		const all = (models.data ?? []).filter((m) => !q || m.name.toLowerCase().includes(q) || m.selector.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q));
		const by = new Map<string, ModelInfo[]>();
		for (const m of all) {
			const list = by.get(m.provider);
			if (list) list.push(m);
			else by.set(m.provider, [m]);
		}
		const groups: Group[] = [...by.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([provider, list]) => ({ provider, models: list.sort((a, b) => a.name.localeCompare(b.name)) }));
		return { groups, flat: groups.flatMap((g) => g.models) };
	}, [models.data, deferred]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset highlight when the query changes
	useEffect(() => setActive(0), [deferred]);
	useEffect(() => {
		if (!open) setQuery("");
	}, [open]);
	useEffect(() => {
		listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const choose = (m: ModelInfo) => {
		setOpen(false);
		if (m.selector === current) return;
		stream.setModel(m.selector, { provider: m.provider, id: m.id, name: m.name }).catch((e) => toast.error(`Could not switch model: ${errorMessage(e)}`));
	};

	let idx = -1;
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tip label="Switch model">
				<PopoverTrigger asChild>
					<button type="button" disabled={!ready} aria-label={`Model: ${model?.name ?? current ?? "none"}. Change model`} className={cn(chip, className)}>
						<Cpu aria-hidden />
						<span className="truncate font-mono">{model ? (model.name ?? model.id) : ready ? "No model" : "—"}</span>
						<ChevronDown className="!size-3 opacity-60" aria-hidden />
					</button>
				</PopoverTrigger>
			</Tip>
			<PopoverContent align="start" className="w-[min(92vw,380px)] p-0">
				<div className="flex items-center gap-2 border-b px-3">
					<Search className="size-3.5 shrink-0 text-subtle" aria-hidden />
					<input
						autoFocus
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "ArrowDown") {
								e.preventDefault();
								setActive((a) => Math.min(flat.length - 1, a + 1));
							} else if (e.key === "ArrowUp") {
								e.preventDefault();
								setActive((a) => Math.max(0, a - 1));
							} else if (e.key === "Enter") {
								e.preventDefault();
								const m = flat[active];
								if (m) choose(m);
							}
						}}
						placeholder="Search models…"
						aria-label="Search models"
						role="combobox"
						aria-expanded
						aria-controls="model-listbox"
						className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle coarse:h-12"
					/>
				</div>
				<div ref={listRef} id="model-listbox" role="listbox" aria-label="Models" className="scrollbar-thin max-h-[min(55dvh,380px)] overflow-y-auto p-1">
					{models.isPending ? (
						<div className="flex flex-col gap-1.5 p-2">
							<Skeleton className="h-8" />
							<Skeleton className="h-8" />
							<Skeleton className="h-8" />
						</div>
					) : models.isError ? (
						<div className="flex flex-col items-start gap-2 p-3 text-[13px]">
							<span className="text-danger">{errorMessage(models.error)}</span>
							<Button size="sm" variant="outline" onClick={() => void models.refetch()}>
								<RefreshCw /> Retry
							</Button>
						</div>
					) : flat.length === 0 ? (
						<div className="p-4 text-center text-[13px] text-muted-foreground">{models.data?.length ? "No models match your search." : "No models available. Log in to a provider in Settings."}</div>
					) : (
						groups.map((g) => (
							<div key={g.provider} role="group" aria-label={g.provider}>
								<div className="sticky top-0 z-[1] bg-overlay/95 px-2 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-wider text-subtle backdrop-blur">{g.provider}</div>
								{g.models.map((m) => {
									idx++;
									const i = idx;
									const selected = m.selector === current;
									return (
										<button
											key={m.selector}
											type="button"
											role="option"
											aria-selected={selected}
											data-idx={i}
											onClick={() => choose(m)}
											onMouseMove={() => setActive(i)}
											className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none coarse:py-2.5", i === active && "bg-surface-3")}
										>
											<span className="flex min-w-0 flex-1 flex-col">
												<span className="truncate text-[13px] font-medium">{m.name}</span>
												<span className="truncate font-mono text-2xs text-subtle">{m.id}</span>
											</span>
											{m.contextWindow ? <span className="tabular shrink-0 font-mono text-2xs text-subtle">{formatCompact(m.contextWindow)}</span> : null}
											{m.reasoning ? <Brain className="size-3.5 shrink-0 text-subtle" aria-label="Supports reasoning" /> : null}
											{selected ? <Check className="size-3.5 shrink-0 text-accent" aria-label="Current model" /> : <span className="size-3.5 shrink-0" />}
										</button>
									);
								})}
							</div>
						))
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}

export function ThinkingPicker({ stream, className }: { stream: SessionStream; className?: string }) {
	const level = useStreamMeta(stream, (m) => m.live?.thinkingLevel ?? null);
	const auto = useStreamMeta(stream, (m) => m.live?.thinkingSelector === "auto");
	const levels = useStreamMeta(stream, (m) => m.live?.availableThinkingLevels);
	const ready = useStreamMeta(stream, (m) => m.live !== null);
	if (!ready) return null;
	const empty = !levels || levels.length === 0;
	return (
		<DropdownMenu>
			<Tip label={empty ? "This model has no thinking levels" : "Thinking level"}>
				<DropdownMenuTrigger asChild>
					<button type="button" disabled={empty} aria-label={`Thinking level: ${auto ? "auto, currently " : ""}${level ?? "none"}. Change`} className={cn(chip, className)}>
						<Brain aria-hidden />
						<span>{auto ? `Auto · ${level ?? "off"}` : (level ?? "off")}</span>
						<ChevronDown className="!size-3 opacity-60" aria-hidden />
					</button>
				</DropdownMenuTrigger>
			</Tip>
			<DropdownMenuContent align="start" className="min-w-40">
				<DropdownMenuLabel>Thinking level</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={auto ? "" : (level ?? "")}
					onValueChange={(v) => {
						if (auto || v !== level) stream.setThinking(v).catch((e) => toast.error(`Could not change thinking level: ${errorMessage(e)}`));
					}}
				>
					{(levels ?? []).map((l) => (
						<DropdownMenuRadioItem key={l} value={l}>
							{l}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
