import { useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { Toaster } from "sonner";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { useRealtimeBridge } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { useResolvedTheme } from "@/lib/theme";
import { ws } from "@/lib/ws";
import { TooltipProvider } from "@/ui/tooltip";
import { MobileTabBar, MobileTopBar } from "./mobile-nav.tsx";
import { Sidebar } from "./sidebar.tsx";

const CommandPalette = lazy(() => import("../palette/command-palette.tsx"));
const GlobalDialogs = lazy(() => import("../dialogs/global-dialogs.tsx"));
const preloadDrawer = () => import("./mobile-drawer.tsx");
const MobileDrawer = lazy(preloadDrawer);

export function AppShell() {
	const bp = useBreakpoint();
	const theme = useResolvedTheme();
	const paletteOpen = useUi((s) => s.paletteOpen);
	const dialog = useUi((s) => s.dialog);
	const setPaletteOpen = useUi((s) => s.setPaletteOpen);
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const section = pathname.split("/")[1] ?? "";
	// Sessions and a single task are full-screen on mobile (their own header, composer pinned to the bottom).
	const inSession = section === "sessions" || (section === "tasks" && Boolean(pathname.split("/")[2]));
	const navigate = useNavigate();

	const qc = useQueryClient();
	useRealtimeBridge();
	useEffect(() => {
		const stops: Array<() => void> = [];
		let cancelled = false;
		void Promise.all([import("@/features/tasks/realtime"), import("@/features/shared/realtime")]).then(([t, s]) => {
			if (cancelled) return;
			stops.push(
				t.startTaskBridge(qc, (taskId) => void navigate({ to: "/tasks/$taskId", params: { taskId } })),
				s.startSharedBridge(qc, () => void navigate({ to: "/shared" })),
			);
		});
		return () => {
			cancelled = true;
			for (const stop of stops) stop();
		};
	}, [qc, navigate]);
	useEffect(() => ws.start(), []);

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
		<TooltipProvider>
			<div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
				{mobile ? null : <Sidebar mode={bp === "desktop" ? "full" : "rail"} />}
				<div className="flex min-w-0 flex-1 flex-col">
					{mobile && !inSession ? <MobileTopBar /> : null}
					<main id="main" className="relative min-h-0 flex-1 overflow-hidden px-safe">
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
			<Toaster
				theme={theme}
				position={mobile ? "top-center" : "bottom-right"}
				offset={mobile ? 12 : 16}
				toastOptions={{ classNames: { toast: "!rounded-xl !border-border-strong !bg-overlay !text-foreground !shadow-pop !text-[13px]" } }}
			/>
		</TooltipProvider>
	);
}
