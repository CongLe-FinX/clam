import { type BrowserDevice, type BrowserDownload, type BrowserTab, DESKTOP_VIEWPORT_WIDTH, IPHONE_VIEWPORT } from "@clam/contracts";
import { Activity, ArrowLeft, ArrowRight, Check, ClipboardCopy, Download, Maximize2, Menu, Monitor, MoreVertical, RotateCw, Smartphone, SquareTerminal, X } from "lucide-react";
import { type ReactNode, type RefObject, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/ui/sheet";
import { Tip } from "@/ui/tooltip";
import { AddressBar } from "./address-bar.tsx";
import { DownloadsButton, DownloadsList } from "./downloads.tsx";
import { SwipeZone } from "./swipe-zone.tsx";

const DEVICES: Array<{ id: BrowserDevice; label: string; short: string; icon: typeof Monitor }> = [
	{ id: "fit", label: "Fit to window", short: "Fit", icon: Maximize2 },
	{ id: "desktop", label: `Desktop (${DESKTOP_VIEWPORT_WIDTH} px wide)`, short: "Desktop", icon: Monitor },
	{ id: "iphone", label: `iPhone 16 Pro Max (${IPHONE_VIEWPORT.width}×${IPHONE_VIEWPORT.height})`, short: "iPhone", icon: Smartphone },
];

export interface ToolbarProps {
	tab: BrowserTab | null;
	/** The tab's socket is open: navigation controls are live. */
	live: boolean;
	device: BrowserDevice;
	onDevice: (device: BrowserDevice) => void;
	consoleOpen: boolean;
	consoleErrors: number;
	onToggleConsole: () => void;
	debug: boolean;
	onToggleDebug: () => void;
	downloads: BrowserDownload[];
	addressRef: RefObject<HTMLInputElement | null>;
	onNavigate: (url: string) => void;
	onHistory: (action: "back" | "forward" | "reload" | "stop") => void;
	onCopy: () => void;
	/** Mobile only: open the app navigation drawer. */
	onMenu: () => void;
}

function IconButton({ label, onClick, disabled, active, children, badge }: { label: string; onClick: () => void; disabled?: boolean; active?: boolean; children: ReactNode; badge?: number }) {
	return (
		<Tip label={label}>
			<Button variant="ghost" size="icon" aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick} className={cn("relative", active && "bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent")}>
				{children}
				{badge ? <span className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 font-mono text-2xs font-semibold text-white tabular coarse:right-1 coarse:top-1">{badge > 99 ? "99+" : badge}</span> : null}
			</Button>
		</Tip>
	);
}

/** Fit / Desktop / iPhone as one segmented control (desktop toolbar). */
function DeviceSwitch({ device, onDevice }: { device: BrowserDevice; onDevice: (d: BrowserDevice) => void }) {
	return (
		<div role="radiogroup" aria-label="Device" className="flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-2 p-0.5 shadow-[inset_0_0_0_1px_var(--border)]">
			{DEVICES.map(({ id, label, icon: Icon }) => (
				<Tip key={id} label={label}>
					<button
						type="button"
						role="radio"
						aria-checked={device === id}
						aria-label={label}
						onClick={() => onDevice(id)}
						className={cn(
							"grid size-7 place-items-center rounded-md outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] [&_svg]:size-4",
							device === id ? "bg-accent-soft text-accent shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_35%,transparent)]" : "text-muted-foreground hover:bg-surface-3 hover:text-foreground",
						)}
					>
						<Icon />
					</button>
				</Tip>
			))}
		</div>
	);
}

const sheetRow =
	"flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 active:bg-surface-3 disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

function SheetRow({ icon, label, onClick, disabled, trailing }: { icon: ReactNode; label: string; onClick: () => void; disabled?: boolean; trailing?: ReactNode }) {
	return (
		<button type="button" className={sheetRow} onClick={onClick} disabled={disabled}>
			{icon}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{trailing}
		</button>
	);
}

export function BrowserToolbar(p: ToolbarProps & { compact: boolean }) {
	const [moreOpen, setMoreOpen] = useState(false);
	const [downloadsOpen, setDownloadsOpen] = useState(false);
	const loading = p.tab?.loading ?? false;
	const reload = () => p.onHistory(loading ? "stop" : "reload");
	const address = <AddressBar url={p.tab?.url} loading={loading} progress={p.tab?.progress ?? 0} disabled={!p.tab} onSubmit={p.onNavigate} inputRef={p.addressRef} />;

	if (!p.compact) {
		return (
			<div className="flex items-center gap-1 border-b bg-surface-1 px-2 py-1.5">
				<IconButton label="Back" onClick={() => p.onHistory("back")} disabled={!p.live || !p.tab?.canGoBack}>
					<ArrowLeft />
				</IconButton>
				<IconButton label="Forward" onClick={() => p.onHistory("forward")} disabled={!p.live || !p.tab?.canGoForward}>
					<ArrowRight />
				</IconButton>
				<IconButton label={loading ? "Stop loading" : "Reload"} onClick={reload} disabled={!p.live}>
					{loading ? <X /> : <RotateCw />}
				</IconButton>
				{address}
				<DeviceSwitch device={p.device} onDevice={p.onDevice} />
				<span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />
				<IconButton label="Copy the page's selected text" onClick={p.onCopy} disabled={!p.live}>
					<ClipboardCopy />
				</IconButton>
				<IconButton label={p.consoleOpen ? "Hide console" : "Show console"} onClick={p.onToggleConsole} active={p.consoleOpen} badge={p.consoleErrors}>
					<SquareTerminal />
				</IconButton>
				<IconButton label={p.debug ? "Hide stream statistics" : "Show stream statistics"} onClick={p.onToggleDebug} active={p.debug}>
					<Activity />
				</IconButton>
				<DownloadsButton downloads={p.downloads} />
			</div>
		);
	}

	// Compact (phones): menu · back · address · reload · options sheet. The bar owns the top safe-area inset.
	return (
		<div className="border-b bg-surface-1 pt-safe">
			<div className="flex items-center gap-0.5 px-1 py-1">
				<Button variant="ghost" size="icon" aria-label="Open navigation" onClick={p.onMenu}>
					<Menu />
				</Button>
				<Button variant="ghost" size="icon" aria-label="Back" onClick={() => p.onHistory("back")} disabled={!p.live || !p.tab?.canGoBack}>
					<ArrowLeft />
				</Button>
				{address}
				<Button variant="ghost" size="icon" aria-label={loading ? "Stop loading" : "Reload"} onClick={reload} disabled={!p.live}>
					{loading ? <X /> : <RotateCw />}
				</Button>
				<Button variant="ghost" size="icon" aria-label="Browser options" className="relative" onClick={() => setMoreOpen(true)}>
					<MoreVertical />
					{p.consoleErrors > 0 ? <span aria-hidden className="absolute right-2 top-2 size-2 rounded-full bg-danger" /> : null}
				</Button>
			</div>

			<Sheet open={moreOpen} onOpenChange={setMoreOpen}>
				<SheetContent side="bottom" className="pb-safe">
					<SwipeZone onDismiss={() => setMoreOpen(false)} />
					<div className="px-4 pb-2 pt-3">
						<SheetTitle>Browser options</SheetTitle>
						<SheetDescription className="sr-only">Device size, console, statistics and downloads for this tab.</SheetDescription>
					</div>
					<div className="flex flex-col gap-2 px-3 pb-3">
						<div role="radiogroup" aria-label="Device" className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1 shadow-[inset_0_0_0_1px_var(--border)]">
							{DEVICES.map(({ id, label, short, icon: Icon }) => (
								<button
									key={id}
									type="button"
									role="radio"
									aria-checked={p.device === id}
									aria-label={label}
									onClick={() => p.onDevice(id)}
									className={cn(
										"flex h-14 flex-col items-center justify-center gap-1 rounded-lg text-xs font-medium outline-none transition-colors active:scale-[0.97] [&_svg]:size-5",
										p.device === id ? "bg-accent-soft text-accent shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_35%,transparent)]" : "text-muted-foreground",
									)}
								>
									<Icon />
									{short}
								</button>
							))}
						</div>
						<div className="flex flex-col">
							<SheetRow
								icon={<ArrowRight />}
								label="Forward"
								disabled={!p.live || !p.tab?.canGoForward}
								onClick={() => {
									setMoreOpen(false);
									p.onHistory("forward");
								}}
							/>
							<SheetRow
								icon={<ClipboardCopy />}
								label="Copy from page"
								disabled={!p.live}
								onClick={() => {
									setMoreOpen(false);
									p.onCopy();
								}}
							/>
							<SheetRow
								icon={<Download />}
								label="Downloads"
								trailing={p.downloads.length > 0 ? <span className="font-mono text-xs text-muted-foreground tabular">{p.downloads.length}</span> : null}
								onClick={() => {
									setMoreOpen(false);
									setDownloadsOpen(true);
								}}
							/>
							<SheetRow
								icon={<SquareTerminal />}
								label="Console"
								trailing={
									<>
										{p.consoleErrors > 0 ? <span className="rounded-full bg-danger/15 px-1.5 font-mono text-2xs text-danger tabular">{p.consoleErrors} errors</span> : null}
										{p.consoleOpen ? <Check className="!text-accent" /> : null}
									</>
								}
								onClick={() => {
									setMoreOpen(false);
									p.onToggleConsole();
								}}
							/>
							<SheetRow icon={<Activity />} label="Stream statistics" trailing={p.debug ? <Check className="!text-accent" /> : null} onClick={p.onToggleDebug} />
						</div>
					</div>
				</SheetContent>
			</Sheet>

			<Sheet open={downloadsOpen} onOpenChange={setDownloadsOpen}>
				<SheetContent side="bottom" className="max-h-[70dvh]">
					<SwipeZone onDismiss={() => setDownloadsOpen(false)} />
					<div className="px-4 pb-1 pt-3">
						<SheetTitle>Downloads</SheetTitle>
						<SheetDescription>Saved on this machine. Tap Save to get a copy on this device.</SheetDescription>
					</div>
					<DownloadsList downloads={p.downloads} className="max-h-none flex-1 px-2 pb-2" />
				</SheetContent>
			</Sheet>
		</div>
	);
}
