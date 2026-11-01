import type { ListeningPort } from "@clam/contracts";
import { ChevronRight, Server, ServerOff } from "lucide-react";
import { useState } from "react";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/ui/sheet";
import { Skeleton } from "@/ui/skeleton";
import { SwipeZone } from "./swipe-zone.tsx";

const TITLE_MAX = 22;
const ROW_CHIPS = { desktop: 5, mobile: 3 } as const;
const START_CHIPS = 6;

const chipClass =
	"inline-flex h-7 max-w-[16rem] shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-surface-2 px-3 text-xs text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[background-color,color,transform] duration-150 hover:bg-surface-3 hover:text-foreground focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] active:scale-[0.97] coarse:h-11 coarse:px-4";

/** At most `max` characters, cut at a word boundary, with an ellipsis. */
export function shortTitle(text: string, max = TITLE_MAX): string {
	const clean = text.trim().replace(/\s+/g, " ");
	if (clean.length <= max) return clean;
	const cut = clean.slice(0, max);
	const space = cut.lastIndexOf(" ");
	return `${(space >= 8 ? cut.slice(0, space) : cut).replace(/[\s·:,;–—-]+$/, "")}…`;
}

function runsAs(p: ListeningPort): string | null {
	return p.process ? (p.hint ? `${p.process} (${p.hint})` : p.process) : p.hint;
}

/** Full, untruncated name: the page title, else what runs there. */
function fullTitle(p: ListeningPort): string {
	return p.title?.trim() || runsAs(p) || t("Web server");
}

function Chip({ port, onOpen }: { port: ListeningPort; onOpen: (url: string) => void }) {
	const full = fullTitle(port);
	return (
		<button type="button" className={chipClass} onClick={() => onOpen(port.url)} title={`${full} · ${port.url}${runsAs(port) ? ` · ${runsAs(port)}` : ""}`} aria-label={t("Open {name} on port {port}", { name: full, port: port.port })}>
			<span className="truncate text-foreground/90">{shortTitle(full)}</span>
			<span className="shrink-0 font-mono text-2xs text-subtle">:{port.port}</span>
		</button>
	);
}

function OtherPorts({ ports, onOpen, compact }: { ports: ListeningPort[]; onOpen: (url: string) => void; compact: boolean }) {
	const [open, setOpen] = useState(false);
	if (ports.length === 0) return null;
	const trigger = (onClick?: () => void) => (
		<button type="button" className={cn(chipClass, "gap-0.5 px-2.5")} aria-label={t("{count, plural, one {# more local web server} other {# more local web servers}}", { count: ports.length })} aria-expanded={open} onClick={onClick}>
			+{ports.length}
			<ChevronRight className="size-3 opacity-60" />
		</button>
	);
	const list = (
		<ul className="scrollbar-thin max-h-[min(24rem,60dvh)] overflow-y-auto overscroll-contain">
			{ports.map((p) => (
				<li key={`${p.address}:${p.port}`}>
					<button
						type="button"
						onClick={() => {
							setOpen(false);
							onOpen(p.url);
						}}
						title={`${fullTitle(p)} · ${p.url}`}
						className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-surface-3 focus-visible:bg-surface-3 coarse:min-h-12"
					>
						<Server className="size-4 shrink-0 text-subtle" />
						<span className="min-w-0 flex-1">
							<span className="block truncate text-[13px] text-foreground">{fullTitle(p)}</span>
							{p.title && runsAs(p) ? <span className="block truncate text-2xs text-subtle">{runsAs(p)}</span> : null}
						</span>
						<span className="shrink-0 font-mono text-xs text-muted-foreground">:{p.port}</span>
					</button>
				</li>
			))}
		</ul>
	);
	if (compact) {
		return (
			<>
				{trigger(() => setOpen(true))}
				<Sheet open={open} onOpenChange={setOpen}>
					<SheetContent side="bottom" className="max-h-[70dvh]">
						<SwipeZone onDismiss={() => setOpen(false)} />
						<div className="px-4 pb-1 pt-3">
							<SheetTitle>{t("More on this machine")}</SheetTitle>
							<SheetDescription>{t("Local web servers. Tap one to open it in this tab.")}</SheetDescription>
						</div>
						<div className="px-2 pb-3">{list}</div>
					</SheetContent>
				</Sheet>
			</>
		);
	}
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>{trigger()}</PopoverTrigger>
			<PopoverContent align="start" className="w-80 p-1.5">
				<p className="px-2.5 pb-1 pt-1 text-2xs font-medium uppercase tracking-wider text-subtle">{t("More on this machine")}</p>
				{list}
			</PopoverContent>
		</Popover>
	);
}

function EmptyPorts() {
	return (
		<span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-subtle">
			<ServerOff className="size-3.5" /> {t("No local web servers detected")}
		</span>
	);
}

/** "Running on this machine": one-tap chips for the web servers the machine reports (server order, newest first). */
export function PortsRow({ ports, onOpen, className }: { ports: ListeningPort[] | undefined; onOpen: (url: string) => void; className?: string }) {
	const compact = useBreakpoint() === "mobile";
	const cap = compact ? ROW_CHIPS.mobile : ROW_CHIPS.desktop;
	const shown = ports?.slice(0, cap) ?? [];
	const rest = ports?.slice(cap) ?? [];
	return (
		<div className={cn("flex min-w-0 items-center gap-2 px-2 py-1.5 sm:px-3", className)}>
			<span className="hidden shrink-0 items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-subtle md:flex">
				<Server className="size-3.5" /> {t("Running on this machine")}
			</span>
			<div className="scrollbar-none flex min-h-7 min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overscroll-x-contain coarse:min-h-11" role="list" aria-label={t("Running on this machine")}>
				{ports === undefined ? (
					<>
						<Skeleton className="h-7 w-32 rounded-full coarse:h-11" />
						<Skeleton className="h-7 w-28 rounded-full coarse:h-11" />
					</>
				) : ports.length === 0 ? (
					<EmptyPorts />
				) : (
					<>
						{shown.map((p) => (
							<div key={`${p.address}:${p.port}`} role="listitem" className="shrink-0">
								<Chip port={p} onOpen={onOpen} />
							</div>
						))}
						<OtherPorts ports={rest} onOpen={onOpen} compact={compact} />
					</>
				)}
			</div>
		</div>
	);
}

/** Wrapping variant for the start page: the first few servers, the rest behind "+N". */
export function PortChips({ ports, onOpen }: { ports: ListeningPort[]; onOpen: (url: string) => void }) {
	const compact = useBreakpoint() === "mobile";
	if (ports.length === 0) return <EmptyPorts />;
	return (
		<div className="flex flex-wrap justify-center gap-1.5">
			{ports.slice(0, START_CHIPS).map((p) => (
				<Chip key={`${p.address}:${p.port}`} port={p} onOpen={onOpen} />
			))}
			<OtherPorts ports={ports.slice(START_CHIPS)} onOpen={onOpen} compact={compact} />
		</div>
	);
}
