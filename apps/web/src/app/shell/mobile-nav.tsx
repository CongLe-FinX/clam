import { Link, useRouterState } from "@tanstack/react-router";
import { LayoutDashboard, Layers, ListChecks, Menu, MessageSquarePlus, MessagesSquare, Settings, Command } from "lucide-react";
import { taskNeedsAttention, useTasks } from "@/lib/queries";
import { t, msg, tr, type Msg } from "@/i18n";
import { useUi } from "@/lib/store";
import { Button } from "@/ui/button";
import { Logo, ThemeToggle } from "./sidebar.tsx";

const titles: Record<string, Msg> = {
	"": msg("Overview"),
	workspaces: msg("Workspaces"),
	projects: msg("Project"),
	node: msg("My Machine"),
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
	const seg = useRouterState({ select: (s) => s.location.pathname.split("/")[1] ?? "" });
	return (
		<header className="flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 border-b bg-surface-1 px-2 pt-safe coarse:h-[calc(3.5rem+env(safe-area-inset-top))]">
			<Button variant="ghost" size="icon" aria-label={t("Open navigation")} onClick={() => setDrawer(true)}>
				<Menu />
			</Button>
			<Logo className="size-6" />
			<span className="flex-1 truncate pl-1 text-sm font-semibold tracking-tight">{seg in titles ? tr(titles[seg]!) : "CL Agent Mesh"}</span>
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
	{ to: "/tasks", label: msg("Tasks"), icon: ListChecks },
	{ to: "/settings", label: msg("Settings"), icon: Settings },
] as const;

export function MobileTabBar() {
	const attention = (useTasks().data ?? []).some(taskNeedsAttention);
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
					<Icon className="size-5 transition-transform duration-200 ease-[var(--ease-spring)] group-active:scale-90" />
					<span className="max-w-full truncate text-center">{tr(label)}</span>
					{to === "/tasks" && attention ? <span aria-label={t("Needs attention")} className="absolute right-[calc(50%-1.4rem)] top-2.5 size-2 rounded-full bg-accent" /> : null}
				</Link>
			))}
		</nav>
	);
}
