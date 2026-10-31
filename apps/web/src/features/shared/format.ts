import type { Checkpoint, Participant, SharedSession } from "@clam/contracts";
import { PEER_DOT } from "@/features/network/format";
import type { DotStatus } from "@/ui/status-dot";

export type NodeStatus = Participant["nodeStatus"];

export const NODE_STATUS_LABEL: Record<NodeStatus, string> = { self: "This node", online: "Online", degraded: "Degraded", offline: "Offline", revoked: "Revoked" };

export function nodeDot(status: NodeStatus): DotStatus {
	return status === "self" ? "online" : PEER_DOT[status];
}

export const ROLE_LABEL: Record<SharedSession["localRole"], string> = { driver: "Driver", participant: "Participant", former_driver: "Moved away" };
export const PARTICIPANT_STATE_LABEL: Record<Participant["state"], string> = { invited: "Invited", active: "Active", declined: "Declined", left: "Left", removed: "Removed" };

/** `agent@node`, or just the node when the participant has no agent yet. */
export const participantLabel = (p: Pick<Participant, "agentName" | "nodeName">): string => (p.agentName ? `${p.agentName}@${p.nodeName}` : p.nodeName);

export const driverOf = (s: SharedSession): Participant | undefined => s.participants.find((p) => p.nodeId === s.driverNodeId);

/** Participants that still belong to the team. */
export const teamOf = (s: SharedSession): Participant[] => s.participants.filter((p) => p.state === "invited" || p.state === "active");

/** `https://github.com/o/r(.git)` → `https://github.com/o/r`, else null. */
function githubBase(url: string): string | null {
	const m = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(url.trim());
	return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}
export const commitUrl = (repoUrl: string, commit: string): string | null => {
	const base = githubBase(repoUrl);
	return base ? `${base}/commit/${commit}` : null;
};
export const branchUrl = (repoUrl: string, branch: string): string | null => {
	const base = githubBase(repoUrl);
	return base ? `${base}/tree/${branch.split("/").map(encodeURIComponent).join("/")}` : null;
};

/** `owner/name` of a GitHub URL with its original casing, else the URL itself. */
export function repoLabel(url: string): string {
	const m = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(url.trim());
	return m ? `${m[1]}/${m[2]}` : url;
}

/** Where a participant's own node serves its UI for a session (their domain), or the UI root when no session is known. */
export function remoteSessionUrl(uiUrl: string, sessionId: string | null): string {
	const base = uiUrl.replace(/\/+$/, "");
	return sessionId ? `${base}/sessions/${sessionId}` : base;
}

export const shortCommit = (c: string): string => c.slice(0, 7);
