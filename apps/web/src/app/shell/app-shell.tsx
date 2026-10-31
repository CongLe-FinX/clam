import { useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { isAwaitingApproval, useRealtimeBridge, usePairingRequests } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { lazyPreload } from "@/lib/lazy-preload";
import { useUi } from "@/lib/store";
import { useResolvedTheme } from "@/lib/theme";
import { ws } from "@/lib/ws";
import { usePendingWatch } from "@/features/session/omp/pending-watch.ts";
import { preloadTooltips } from "@/ui/tooltip";
import { MobileTabBar, MobileTopBar } from "./mobile-nav.tsx";
import { Sidebar } from "./sidebar.tsx";

const { Component: CommandPalette, preload: loadPalette } = lazyPreload(() => import("../palette/command-palette.tsx"));
const { Component: GlobalDialogs, preload: loadDialogs } = lazyPreload(() => import("../dialogs/global-dialogs.tsx"));
const AppToaster = lazy(() => import("./toaster.tsx"));
const PairingBanner = lazy(() => import("./pairing-banner.tsx"));
const { Component: MobileDrawer, preload: preloadDrawer } = lazyPreload(() => import("./mobile-drawer.tsx"));

export function AppShell() {
	const bp = useBreakpoint();
	const theme = useResolvedTheme();
	const paletteOpen = useUi((s) => s.paletteOpen);
	const dialog = useUi((s) => s.dialog);
	const setPaletteOpen = useUi((s) => s.setPaletteOpen);
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const section = pathname.split("/")[1] ?? "";
	// Sessions, the Terminal, the Browser, a single task and a single handoff are full-screen on mobile (their own header).
	const inSession = section === "sessions" || section === "terminal" || section === "browser" || ((section === "tasks" || section === "handoffs") && Boolean(pathname.split("/")[2]));
	const navigate = useNavigate();

	const qc = useQueryClient();
	const waiting = (usePairingRequests().data ?? []).some(isAwaitingApproval);
	useRealtimeBridge();
	usePendingWatch();
	useEffect(() => {
		const stops: Array<() => void> = [];
		let cancelled = false;
		void Promise.all([import("@/features/tasks/realtime"), import("@/features/shared/realtime"), import("@/features/handoff/realtime")]).then(([t, s, h]) => {
			if (cancelled) return;
			stops.push(
				t.startTaskBridge(qc, (taskId) => void navigate({ to: "/tasks/$taskId", params: { taskId } })),
				s.startSharedBridge(qc, () => void navigate({ to: "/shared" })),
				h.startHandoffBridge(qc, (handoffId) => void navigate({ to: "/handoffs/$handoffId", params: { handoffId } })),
			);
		});
		return () => {
			cancelled = true;
			for (const stop of stops) stop();
		};
	}, [qc, navigate]);
	useEffect(() => ws.start(), []);

	// Once the shell has painted and the main thread is idle, warm everything the first interactions need (palette, dialogs, tooltips).
	useEffect(() => {
		const idle = (cb: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 1200));
		const handle = idle(() => {
			void loadPalette();
			void loadDialogs().then(() => import("../dialogs/global-dialogs.tsx")).then((m) => m.preloadDialogBodies());
			preloadTooltips();
			void import("@/features/chats/chats-page.tsx");
			void import("@/features/tasks/board-page.tsx");
		});
		return () => ("cancelIdleCallback" in window ? cancelIdleCallback(handle as number) : clearTimeout(handle));
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setPaletteOpen(!useUi.getState().paletteOpen);
			}
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, [setPaletteOpen]);

	const mobile = bp === "mobile";
	// The drawer's dialog stack is a lazy chunk: warmed up once we know we are on mobile, mounted on first open, kept mounted so it can animate out.
	const drawerOpen = useUi((s) => s.drawerOpen);
	const [drawerMounted, setDrawerMounted] = useState(false);
	useEffect(() => {
		if (!mobile) return;
		void preloadDrawer();
	}, [mobile]);
	useEffect(() => {
		if (drawerOpen) setDrawerMounted(true);
	}, [drawerOpen]);

	return (
		<>
			<div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
				{mobile ? null : <Sidebar mode={bp === "desktop" ? "full" : "rail"} />}
				<div className="flex min-w-0 flex-1 flex-col">
					{mobile && !inSession ? <MobileTopBar /> : null}
					<main id="main" className={cn("relative min-h-0 flex-1 overflow-hidden", mobile ? "px-safe" : "pr-[env(safe-area-inset-right)]")}>
						{/* Re-keyed per top-level section: cheap opacity/translate entrance, no layout animation. */}
						<div key={section} className="h-full animate-slide-up">
							<Outlet />
						</div>
					</main>
					{mobile && !inSession ? <MobileTabBar /> : null}
				</div>
			</div>
			{mobile && drawerMounted ? (
				<Suspense fallback={null}>
					<MobileDrawer />
				</Suspense>
			) : null}
			<Suspense fallback={null}>{paletteOpen ? <CommandPalette /> : null}</Suspense>
			<Suspense fallback={null}>{dialog ? <GlobalDialogs /> : null}</Suspense>
			<Suspense fallback={null}>{waiting && !dialog ? <PairingBanner /> : null}</Suspense>
			<Suspense fallback={null}>
				<AppToaster theme={theme} mobile={mobile} />
			</Suspense>
		</>
	);
}
