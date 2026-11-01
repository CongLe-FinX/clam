import { type BrowserDevice, type BrowserDownload, type BrowserStatus, type BrowserTab, routes } from "@clam/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { accessKey } from "@/features/auth/hooks";
import { t } from "@/i18n";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { api, errorText } from "@/lib/api";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { SwipeZone } from "./swipe-zone.tsx";
import { bk, isToolDisabled, useBrowserStatus, useBrowserTabs, useListeningPorts } from "./api.ts";
import { copyAnswerToClipboard } from "./clipboard.ts";
import { type ConnEvents, useTabConnection } from "./connection.ts";
import { DebugOverlay } from "./debug-overlay.tsx";
import { DevtoolsPanel } from "./devtools-panel.tsx";
import { downloadHref } from "./downloads.tsx";
import { FileChooserDialog, PageDialog } from "./page-dialogs.tsx";
import { PortsRow } from "./ports-row.tsx";
import { BrowserSkeleton, ErrorCard, InstallCard, RemoteOffCard, StartPage } from "./states.tsx";
import { TabStrip } from "./tab-strip.tsx";
import { BrowserToolbar } from "./toolbar.tsx";
import { BrowserViewer } from "./viewer.tsx";

const NO_TABS: BrowserTab[] = [];
const NO_DOWNLOADS: BrowserDownload[] = [];
const DEVICE_KEY = "clam.browser.device";
const DEBUG_KEY = "clam.browser.debug";
const DEVICES: readonly BrowserDevice[] = ["fit", "desktop", "iphone"];

function useStored<T extends string>(key: string, initial: T, valid: readonly T[]): [T, (next: T) => void] {
	const [value, setValue] = useState<T>(() => {
		try {
			const raw = localStorage.getItem(key);
			return valid.find((v) => v === raw) ?? initial;
		} catch {
			return initial;
		}
	});
	const set = useCallback(
		(next: T) => {
			setValue(next);
			try {
				localStorage.setItem(key, next);
			} catch {
				// Private mode: the choice just doesn't persist.
			}
		},
		[key],
	);
	return [value, set];
}

/** `/browser`: this machine's own headless Chromium, streamed to this device. */
export default function BrowserPage() {
	const status = useBrowserStatus();
	const qc = useQueryClient();
	const relaunch = useMutation({
		mutationFn: () => api.post<BrowserTab>(routes.browserTabs),
		onSettled: () => void qc.invalidateQueries({ queryKey: bk.all }),
		onError: (e) => toast.error(errorText(e)),
	});

	if (status.isPending) return <BrowserSkeleton />;
	if (isToolDisabled(status.error)) return <RemoteOffCard />;
	if (status.isError) return <ErrorCard title={t("Can't reach the Browser")} message={errorText(status.error)} onRetry={() => void status.refetch()} retrying={status.isFetching} />;
	const s: BrowserStatus = status.data;
	if (!s.available) return <InstallCard status={s} />;
	if (s.state === "failed") return <ErrorCard title={t("The browser failed to start")} message={s.error ?? t("Chromium exited unexpectedly.")} onRetry={() => relaunch.mutate()} retrying={relaunch.isPending} />;
	return <BrowserWorkspace status={s} />;
}

function BrowserWorkspace({ status }: { status: BrowserStatus }) {
	const search = useSearch({ from: "/browser" });
	const navigate = useNavigate();
	const qc = useQueryClient();
	const compact = useBreakpoint() === "mobile";
	const setDrawer = useUi((s) => s.setDrawerOpen);

	const tabsQuery = useBrowserTabs(true);
	const ports = useListeningPorts(true);
	const tabs = tabsQuery.data ?? NO_TABS;

	const [device, setDevice] = useStored<BrowserDevice>(DEVICE_KEY, "fit", DEVICES);
	const [debugFlag, setDebugFlag] = useStored<"0" | "1">(DEBUG_KEY, "0", ["0", "1"]);
	const debug = debugFlag === "1";
	const [consoleOpen, setConsoleOpen] = useState(false);
	const [activeId, setActiveId] = useState<string | null>(search.tab ?? null);
	const [creating, setCreating] = useState(false);
	const [opening, setOpening] = useState(false);
	const creatingRef = useRef(false);
	const handledUrl = useRef<string | null>(null);
	const addressRef = useRef<HTMLInputElement>(null);
	const sizeRef = useRef<{ width: number; height: number; dpr: number } | null>(null);

	// A `?url=` arrival holds the connection back until its new tab exists, so the old first tab never flashes.
	const holdConnection = Boolean(search.url) || opening;
	const effectiveId = !tabsQuery.isSuccess || holdConnection ? null : tabs.some((t) => t.id === activeId) ? activeId : (tabs[0]?.id ?? null);
	const activeTab = tabs.find((t) => t.id === effectiveId) ?? null;

	const openTab = useCallback(
		async (url?: string) => {
			creatingRef.current = true;
			setCreating(true);
			try {
				const tab = await api.post<BrowserTab>(routes.browserTabs, url ? { url } : undefined);
				qc.setQueryData<BrowserTab[]>(bk.tabs, (old) => [...(old ?? []).filter((t) => t.id !== tab.id), tab]);
				setActiveId(tab.id);
				void qc.invalidateQueries({ queryKey: bk.status });
			} catch (e) {
				if (isToolDisabled(e)) void qc.invalidateQueries({ queryKey: bk.status });
				else toast.error(errorText(e));
			} finally {
				creatingRef.current = false;
				setCreating(false);
				setOpening(false);
			}
		},
		[qc],
	);

	// Arrival: `?url=` opens a new tab and is stripped; with no tab at all, open a blank one.
	useEffect(() => {
		if (!search.url) handledUrl.current = null;
		if (!tabsQuery.isSuccess) return;
		if (search.url) {
			if (handledUrl.current === search.url) return;
			handledUrl.current = search.url;
			setOpening(true);
			void openTab(search.url);
			void navigate({ to: "/browser", search: search.tab ? { tab: search.tab } : {}, replace: true });
			return;
		}
		if (tabs.length === 0 && !creatingRef.current) void openTab();
	}, [tabsQuery.isSuccess, search.url, search.tab, tabs.length, openTab, navigate]);

	// Keep `?tab=` in step with what is shown, so a reload comes back to the same tab.
	useEffect(() => {
		if (!effectiveId || search.url || search.tab === effectiveId) return;
		void navigate({ to: "/browser", search: { tab: effectiveId }, replace: true });
	}, [effectiveId, search.url, search.tab, navigate]);

	const handleClosed = useCallback(
		(tabId: string) => {
			qc.setQueryData<BrowserTab[]>(bk.tabs, (old) => (old ?? []).filter((t) => t.id !== tabId));
			setActiveId((cur) => (cur === tabId ? null : cur));
			void qc.invalidateQueries({ queryKey: bk.tabs });
		},
		[qc],
	);
	const events: ConnEvents = {
		onClosed: handleClosed,
		onError: (message) => toast.error(message),
		onDownloadDone: (d) => toast.success(t("Downloaded {name}", { name: d.name }), { action: { label: t("Save"), onClick: () => window.location.assign(downloadHref(d.name)) } }),
	};
	const { conn, snapshot } = useTabConnection(effectiveId, events, () => ({
		viewer: sizeRef.current ? { ...sizeRef.current, device } : null,
		visible: document.visibilityState === "visible",
	}));
	const live = snapshot.state === "open";

	useEffect(() => {
		if (snapshot.tabs) qc.setQueryData(bk.tabs, snapshot.tabs);
	}, [snapshot.tabs, qc]);
	useEffect(() => {
		if (snapshot.state !== "signed-out" && snapshot.state !== "unavailable") return;
		void qc.invalidateQueries({ queryKey: bk.status });
		void qc.invalidateQueries({ queryKey: accessKey });
	}, [snapshot.state, qc]);

	const consoleErrors = useMemo(() => snapshot.console.filter((e) => e.level === "error" || e.kind === "exception").length, [snapshot.console]);
	const onViewerSize = useCallback((p: { width: number; height: number; dpr: number }) => {
		sizeRef.current = p;
	}, []);

	const navigateTo = (url: string) => {
		if (!effectiveId) {
			void openTab(url);
			return;
		}
		if (conn && live) conn.send({ type: "navigate", url });
		else api.post(routes.browserNavigate(effectiveId), { url }).catch((e: unknown) => toast.error(errorText(e)));
	};
	const closeTab = (id: string) => {
		const i = tabs.findIndex((t) => t.id === id);
		const next = tabs[i + 1] ?? tabs[i - 1] ?? null;
		qc.setQueryData<BrowserTab[]>(bk.tabs, (old) => (old ?? []).filter((t) => t.id !== id));
		if (effectiveId === id) setActiveId(next?.id ?? null);
		api.delete(routes.browserTab(id)).catch((e: unknown) => {
			toast.error(errorText(e));
			void qc.invalidateQueries({ queryKey: bk.tabs });
		});
	};
	const copyFromPage = () => {
		if (!conn) return;
		void copyAnswerToClipboard(conn.copySelection()).then((text) => (text ? toast.success(t("Copied from the page")) : toast.message(t("Nothing selected on the page"))));
	};

	if (tabsQuery.isError) {
		return isToolDisabled(tabsQuery.error) ? <RemoteOffCard /> : <ErrorCard title={t("Can't list the browser's tabs")} message={errorText(tabsQuery.error)} onRetry={() => void tabsQuery.refetch()} retrying={tabsQuery.isFetching} />;
	}
	if (tabsQuery.isPending || (tabs.length === 0 && (creating || opening))) return <BrowserSkeleton label={creating || status.state === "starting" ? t("Starting the browser on this machine…") : undefined} />;

	const blank = activeTab !== null && (activeTab.url === "" || activeTab.url === "about:blank");
	const devtools = (
		<DevtoolsPanel
			entries={snapshot.console}
			onClear={() => conn?.send({ type: "console-clear" })}
			onClose={() => setConsoleOpen(false)}
			className={compact ? "h-full" : "h-60 shrink-0 border-t"}
		/>
	);

	return (
		<div className={cn("flex h-full min-h-0 flex-col bg-background", compact && "pb-safe")}>
			<BrowserToolbar
				compact={compact}
				tab={activeTab}
				live={live}
				device={device}
				onDevice={setDevice}
				consoleOpen={consoleOpen}
				consoleErrors={consoleErrors}
				onToggleConsole={() => setConsoleOpen((o) => !o)}
				debug={debug}
				onToggleDebug={() => setDebugFlag(debug ? "0" : "1")}
				downloads={snapshot.downloads.length > 0 ? snapshot.downloads : NO_DOWNLOADS}
				addressRef={addressRef}
				onNavigate={navigateTo}
				onHistory={(action) => conn?.send({ type: "history", action })}
				onCopy={copyFromPage}
				onMenu={() => setDrawer(true)}
			/>
			<TabStrip tabs={tabs} activeId={effectiveId} creating={creating} onSelect={setActiveId} onClose={closeTab} onNew={() => void openTab()} />
			<PortsRow ports={ports.data} onOpen={navigateTo} className="border-b bg-surface-1" />
			<div className="relative min-h-0 flex-1">
				<BrowserViewer
					conn={conn}
					state={snapshot.state}
					viewport={snapshot.viewport}
					device={device}
					onViewerSize={onViewerSize}
					onFocusAddress={() => addressRef.current?.focus()}
					onRetry={() => void qc.invalidateQueries({ queryKey: bk.all })}
					className="absolute inset-0"
				/>
				{blank ? <StartPage ports={ports.data} onOpen={navigateTo} /> : null}
				{debug ? <DebugOverlay /> : null}
			</div>
			{compact ? (
				<Sheet open={consoleOpen} onOpenChange={setConsoleOpen}>
					<SheetContent side="bottom" aria-describedby={undefined} className="h-[60dvh]">
						<SwipeZone onDismiss={() => setConsoleOpen(false)} />
						<SheetTitle className="sr-only">{t("Console")}</SheetTitle>
						{devtools}
					</SheetContent>
				</Sheet>
			) : consoleOpen ? (
				devtools
			) : null}
			<PageDialog dialog={snapshot.dialog} onAnswer={(accept, promptText) => conn?.send({ type: "dialog", accept, ...(promptText !== undefined ? { promptText } : {}) })} />
			<FileChooserDialog chooser={snapshot.fileChooser} answer={(uploadId) => conn?.send({ type: "file-chooser-done", ...(uploadId ? { uploadId } : {}) })} />
		</div>
	);
}
