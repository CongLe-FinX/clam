import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Brain, Check, Image as ImageIcon, Search } from "lucide-react";
import type { ModelInfo } from "@clam/contracts";
import { T, t } from "@/i18n";
import { cn, formatCost, formatList } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { fmtTokens } from "@/features/usage/format";

const ALL = "__all__";

export function useMediaQuery(query: string): boolean {
	const [m, setM] = useState(() => (typeof window === "undefined" ? false : window.matchMedia(query).matches));
	useEffect(() => {
		const mq = window.matchMedia(query);
		const on = () => setM(mq.matches);
		mq.addEventListener("change", on);
		on();
		return () => mq.removeEventListener("change", on);
	}, [query]);
	return m;
}

/** Cost is USD per million tokens in OMP's catalog. */
function price(v: number | undefined): string {
	if (v == null) return "—";
	if (v === 0) return t("free");
	return formatCost(v);
}

export function filterModels(models: ModelInfo[], q: string, provider: string): ModelInfo[] {
	const needle = q.trim().toLowerCase();
	return models.filter(
		(m) =>
			(provider === ALL || m.provider === provider) &&
			(needle === "" || m.selector.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle)),
	);
}

export function ModelFilters({
	models,
	q,
	onQ,
	provider,
	onProvider,
	count,
}: {
	models: ModelInfo[];
	q: string;
	onQ: (v: string) => void;
	provider: string;
	onProvider: (v: string) => void;
	count: number;
}) {
	const providers = useMemo(() => [...new Set(models.map((m) => m.provider))].sort(), [models]);
	return (
		<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
			<div className="relative flex-1">
				<Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
				<Input value={q} onChange={(e) => onQ(e.target.value)} placeholder={t("Search models")} aria-label={t("Search models")} className="pl-8" />
			</div>
			<Select value={provider} onValueChange={onProvider}>
				<SelectTrigger className="w-full sm:w-48" aria-label={t("Filter by provider")}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={ALL}>{t("All providers")}</SelectItem>
					{providers.map((p) => (
						<SelectItem key={p} value={p}>
							{p}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<span className="shrink-0 text-xs text-muted-foreground sm:w-20 sm:text-right">{t("{count, plural, one {# model} other {# models}}", { count })}</span>
		</div>
	);
}

export function ModelCaps({ m }: { m: ModelInfo }) {
	return (
		<span className="flex flex-wrap items-center gap-1">
			{m.reasoning && (
				<Badge variant="accent" title={m.thinking.length > 0 ? t("Thinking levels: {levels}", { levels: formatList(m.thinking) }) : t("Reasoning model")}>
					<Brain />
					{m.thinking.length > 0 ? t("thinking · {count}", { count: m.thinking.length }) : t("reasoning")}
				</Badge>
			)}
			{m.input.includes("image") && (
				<Badge variant="neutral">
					<ImageIcon />
					{t("vision")}
				</Badge>
			)}
		</span>
	);
}

/** Virtualized list; row layout switches between a table row (≥768 px) and a card (mobile). */
function ModelList({
	models,
	selected,
	onSelect,
	heightClass,
}: {
	models: ModelInfo[];
	selected?: string | null;
	onSelect?: (m: ModelInfo) => void;
	heightClass: string;
}) {
	const wide = useMediaQuery("(min-width: 768px)");
	const ref = useRef<HTMLDivElement>(null);
	const size = wide ? 52 : 84;
	const virt = useVirtualizer({ count: models.length, getScrollElement: () => ref.current, estimateSize: () => size, overscan: 8 });
	useEffect(() => virt.measure(), [size, virt]);

	return (
		<div ref={ref} className={cn("scrollbar-thin overflow-y-auto overscroll-contain rounded-lg border border-border", heightClass)}>
			{wide && (
				<div className="sticky top-0 z-10 grid grid-cols-[minmax(0,2.2fr)_5.5rem_5.5rem_10rem_minmax(0,1.4fr)] gap-3 border-b border-border bg-surface-1 px-3 py-2 text-2xs font-medium uppercase tracking-wider text-subtle">
					<span>{t("Model")}</span>
					<span className="text-right">{t("Context")}</span>
					<span className="text-right">{t("Max out")}</span>
					<span className="text-right">{t("$ / M tok (in · out)")}</span>
					<span>{t("Capabilities")}</span>
				</div>
			)}
			{models.length === 0 && <div className="py-10 text-center text-sm text-muted-foreground">{t("No models match.")}</div>}
			<div style={{ height: virt.getTotalSize(), position: "relative" }}>
				{virt.getVirtualItems().map((v) => {
					const m = models[v.index]!;
					const isSel = selected === m.selector;
					const Row = onSelect ? "button" : "div";
					return (
						<Row
							key={m.selector}
							type={onSelect ? "button" : undefined}
							onClick={onSelect ? () => onSelect(m) : undefined}
							aria-pressed={onSelect ? isSel : undefined}
							className={cn(
								"absolute inset-x-0 top-0 w-full border-b border-border/70 px-3 text-left outline-none",
								onSelect && "hover:bg-surface-2 focus-visible:bg-surface-2",
								isSel && "bg-accent-soft",
								wide ? "grid grid-cols-[minmax(0,2.2fr)_5.5rem_5.5rem_10rem_minmax(0,1.4fr)] items-center gap-3" : "flex flex-col justify-center gap-1",
							)}
							style={{ height: v.size, transform: `translateY(${v.start}px)` }}
						>
							<span className="min-w-0">
								<span className="flex items-center gap-1.5">
									<span className="truncate text-sm">{m.name}</span>
									{isSel && <Check className="size-3.5 shrink-0 text-accent" />}
								</span>
								<span className="block truncate font-mono text-[11px] text-muted-foreground">{m.selector}</span>
							</span>
							{wide ? (
								<>
									<span className="text-right font-mono text-xs tabular-nums">{m.contextWindow ? fmtTokens(m.contextWindow) : "—"}</span>
									<span className="text-right font-mono text-xs tabular-nums">{m.maxTokens ? fmtTokens(m.maxTokens) : "—"}</span>
									<span className="text-right font-mono text-xs tabular-nums">
										{m.cost ? `${price(m.cost.input)} · ${price(m.cost.output)}` : "—"}
									</span>
									<ModelCaps m={m} />
								</>
							) : (
								<span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
									<span>{t("ctx {size}", { size: m.contextWindow ? fmtTokens(m.contextWindow) : "—" })}</span>
									<span>{m.cost ? t("{input} · {output} /M", { input: price(m.cost.input), output: price(m.cost.output) }) : t("price —")}</span>
									<ModelCaps m={m} />
								</span>
							)}
						</Row>
					);
				})}
			</div>
		</div>
	);
}

export function ModelCatalog({ models }: { models: ModelInfo[] }) {
	const [q, setQ] = useState("");
	const [provider, setProvider] = useState(ALL);
	const filtered = useMemo(() => filterModels(models, q, provider), [models, q, provider]);
	return (
		<div className="space-y-3">
			<ModelFilters models={models} q={q} onQ={setQ} provider={provider} onProvider={setProvider} count={filtered.length} />
			<ModelList models={filtered} heightClass="h-[28rem]" />
		</div>
	);
}

/** Pick a model (and optional thinking level) for a role. Resolves `onPick` with `provider/id[:level]`. */
export function ModelPickerDialog({
	open,
	onOpenChange,
	models,
	role,
	current,
	onPick,
	busy,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	models: ModelInfo[];
	role: string;
	current: string | null;
	onPick: (selector: string) => void;
	busy: boolean;
}) {
	const [q, setQ] = useState("");
	const [provider, setProvider] = useState(ALL);
	const [picked, setPicked] = useState<ModelInfo | null>(null);
	const [level, setLevel] = useState("");
	const filtered = useMemo(() => filterModels(models, q, provider), [models, q, provider]);

	useEffect(() => {
		if (!open) {
			setQ("");
			setProvider(ALL);
			setPicked(null);
			setLevel("");
		}
	}, [open]);

	const levels = picked?.thinking ?? [];
	const selector = picked ? `${picked.selector}${level ? `:${level}` : ""}` : null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>
						<T text="Choose model for <code>{role}</code>" params={{ role }} tags={{ code: <span className="font-mono" /> }} />
					</DialogTitle>
					<DialogDescription>
						<T text="Writes <code>modelRoles.{role}</code> in your OMP config." params={{ role }} tags={{ code: <span className="font-mono" /> }} />
						{current ? (
							<>
								{" "}
								<T text="Currently <code>{current}</code>." params={{ current }} tags={{ code: <span className="font-mono" /> }} />
							</>
						) : null}
					</DialogDescription>
				</DialogHeader>
				<ModelFilters models={models} q={q} onQ={setQ} provider={provider} onProvider={setProvider} count={filtered.length} />
				<ModelList
					models={filtered}
					selected={picked?.selector}
					onSelect={(m) => {
						setPicked(m);
						setLevel("");
					}}
					heightClass="h-[min(24rem,45dvh)]"
				/>
				{levels.length > 0 && (
					<div className="flex flex-wrap items-center gap-2 text-sm">
						<span className="text-muted-foreground">{t("Thinking level")}</span>
						{["", ...levels].map((l) => (
							<button
								key={l || "default"}
								type="button"
								onClick={() => setLevel(l)}
								className={cn(
									"rounded-md border px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
									level === l ? "border-accent bg-accent-soft text-accent" : "border-border text-muted-foreground hover:text-foreground",
								)}
							>
								{l || t("model default")}
							</button>
						))}
					</div>
				)}
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						{t("Cancel")}
					</Button>
					<Button disabled={!selector} loading={busy} onClick={() => selector && onPick(selector)}>
						{selector ? t("Use {selector}", { selector }) : t("Select a model")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
