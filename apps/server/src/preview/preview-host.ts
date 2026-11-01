import { PREVIEW_PORT_PATH } from "@clam/contracts";
import { hostnameOf } from "../http/host-guard.ts";

/**
 * The preview host and the preview URL scheme, in one module: which `Host` is the preview host, and how a path on it names a port.
 * Everything that decides "is this a preview request, for which port" goes through here (and `PreviewService.resolve`).
 */

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOST = 253;

export type HostError = "syntax" | "tunnel";

/** `<first label>-preview.<rest>` (e.g. `clamp-work-preview.example.com`); `preview.<hostname>` for a two-label hostname; null for a bare name. */
export function deriveDefaultHost(tunnelHostname: string): string | null {
	const labels = tunnelHostname.trim().toLowerCase().split(".");
	if (labels.length < 2 || labels.some((l) => l === "")) return null;
	if (labels.length === 2) return `preview.${labels.join(".")}`;
	return `${labels[0]}-preview.${labels.slice(1).join(".")}`;
}

/** A preview host must be a plain hostname (at least two labels), and never the tunnel's own hostname (that one serves the UI and the wire API). */
export function parsePreviewHost(input: string, tunnelHostname?: string | null): { ok: true; host: string } | { ok: false; error: HostError } {
	const host = input.trim().toLowerCase();
	const labels = host.split(".");
	if (host.length > MAX_HOST || labels.length < 2 || !labels.every((l) => LABEL.test(l))) return { ok: false, error: "syntax" };
	if (tunnelHostname && host === tunnelHostname.toLowerCase()) return { ok: false, error: "tunnel" };
	return { ok: true, host };
}

/** Is `hostHeader` (any `:port` suffix ignored) exactly the preview host? Returns the hostname, else null. */
export function matchPreviewHost(previewHost: string, hostHeader: string | undefined): string | null {
	if (!hostHeader) return null;
	const hostname = hostnameOf(hostHeader);
	return hostname === previewHost ? hostname : null;
}

const PORT_PATH = new RegExp(`^${PREVIEW_PORT_PATH}([1-9][0-9]{0,4})(?=/|$)(/.*)?$`, "s");

/** `/port/5173/x/y` → `{ port: 5173, rest: "/x/y" }`; `/port/5173` → rest `/`. Anything else (including `/port/abc`: that is the app's own route) → null. */
export function parsePortPath(pathname: string): { port: number; rest: string } | null {
	const match = PORT_PATH.exec(pathname);
	if (!match) return null;
	const port = Number(match[1]);
	if (port > 65535) return null;
	return { port, rest: match[2] ?? "/" };
}

/** The landing path a ticket carries: `/port/<port><path>` (path starts with `/`). */
export const landingPath = (port: number, path: string): string => `${PREVIEW_PORT_PATH}${port}${path}`;
