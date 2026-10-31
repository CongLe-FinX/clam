import { API_PREFIX } from "./signing.ts";

/**
 * Peer URL policy (docs/security.md): peers are reached over `https://` only. Plain `http://` to
 * loopback (`127.0.0.1`, `localhost`, `[::1]`) is accepted solely when the caller opts in
 * (`CLAM_ALLOW_LOOPBACK_PEERS=1`, for development and tests — insecure).
 */
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

/**
 * The peer's origin (`https://host[:port]`) if `url` is an acceptable peer base URL, else null.
 * Accepts the bare origin or one ending in `/api/v1`; rejects credentials, queries and fragments.
 */
export function normalizePeerUrl(url: string, options: { allowLoopbackHttp: boolean }): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return null;
	if (parsed.pathname !== "/" && parsed.pathname !== API_PREFIX && parsed.pathname !== `${API_PREFIX}/`) return null;
	if (parsed.protocol === "https:") return parsed.origin;
	if (parsed.protocol === "http:" && options.allowLoopbackHttp && LOOPBACK_HOSTS.includes(parsed.hostname)) return parsed.origin;
	return null;
}

export function isAllowedPeerUrl(url: string, options: { allowLoopbackHttp: boolean }): boolean {
	return normalizePeerUrl(url, options) !== null;
}

/** True when every capability in `needed` is present in `granted`. */
export function hasCapabilities(granted: readonly string[], needed: readonly string[]): boolean {
	return needed.every((capability) => granted.includes(capability));
}
