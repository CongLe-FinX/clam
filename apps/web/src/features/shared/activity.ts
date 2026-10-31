import type { Participant, SharedSession } from "@clam/contracts";
import { useRef } from "react";
import { useAgents, useDirectory, useRuntime } from "@/lib/queries";
import { teamOf } from "./format.ts";
import { hueOf } from "./identity.tsx";

export interface WorkingAgent {
	key: string;
	label: string;
	hue: number;
}

/**
 * Agents of the group that are working right now.
 *  - this machine's agent: the runtime state of its own session (live over the `runtime` topic); when its session is not known yet, the agent's status;
 *  - a remote agent: its status in the agent directory (the last report of that machine; refreshed on `directory_changed`, so it can lag behind).
 * The group protocol carries no per-turn "typing" frames, so this is "the agent is busy", not "the agent is writing into this chat".
 */
export function useWorkingAgents(shared: SharedSession): WorkingAgent[] {
	const runtime = useRuntime().data;
	const agents = useAgents().data;
	const directory = useDirectory().data;
	const last = useRef<{ sig: string; list: WorkingAgent[] }>({ sig: "", list: [] });

	const busy = (p: Participant): boolean => {
		if (p.nodeStatus === "offline" || p.nodeStatus === "revoked") return false;
		if (p.nodeStatus === "self") {
			const sessionId = p.agentSessionId ?? (shared.localRole === "driver" ? shared.localSessionId : null);
			if (sessionId) return runtime?.find((r) => r.sessionId === sessionId)?.state === "busy";
			return agents?.find((a) => a.id === p.agentId)?.status === "busy";
		}
		return directory?.find((d) => d.nodeId === p.nodeId && d.agentId === p.agentId)?.status === "busy";
	};

	const working = teamOf(shared).filter((p) => p.agentId !== null && p.state === "active" && busy(p));
	const sig = working.map((p) => `${p.nodeId}:${p.agentId}`).join("|");
	if (sig !== last.current.sig) {
		last.current = { sig, list: working.map((p) => ({ key: `${p.nodeId}:${p.agentId}`, label: p.agentName ? `${p.agentName}@${p.nodeName}` : p.nodeName, hue: hueOf(p.nodeId, p.agentId) })) };
	}
	return last.current.list;
}
