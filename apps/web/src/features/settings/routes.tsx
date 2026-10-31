import { useEffect } from "react";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { MotionConfig, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { SETTINGS_BASE, SETTINGS_NAV } from "./nav";

const DESKTOP_QUERY = "(min-width: 768px)";

function useSettingsPath() {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const clean = pathname.replace(/\/+$/, "");
	const segment = clean.startsWith(`${SETTINGS_BASE}/`) ? clean.slice(SETTINGS_BASE.length + 1).split("/")[0]! : null;
	return { segment, isIndex: clean === SETTINGS_BASE };
}

/**
 * Two-column settings on ≥768 px; on phones `/settings` is a list and each page a detail view
 * that slides in (opacity + transform only).
 */
export function SettingsLayout() {
	const { segment, isIndex } = useSettingsPath();
	const navigate = useNavigate();

	useEffect(() => {
		if (isIndex && window.matchMedia(DESKTOP_QUERY).matches) {
			void navigate({ to: `${SETTINGS_BASE}/general` as never, replace: true });
		}
	}, [isIndex, navigate]);

	const current = SETTINGS_NAV.find((n) => n.path === segment);

	return (
		<MotionConfig reducedMotion="user">
			<div className="scrollbar-thin h-full overflow-y-auto overscroll-contain">
				<div className="mx-auto flex w-full max-w-[1280px] md:gap-8 md:px-6 md:py-7">
					{/* Navigation: persistent rail on desktop, full-screen list at /settings on mobile */}
					<nav aria-label="Settings sections" className={cn("shrink-0 md:block md:w-56 lg:w-64", isIndex ? "block w-full" : "hidden")}>
						<div className="md:sticky md:top-0">
							<h1 className="px-4 pb-2 pt-4 text-lg font-semibold tracking-tight md:px-2.5 md:pt-0">Settings</h1>
							<ul className="md:space-y-0.5">
								{SETTINGS_NAV.map((item) => {
									const Icon = item.icon;
									const active = item.path === segment;
									return (
										<li key={item.path}>
											<Link
												to={`${SETTINGS_BASE}/${item.path}` as never}
												preload="intent"
												aria-current={active ? "page" : undefined}
												className={cn(
													"group flex min-h-12 items-center gap-3 border-b border-border px-4 py-2.5 text-sm outline-none transition-colors",
													"focus-visible:ring-2 focus-visible:ring-ring md:min-h-0 md:rounded-lg md:border-0 md:px-2.5 md:py-2",
													active ? "bg-surface-2 font-medium text-foreground" : "text-muted-foreground hover:bg-surface-1 hover:text-foreground",
												)}
											>
												<Icon className={cn("size-4 shrink-0", active && "text-accent")} />
												<span className="min-w-0 flex-1">
													<span className="block truncate">{item.label}</span>
													<span className="block truncate text-xs font-normal text-subtle md:hidden">{item.description}</span>
												</span>
												<ChevronRight className="size-4 shrink-0 text-subtle md:hidden" />
											</Link>
										</li>
									);
								})}
							</ul>
						</div>
					</nav>

					<div className={cn("min-w-0 flex-1", isIndex && "hidden md:block")}>
						{current && (
							<Link
								to={SETTINGS_BASE as never}
								className="sticky top-0 z-10 flex min-h-11 items-center gap-1 border-b border-border bg-background/90 px-3 text-sm text-muted-foreground outline-none backdrop-blur hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:hidden"
							>
								<ChevronLeft className="size-4" />
								Settings
								<span className="mx-1 text-border-strong">/</span>
								<span className="font-medium text-foreground">{current.label}</span>
							</Link>
						)}
						<motion.div
							key={segment ?? "index"}
							initial={{ opacity: 0, x: 12 }}
							animate={{ opacity: 1, x: 0 }}
							transition={{ type: "spring", stiffness: 420, damping: 38, mass: 0.8 }}
						>
							<Outlet />
						</motion.div>
					</div>
				</div>
			</div>
		</MotionConfig>
	);
}
