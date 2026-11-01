import type { PeerStatus, Task, TaskParty, TaskStatus } from "@clam/contracts";
import { ArrowDownLeft, ArrowUpRight, Bot, Check, Clock, TriangleAlert } from "lucide-react";
import { msg, t, tr } from "@/i18n";
import { PEER_DOT, PEER_STATUS_LABEL } from "@/features/network/format";
import { useNode, usePeers } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { StatusDot } from "@/ui/status-dot";
import { STATUS_META } from "./format.ts";

export function TaskStatusPill({ status, className }: { status: TaskStatus; className?: string }) {
	const m = STATUS_META[status];
	const Icon = m.icon;
	return (
		<Badge variant={m.variant} className={cn("gap-1", className)}>
			<Icon className={cn(m.spin && "animate-spin")} aria-hidden />
			{tr(m.label)}
		</Badge>
	);
}

export function DirectionChip({ direction }: { direction: Task["direction"] }) {
	const Icon = direction === "incoming" ? ArrowDownLeft : ArrowUpRight;
	return (
		<Badge variant="outline" className="gap-1">
			<Icon aria-hidden />
			{direction === "incoming" ? t("Incoming") : t("Outgoing")}
		</Badge>
	);
}

/** Connection status of a machine as this machine sees it (`self` for the local node). */
export function useNodeStatus(nodeId: string): PeerStatus | "self" | "unknown" {
	const self = useNode().data?.id;
	const peers = usePeers().data;
	if (nodeId === self) return "self";
	return peers?.find((p) => p.id === nodeId)?.status ?? "unknown";
}

export function NodeDot({ nodeId, className }: { nodeId: string; className?: string }) {
	const status = useNodeStatus(nodeId);
	const dot = status === "self" ? "online" : status === "unknown" ? "offline" : PEER_DOT[status];
	const label = status === "self" ? t("This machine") : status === "unknown" ? t("Status unknown") : tr(PEER_STATUS_LABEL[status]);
	return <StatusDot status={dot} label={label} className={className} />;
}

/** `Agent@Node` with the machine's status dot. */
export function PartyChip({ party, mine, role = "executor", className }: { party: TaskParty; mine?: boolean; /** A sender without an agent is a person who delegated from the UI; an executor without one is "any agent". */ role?: "sender" | "executor"; className?: string }) {
	return (
		<span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
			<NodeDot nodeId={party.nodeId} />
			<Bot className="size-3.5 shrink-0 text-subtle" aria-hidden />
			<span className="truncate">
				{party.agentName ? <span className="font-medium text-foreground">{party.agentName}</span> : <span className="italic text-subtle">{role === "sender" ? t("a person") : t("any agent")}</span>}
				<span className="text-muted-foreground">@{party.nodeName}</span>
			</span>
			{mine ? <span className="rounded bg-surface-3 px-1 text-2xs text-subtle">{t("this machine")}</span> : null}
		</span>
	);
}

/** Delivery of the task / of a message to the other machine (outbox state). */
export function DeliveryMark({ state, className }: { state: "local" | "pending" | "delivered" | "failed"; className?: string }) {
	if (state === "local") return null;
	const map = {
		pending: { icon: Clock, text: msg("Sending"), cls: "text-subtle" },
		delivered: { icon: Check, text: msg("Delivered"), cls: "text-success" },
		failed: { icon: TriangleAlert, text: msg("Failed — retrying"), cls: "text-danger" },
	} as const;
	const { icon: Icon, text, cls } = map[state];
	return (
		<span className={cn("inline-flex items-center gap-1 text-2xs", cls, className)}>
			<Icon className="size-3" aria-hidden />
			{tr(text)}
		</span>
	);
}
