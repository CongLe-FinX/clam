import type { Handoff, HandoffTopicEvent } from "@clam/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { t } from "@/i18n";
import { ws } from "@/lib/ws";
import { applyTopicEvent, hk } from "./api.ts";

const announced: Record<string, true> = {};

/** The user is already looking at this handoff: no toast needed. */
const onPage = (id: string): boolean => location.pathname === `/handoffs/${id}`;

function announce(h: Handoff, open: (id: string) => void): void {
	if (h.role !== "target") return;
	const offerId = `handoff-offer-${h.id}`;
	if (h.state === "received") {
		if (!announced[offerId] && !onPage(h.id)) {
			announced[offerId] = true;
			toast(t("{name} wants to hand off “{title}”", { name: h.source.nodeName, title: h.title }), {
				id: offerId,
				description: t("Review it, then accept or reject."),
				duration: 30_000,
				action: { label: t("Review"), onClick: () => open(h.id) },
			});
		}
	} else {
		toast.dismiss(offerId);
	}

	const pending = h.setup.filter((c) => c.state === "pending_approval");
	const setupId = `handoff-setup-${h.id}`;
	// One notice per distinct set of waiting commands.
	const key = `${setupId}:${pending.map((c) => c.id).join(",")}`;
	if (pending.length > 0) {
		if (!announced[key] && !onPage(h.id)) {
			announced[key] = true;
			toast(t("{count, plural, one {A setup command needs your approval} other {# setup commands need your approval}}", { count: pending.length }), {
				id: setupId,
				description: t("Preparing “{title}” on this machine.", { title: h.title }),
				duration: 30_000,
				action: { label: t("Review"), onClick: () => open(h.id) },
			});
		}
	} else {
		toast.dismiss(setupId);
	}
}

/**
 * Keeps the handoff list current from the `handoffs` topic and announces incoming handoffs and setup approvals. Loaded on demand
 * by the app shell so none of this sits in the initial bundle.
 */
export function startHandoffBridge(qc: QueryClient, open: (handoffId: string) => void): () => void {
	return ws.subscribe(
		"handoffs",
		(raw) => {
			const e = raw as HandoffTopicEvent;
			applyTopicEvent(qc, e);
			if (e.type === "handoff") announce(e.handoff, open);
		},
		() => {
			void qc.invalidateQueries({ queryKey: hk.all });
			void qc.invalidateQueries({ queryKey: ["local", "handoff"] });
		},
	);
}
