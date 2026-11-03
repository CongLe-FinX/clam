import { type ModelInfo, routes } from "@clam/contracts";
import { useQuery } from "@tanstack/react-query";
import { Brain, Check, ChevronDown, Cpu, RefreshCw, Search } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { t } from "@/i18n";
import { api, errorText } from "@/lib/api";
import { qk } from "@/lib/queries";
import { cn, formatCompact } from "@/lib/utils";
import { Button } from "@/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/ui/sheet";
import { Skeleton } from "@/ui/skeleton";
import { Tip } from "@/ui/tooltip";
import { type SessionStream, useStreamMeta } from "./stream-store.ts";

const chip =
	"inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg bg-surface-2 px-2 text-xs font-medium text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[background-color,color] hover:bg-surface-3 hover:text-foreground focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-50 coarse:h-10 coarse:px-3 [&_svg]:size-3.5 [&_svg]:shrink-0";

export function useModels() {
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

/** Search box + provider-grouped model list. Unmounts with its container, so the query resets every time it opens. */
function ModelList({ stream, onChosen, autoFocus }: { stream: SessionStream; onChosen: () => void; autoFocus: boolean }) {
	const model = useStreamMeta(stream, (m) => m.live?.model ?? null);
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
		listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const choose = (m: ModelInfo) => {
		onChosen();
		if (m.selector === current) return;
		stream.setModel(m.selector, { provider: m.provider, id: m.id, name: m.name }).catch((e) => toast.error(t("Could not switch model: {error}", { error: errorText(e) })));
	};

	let idx = -1;
	return (
		<>
			<div className="flex items-center gap-2 border-b px-3">
				<Search className="size-3.5 shrink-0 text-subtle" aria-hidden />
				<input
					autoFocus={autoFocus}
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
					placeholder={t("Search models…")}
					aria-label={t("Search models")}
					role="combobox"
					aria-expanded
					aria-controls="model-listbox"
					className="h-10 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-subtle md:text-[13px] coarse:h-12"
				/>
			</div>
			<div ref={listRef} id="model-listbox" role="listbox" aria-label={t("Models")} className="scrollbar-thin max-h-[min(55dvh,380px)] overflow-y-auto p-1">
				{models.isPending ? (
					<div className="flex flex-col gap-1.5 p-2">
						<Skeleton className="h-8" />
						<Skeleton className="h-8" />
						<Skeleton className="h-8" />
					</div>
				) : models.isError ? (
					<div className="flex flex-col items-start gap-2 p-3 text-[13px]">
						<span className="text-danger">{errorText(models.error)}</span>
						<Button size="sm" variant="outline" onClick={() => void models.refetch()}>
							<RefreshCw /> {t("Retry")}
						</Button>
					</div>
				) : flat.length === 0 ? (
					<div className="p-4 text-center text-[13px] text-muted-foreground">{models.data?.length ? t("No models match your search.") : t("No models available. Log in to a provider in Settings.")}</div>
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
										className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none coarse:min-h-11 coarse:py-2", i === active && "bg-surface-3")}
									>
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="truncate text-[13px] font-medium">{m.name}</span>
											<span className="truncate font-mono text-2xs text-subtle">{m.id}</span>
										</span>
										{m.contextWindow ? <span className="tabular shrink-0 font-mono text-2xs text-subtle">{formatCompact(m.contextWindow)}</span> : null}
										{m.reasoning ? <Brain className="size-3.5 shrink-0 text-subtle" aria-label={t("Supports reasoning")} /> : null}
										{selected ? <Check className="size-3.5 shrink-0 text-accent" aria-label={t("Current model")} /> : <span className="size-3.5 shrink-0" />}
									</button>
								);
							})}
						</div>
					))
				)}
			</div>
		</>
	);
}

export function ModelPicker({ stream, className }: { stream: SessionStream; className?: string }) {
	const model = useStreamMeta(stream, (m) => m.live?.model ?? null);
	const ready = useStreamMeta(stream, (m) => m.live !== null);
	const [open, setOpen] = useState(false);
	const current = model ? `${model.provider}/${model.id}` : null;
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tip label={t("Switch model")}>
				<PopoverTrigger asChild>
					<button type="button" disabled={!ready} aria-label={t("Model: {name}. Change model", { name: model?.name ?? current ?? t("none") })} className={cn(chip, className)}>
						<Cpu aria-hidden />
						<span className="truncate font-mono">{model ? (model.name ?? model.id) : ready ? t("No model") : "—"}</span>
						<ChevronDown className="!size-3 opacity-60" aria-hidden />
					</button>
				</PopoverTrigger>
			</Tip>
			<PopoverContent align="start" className="w-[min(92vw,380px)] p-0">
				<ModelList stream={stream} onChosen={() => setOpen(false)} autoFocus />
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
			<Tip label={empty ? t("This model has no thinking levels") : t("Thinking level")}>
				<DropdownMenuTrigger asChild>
					<button type="button" disabled={empty} aria-label={auto ? t("Thinking level: auto, currently {level}. Change", { level: level ?? t("none") }) : t("Thinking level: {level}. Change", { level: level ?? t("none") })} className={cn(chip, className)}>
						<Brain aria-hidden />
						<span>{auto ? t("Auto · {level}", { level: level ?? t("off") }) : (level ?? t("off"))}</span>
						<ChevronDown className="!size-3 opacity-60" aria-hidden />
					</button>
				</DropdownMenuTrigger>
			</Tip>
			<DropdownMenuContent align="start" className="min-w-40">
				<DropdownMenuLabel>{t("Thinking level")}</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={auto ? "" : (level ?? "")}
					onValueChange={(v) => {
						if (auto || v !== level) stream.setThinking(v).catch((e) => toast.error(t("Could not change thinking level: {error}", { error: errorText(e) })));
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

/** Thinking levels as a segmented control (used inside the combined model/thinking sheet). */
function ThinkingLevels({ stream }: { stream: SessionStream }) {
	const level = useStreamMeta(stream, (m) => m.live?.thinkingLevel ?? null);
	const auto = useStreamMeta(stream, (m) => m.live?.thinkingSelector === "auto");
	const levels = useStreamMeta(stream, (m) => m.live?.availableThinkingLevels);
	if (!levels || levels.length === 0) return <p className="px-3 py-2.5 text-xs text-subtle">{t("This model has no thinking levels.")}</p>;
	return (
		<div role="radiogroup" aria-label={t("Thinking level")} className="flex flex-wrap gap-1 px-3 py-2.5">
			{levels.map((l) => {
				const on = !auto && l === level;
				return (
					<button
						key={l}
						type="button"
						role="radio"
						aria-checked={on}
						onClick={() => {
							if (!on) stream.setThinking(l).catch((e) => toast.error(t("Could not change thinking level: {error}", { error: errorText(e) })));
						}}
						className={cn("h-8 rounded-lg px-3 text-xs font-medium capitalize outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-11", on ? "bg-accent text-accent-foreground" : "bg-surface-2 text-muted-foreground hover:bg-surface-3 hover:text-foreground")}
					>
						{l}
					</button>
				);
			})}
		</div>
	);
}

/**
 * One compact chip for phones: the model name on top, the thinking level under it, so the name gets the chip's whole width instead of
 * sharing one line. Opens a bottom sheet holding the thinking level and the model list, so the composer keeps a single row.
 */
export function ModelSettings({ stream, className }: { stream: SessionStream; className?: string }) {
	const model = useStreamMeta(stream, (m) => m.live?.model ?? null);
	const ready = useStreamMeta(stream, (m) => m.live !== null);
	const level = useStreamMeta(stream, (m) => m.live?.thinkingLevel ?? null);
	const auto = useStreamMeta(stream, (m) => m.live?.thinkingSelector === "auto");
	const hasLevels = useStreamMeta(stream, (m) => (m.live?.availableThinkingLevels?.length ?? 0) > 0);
	const [open, setOpen] = useState(false);
	const name = model ? (model.name ?? model.id) : ready ? t("No model") : "—";
	const thinking = hasLevels ? (auto ? t("Auto · {level}", { level: level ?? t("off") }) : (level ?? t("off"))) : null;
	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetTrigger asChild>
				<button
					type="button"
					disabled={!ready}
					aria-label={thinking ? t("Model {name}, thinking {thinking}. Change", { name, thinking }) : t("Model {name}. Change", { name })}
					className={cn(chip, "min-w-0 coarse:px-2.5", className)}
				>
					{/* The name keeps the whole first line; the thinking level and the chevron share the small second one. */}
					<span className="flex min-w-0 flex-col items-start">
						<span className="max-w-full truncate text-xs font-semibold leading-4 text-foreground">{name}</span>
						<span className="flex max-w-full items-center gap-0.5 text-[10px] font-medium leading-3 text-subtle">
							{thinking ? <Brain aria-hidden className="!size-2.5" /> : null}
							<span className="truncate">{thinking ?? t("Model")}</span>
							<ChevronDown className="!size-2.5 opacity-70" aria-hidden />
						</span>
					</span>
				</button>
			</SheetTrigger>
			<SheetContent side="bottom" aria-describedby={undefined} className="p-0">
				<SheetTitle className="px-4 pb-1 pt-3">{t("Model and thinking")}</SheetTitle>
				<div className="text-2xs font-medium uppercase tracking-wider text-subtle px-4 pt-1">{t("Thinking")}</div>
				<ThinkingLevels stream={stream} />
				<div className="text-2xs font-medium uppercase tracking-wider text-subtle px-4 pb-1">{t("Model")}</div>
				<div className="flex min-h-0 flex-1 flex-col border-t">{open ? <ModelList stream={stream} onChosen={() => setOpen(false)} autoFocus={false} /> : null}</div>
			</SheetContent>
		</Sheet>
	);
}

/** Whether the session's current model takes pictures as input (unknown models and a model list that has not loaded yet count as yes), and its display name. */
export function useVisionInput(stream: SessionStream): { supported: boolean; modelName: string | null } {
	const model = useStreamMeta(stream, (m) => m.live?.model ?? null);
	const models = useModels();
	if (!model) return { supported: true, modelName: null };
	const info = models.data?.find((m) => m.provider === model.provider && m.id === model.id);
	return { supported: info ? info.input.includes("image") : true, modelName: model.name ?? info?.name ?? model.id };
}
