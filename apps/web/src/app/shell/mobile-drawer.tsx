import { Link as RouterLink } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/ui/sheet";
import { t } from "@/i18n";
import { NodeStatusCard } from "./node-status.tsx";
import { Logo, NavTree, rowClass } from "./sidebar.tsx";

/** Mobile navigation drawer. Lazy: the dialog stack it needs stays out of the initial bundle. */
export default function MobileDrawer() {
	const open = useUi((s) => s.drawerOpen);
	const setOpen = useUi((s) => s.setDrawerOpen);
	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetContent side="left" aria-describedby={undefined} className={cn("w-[min(88vw,340px)]")}>
				<div className="flex items-center gap-2 px-4 pb-3 pt-3">
					<Logo />
					<SheetTitle className="text-[13px]">CL Agent Mesh</SheetTitle>
					<SheetDescription className="sr-only">{t("Primary navigation")}</SheetDescription>
				</div>
				<div className="px-3 pb-2">
					<NodeStatusCard />
				</div>
				<div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain">
					<NavTree onNavigate={() => setOpen(false)} />
				</div>
				<div className="border-t p-2">
					<RouterLink to="/settings" className={rowClass} onClick={() => setOpen(false)}>
						<Settings />
						<span>{t("Settings")}</span>
					</RouterLink>
				</div>
			</SheetContent>
		</Sheet>
	);
}
