import { useRouterState } from "@tanstack/react-router";
import { ShieldQuestion } from "lucide-react";
import { isAwaitingApproval, usePairingRequests } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { Button } from "@/ui/button";
import { t } from "@/i18n";

/** App-wide card shown while a machine waits for approval, so a request is never missed outside the invite dialog. */
export default function PairingBanner() {
	const requests = (usePairingRequests().data ?? []).filter(isAwaitingApproval);
	const openDialog = useUi((s) => s.openDialog);
	const onNodes = useRouterState({ select: (r) => r.location.pathname.startsWith("/network/nodes") });
	const first = requests[0];
	// The Connected machines page already shows the request as a full card.
	if (!first || onNodes) return null;
	return (
		<div role="alert" className="pointer-events-none fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 flex justify-center sm:inset-x-auto sm:bottom-[max(1rem,env(safe-area-inset-bottom))] sm:right-[max(1rem,env(safe-area-inset-right))] sm:justify-end">
			<div className="pointer-events-auto flex w-full max-w-sm animate-slide-up items-center gap-3 rounded-2xl bg-overlay p-3 shadow-pop shadow-[inset_0_0_0_1.5px_var(--accent)]">
				<span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
					<ShieldQuestion className="size-5" />
				</span>
				<span className="flex min-w-0 flex-1 flex-col text-[13px]">
					<strong className="truncate font-semibold">{t("{name} wants to connect", { name: first.remote.name })}</strong>
					<span className="text-xs text-muted-foreground">
						{requests.length > 1 ? t("{count} requests need your approval", { count: requests.length }) : t("Needs your approval")}
					</span>
				</span>
				<Button size="sm" variant="primary" onClick={() => openDialog({ kind: "pairing-requests" })}>
					{t("Review")}
				</Button>
			</div>
		</div>
	);
}
