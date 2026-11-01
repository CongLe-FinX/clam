import type { Checkpoint, Participant, SharedSession } from "@clam/contracts";
import { type Msg, msg, t } from "@/i18n";
import { PEER_DOT } from "@/features/network/format";
import { formatDate, formatTime } from "@/lib/utils";
import type { DotStatus } from "@/ui/status-dot";

export type NodeStatus = Participant["nodeStatus"];

export const NODE_STATUS_LABEL: Record<NodeStatus, Msg> = { self: msg("This machine"), online: msg("Online"), degraded: msg("Degraded"), offline: msg("Offline"), revoked: msg("Revoked") };

export function nodeDot(status: NodeStatus): DotStatus {
	return status === "self" ? "online" : PEER_DOT[status];
}

export const ROLE_LABEL: Record<SharedSession["localRole"], Msg> = { driver: msg("Driver"), participant: msg("Participant"), former_driver: msg("Moved away") };
export const PARTICIPANT_STATE_LABEL: Record<Participant["state"], Msg> = { invited: msg("Invited"), active: msg("Active"), declined: msg("Declined"), left: msg("Left"), removed: msg("Removed") };

/** `agent@node`, or just the machine when the participant has no agent yet. */
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

/** Wall-clock time of a message, `14:05`. */
export const clockTime = (ms: number): string => formatTime(ms, { hour: "2-digit", minute: "2-digit" });

/** One local calendar day as a comparable key. */
export const dayKey = (ms: number): string => new Date(ms).toDateString();

/** Divider text for a day: Today, Yesterday, the weekday inside the last week, else the date. */
export function dayLabel(ms: number, now = Date.now()): string {
	const a = new Date(ms);
	const b = new Date(now);
	const days = Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime() - new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()) / 86_400_000);
	if (days === 0) return t("Today");
	if (days === 1) return t("Yesterday");
	if (days > 1 && days < 7) return formatDate(a, { weekday: "long", month: "short", day: "numeric" });
	return a.getFullYear() === b.getFullYear() ? formatDate(a, { month: "short", day: "numeric" }) : formatDate(a, { year: "numeric", month: "short", day: "numeric" });
}
