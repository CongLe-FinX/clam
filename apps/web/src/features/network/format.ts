import type { PeerStatus } from "@clam/contracts";
import type { DotStatus } from "@/ui/status-dot";

/** Groups a fingerprint in blocks of 4 so two people can read it aloud and compare it. The raw value is what is copied. */
export function formatFingerprint(fp: string): string {
	if (/[\s:-]/.test(fp)) return fp;
	return fp.replace(/(.{4})(?=.)/g, "$1 ");
}

/** `ABCD1234` → `ABCD-1234`. Anything the user types is normalised to this shape. */
export function formatInvitationCode(raw: string): string {
	const clean = raw.replace(/[^a-z0-9]/gi, "").toUpperCase();
	return clean.replace(/(.{4})(?=.)/g, "$1-");
}

export const PEER_DOT: Record<PeerStatus, DotStatus> = { online: "online", degraded: "degraded", offline: "offline", revoked: "crashed" };
export const PEER_STATUS_LABEL: Record<PeerStatus, string> = { online: "Online", degraded: "Degraded", offline: "Offline", revoked: "Revoked" };
export const PEER_STATUS_VARIANT = { online: "success", degraded: "warning", offline: "neutral", revoked: "danger" } as const satisfies Record<PeerStatus, string>;

export function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** Directory entries are refreshed on `agents_changed` and at most every 5 min; older than 10 min means the peer stopped answering. */
export const STALE_AFTER_MS = 10 * 60_000;
export const isStale = (fetchedAt: string, now = Date.now()): boolean => now - Date.parse(fetchedAt) > STALE_AFTER_MS;

/** The text a user pastes into chat to hand an invitation to someone. */
export function invitationMessage(i: { url: string | null; fingerprint: string; code: string; expiresAt: string }): string {
	return [
		"Join my CL Agent Mesh machine:",
		i.url ? `URL: ${i.url}` : "URL: (this machine has no public URL yet)",
		`Fingerprint: ${formatFingerprint(i.fingerprint)}`,
		`Code: ${formatInvitationCode(i.code)}`,
		`Expires: ${new Date(i.expiresAt).toLocaleTimeString()}`,
		"Compare the fingerprint with the one CL Agent Mesh shows you before you enter the code.",
	].join("\n");
}
