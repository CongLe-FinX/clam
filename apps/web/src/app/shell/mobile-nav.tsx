import { Link, useRouterState } from "@tanstack/react-router";
import { Command, Cpu, LayoutDashboard, Layers, Menu, MessageSquarePlus, MessagesSquare, Settings } from "lucide-react";
import { taskNeedsAttention, useRuntime, useTasks } from "@/lib/queries";
import { t, msg, tr, type Msg } from "@/i18n";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Logo, ThemeToggle } from "./sidebar.tsx";

/** Top bar title by the first path segment, or by the first two where a sub-page has its own name. */
const titles: Record<string, Msg> = {
	"": msg("Overview"),
	workspaces: msg("Workspaces"),
	projects: msg("Project"),
	node: msg("My Machine"),
	"node/runtime": msg("Runtime"),
	"node/system": msg("System"),
	network: msg("Agent Network"),
	settings: msg("Settings"),
	tasks: msg("Tasks"),
	shared: msg("Shared sessions"),
	handoffs: msg("Handoffs"),
	chats: msg("Chats"),
	terminal: msg("Terminal"),
	browser: msg("Browser"),
};

export function MobileTopBar() {
	const setDrawer = useUi((s) => s.setDrawerOpen);
	const setPalette = useUi((s) => s.setPaletteOpen);
	const openDialog = useUi((s) => s.openDialog);
	const [seg = "", sub] = useRouterState({ select: (s) => s.location.pathname }).split("/").slice(1);
	const title = titles[`${seg}/${sub}`] ?? titles[seg];
	// Tasks live in the drawer on phones (the tab bar shows what is running instead): a task waiting for you marks the menu button.
	const attention = (useTasks().data ?? []).some(taskNeedsAttention);
	return (
		<header className="flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 border-b bg-surface-1 px-2 pt-safe coarse:h-[calc(3.5rem+env(safe-area-inset-top))]">
			<Button variant="ghost" size="icon" aria-label={attention ? t("Open navigation · a task needs attention") : t("Open navigation")} onClick={() => setDrawer(true)} className="relative">
				<Menu />
				{attention ? <span aria-hidden className="absolute right-2 top-2 size-2 rounded-full bg-accent ring-2 ring-surface-1" /> : null}
			</Button>
			<Logo className="size-6" />
			<span className="flex-1 truncate pl-1 text-sm font-semibold tracking-tight">{title ? tr(title) : "CL Agent Mesh"}</span>
			<Button variant="soft" size="icon" aria-label={t("New chat")} onClick={() => openDialog({ kind: "new-chat" })}>
				<MessageSquarePlus />
			</Button>
			<Button variant="ghost" size="icon" aria-label={t("Command palette")} onClick={() => setPalette(true)}>
				<Command />
			</Button>
			<ThemeToggle />
		</header>
	);
}

const tabs = [
	{ to: "/", label: msg("Overview"), icon: LayoutDashboard, exact: true },
	{ to: "/workspaces", label: msg("Workspaces"), icon: Layers },
	{ to: "/chats", label: msg("Chats"), icon: MessagesSquare },
	{ to: "/node/runtime", label: msg("Runtime"), icon: Cpu },
	{ to: "/settings", label: msg("Settings"), icon: Settings },
] as const;

export function MobileTabBar() {
	// The Runtime tab counts the sessions whose agent is up (the sidebar's "Running" list); the count pulses while one of them is working.
	const live = (useRuntime().data ?? []).filter((r) => r.state !== "stopped");
	const busy = live.some((r) => r.state === "busy" && r.background !== true);
	return (
		<nav aria-label={t("Tabs")} className="grid shrink-0 grid-cols-5 border-t bg-surface-1/95 pb-safe backdrop-blur">
			{tabs.map(({ to, label, icon: Icon, ...rest }) => (
				<Link
					key={to}
					to={to}
					activeOptions={{ exact: "exact" in rest }}
					preload="intent"
					className="group relative flex h-14 min-w-0 flex-col items-center justify-center gap-0.5 px-0.5 text-2xs font-medium text-subtle outline-none transition-colors data-[status=active]:text-accent"
				>
					<span className="relative">
						<Icon className="size-5 transition-transform duration-200 ease-[var(--ease-spring)] group-active:scale-90" />
						{to === "/node/runtime" && live.length > 0 ? (
							<span
								aria-label={t("{count, plural, one {# session running} other {# sessions running}}", { count: live.length })}
								className={cn(
									"tabular absolute -right-2.5 -top-1.5 grid h-4 min-w-4 animate-fade-in place-items-center rounded-full px-1 text-[10px] font-semibold leading-none ring-2 ring-surface-1",
									busy ? "bg-accent text-accent-foreground" : "bg-success text-white",
								)}
							>
								{busy ? <span aria-hidden className="absolute inset-0 animate-[clam-pulse-ring_2.2s_ease-out_infinite] rounded-full bg-accent" /> : null}
								<span className="relative">{live.length}</span>
							</span>
						) : null}
					</span>
					<span className="max-w-full truncate text-center">{tr(label)}</span>
				</Link>
			))}
		</nav>
	);
}
