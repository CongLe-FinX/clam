import type { SharedTopicEvent } from "@clam/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { qk } from "@/lib/queries";
import { ws } from "@/lib/ws";
import { applySharedEvent } from "./hooks.ts";

const inviteToasted: Record<string, true> = {};

/**
 * Keeps the shared-session list and the invite inbox current from the `shared` topic and announces incoming invites. Loaded on
 * demand by the app shell so none of this sits in the initial bundle.
 */
export function startSharedBridge(qc: QueryClient, openInvites: () => void): () => void {
	return ws.subscribe(
		"shared",
		(raw) => {
			const e = raw as SharedTopicEvent;
			applySharedEvent(qc, e);
			if (e.type !== "invite") return;
			const i = e.invite;
			if (i.state === "pending") {
				// One notice per invite (the invite frame can repeat); none while the inbox itself is on screen.
				if (inviteToasted[i.id] || location.pathname === "/shared") return;
				inviteToasted[i.id] = true;
				toast(`${i.from.agentName ? `${i.from.agentName}@` : ""}${i.from.nodeName} invites you to a shared session`, {
					id: `shared-invite-${i.id}`,
					description: i.title,
					duration: 20_000,
					action: { label: "Review", onClick: openInvites },
				});
			} else {
				toast.dismiss(`shared-invite-${i.id}`);
			}
		},
		() => {
			void qc.invalidateQueries({ queryKey: qk.shared });
			void qc.invalidateQueries({ queryKey: qk.sharedInvites });
		},
	);
}
