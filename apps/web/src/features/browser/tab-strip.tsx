import type { BrowserTab } from "@clam/contracts";
import { Globe, Loader2, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Tip } from "@/ui/tooltip";

function tabTitle(tab: BrowserTab): string {
	if (tab.title) return tab.title;
	if (!tab.url || tab.url === "about:blank") return "New tab";
	try {
		return new URL(tab.url).host || tab.url;
	} catch {
		return tab.url;
	}
}

/** Favicon (a small data: image fetched by the machine's browser) → spinner while loading without one → globe. */
function TabIcon({ faviconUrl, loading }: { faviconUrl: string | null; loading: boolean }) {
	const [broken, setBroken] = useState(false);
	if (faviconUrl && !broken) return <img src={faviconUrl} alt="" width={16} height={16} onError={() => setBroken(true)} className="size-4 rounded-[4px] object-contain" draggable={false} />;
	return loading ? <Loader2 className="size-3.5 animate-spin" /> : <Globe className="size-3.5" />;
}

function TabItem({ tab, active, onSelect, onClose }: { tab: BrowserTab; active: boolean; onSelect: () => void; onClose: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (active) ref.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
	}, [active]);
	const title = tabTitle(tab);
	return (
		<div
			ref={ref}
			className={cn(
				"group/tab flex h-8 w-44 shrink-0 items-center rounded-lg transition-colors coarse:h-11 sm:w-48",
				active ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
			)}
		>
			<button type="button" role="tab" aria-selected={active} onClick={onSelect} title={title} className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pl-2.5 text-left text-xs outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]">
				<span className="grid size-4 shrink-0 place-items-center">
					<TabIcon key={tab.faviconUrl ?? ""} faviconUrl={tab.faviconUrl} loading={tab.loading} />
				</span>
				<span className="truncate">{title}</span>
			</button>
			<button
				type="button"
				aria-label={`Close ${title}`}
				onClick={onClose}
				className={cn(
					"mr-1 grid size-6 shrink-0 place-items-center rounded-md text-subtle outline-none transition-colors hover:bg-border-strong hover:text-foreground coarse:mr-0 coarse:size-11",
					!active && "fine:opacity-0 fine:group-hover/tab:opacity-100 fine:focus-visible:opacity-100",
				)}
			>
				<X className="size-3.5" />
			</button>
		</div>
	);
}

/** Tab row: favicon, title, close; horizontally scrollable, with a + button that stays visible. */
export function TabStrip({ tabs, activeId, creating, onSelect, onClose, onNew }: { tabs: BrowserTab[]; activeId: string | null; creating: boolean; onSelect: (id: string) => void; onClose: (id: string) => void; onNew: () => void }) {
	return (
		<div className="flex items-center gap-1 border-b bg-surface-1 px-2 py-1">
			<div role="tablist" aria-label="Browser tabs" className="scrollbar-none flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain">
				{tabs.map((t) => (
					<TabItem key={t.id} tab={t} active={t.id === activeId} onSelect={() => onSelect(t.id)} onClose={() => onClose(t.id)} />
				))}
			</div>
			<Tip label="New tab">
				<button
					type="button"
					aria-label="New tab"
					disabled={creating}
					onClick={onNew}
					className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-50 coarse:size-11 [&_svg]:size-4"
				>
					{creating ? <Loader2 className="animate-spin" /> : <Plus />}
				</button>
			</Tip>
		</div>
	);
}
