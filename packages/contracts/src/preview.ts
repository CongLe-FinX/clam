import { z } from "zod";
import { I18nText } from "./common.ts";

/**
 * Preview: open a web app that listens on THIS machine's localhost:<port> in the owner's OWN browser, through ONE preview
 * hostname per machine (default `<first label>-preview.<rest>` of the named tunnel's hostname, e.g. `clamp-work-preview.example.com`).
 *
 * - Needs a named tunnel (a stable hostname) and ONE explicit public hostname in Cloudflare: the preview host → the network listener.
 * - Routing on the preview host: `/__clam_preview/*` is CLAM's (auth, health, port picker, never proxied); `/port/<port>/<rest>` selects
 *   the app (sets the `__Host-clam_preview_port` cookie and redirects to `/<rest>`); every other path goes to the selected port.
 *   One active port per browser at a time.
 * - Off through the domain until `AccessStatus.remotePreviewEnabled` (and remote UI) is on. On the loopback UI nothing is needed:
 *   open `http://localhost:<port>` directly.
 * - The owner's UI session cookie never reaches the preview host (a different origin); the preview host has its own host-only cookie,
 *   minted from a one-time ticket (`routes.previewTicket`).
 */

/** Path prefix on the preview host that is served by CLAM itself and never proxied to the app. */
export const PREVIEW_RESERVED_PREFIX = "/__clam_preview/";
/** `/port/<port>/<rest>` on the preview host selects the previewed app. */
export const PREVIEW_PORT_PATH = "/port/";
/** A preview ticket is valid for this long, once. */
export const PREVIEW_TICKET_SECONDS = 60;

export const PreviewUnavailableReason = z.enum(["no_named_tunnel", "hostname_too_short", "bad_host"]);
export type PreviewUnavailableReason = z.infer<typeof PreviewUnavailableReason>;

export const PreviewStatus = z.object({
	/** A preview host can be addressed: a named tunnel with a hostname and a valid preview host. */
	available: z.boolean(),
	/** Why not (`no_named_tunnel`: quick/off; `hostname_too_short`: nothing to derive a preview host from; `bad_host`: the saved preview host no longer fits the tunnel hostname). */
	unavailableReason: PreviewUnavailableReason.nullable(),
	/** The named tunnel's hostname, when there is one. */
	hostname: z.string().nullable(),
	/** The effective preview host (`clamp-work-preview.example.com`), null when unavailable. */
	host: z.string().nullable(),
	/** What the host is derived to when none is saved. */
	defaultHost: z.string().nullable(),
	/** A host was saved (differs from the derived default). */
	customHost: z.boolean(),
	/** The preview host shares its parent domain with the tunnel hostname, so Cloudflare Universal SSL (`*.example.com`) already covers its certificate. */
	universalSsl: z.boolean(),
	/** Remote UI AND `remotePreviewEnabled` are on: a remote session may open previews. */
	remoteEnabled: z.boolean(),
});
export type PreviewStatus = z.infer<typeof PreviewStatus>;

/** `null` clears the saved host (back to the derived default). Loopback UI only. */
export const UpdatePreviewConfigBody = z.object({ host: z.string().trim().min(1).max(253).nullable() });

export const PreviewCheckResult = z.object({
	ok: z.boolean(),
	/** The host that was probed. */
	host: z.string(),
	reason: z.enum(["ok", "unreachable", "not_this_node"]),
	message: z.string(),
	i18n: I18nText.optional(),
});
export type PreviewCheckResult = z.infer<typeof PreviewCheckResult>;

export const PreviewTicketBody = z.object({
	port: z.number().int().min(1).max(65535),
	/** Where to land inside the app (default `/`): a path with optional query, never another origin. */
	path: z.string().max(2048).optional(),
});
export type PreviewTicketBody = z.infer<typeof PreviewTicketBody>;

export const PreviewTicket = z.object({
	/** `https://<preview host>/__clam_preview/auth?ticket=…`: open it in a new tab within `PREVIEW_TICKET_SECONDS`; it works once and lands on `/port/<port>/<path>`. */
	url: z.string(),
	expiresAt: z.string(),
});
export type PreviewTicket = z.infer<typeof PreviewTicket>;
