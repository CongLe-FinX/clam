import { z } from "zod";
import { IsoDate } from "./common.ts";

/**
 * Owner access to this node's web UI from other machines, through the node's own domain (its tunnel).
 *
 * - On the loopback UI port nothing changes: no login (same trust as today).
 * - On the public listener (tunnel origin) the web UI, `/api/local/*` and `/ws` are served ONLY when remote UI is
 *   enabled AND the request carries a valid owner session cookie. `/api/v1/*` keeps node-signature auth and never
 *   reads cookies. The SPA's static files are public (they contain no data); every API/WS call is gated.
 */
export const AccessStatus = z.object({
	/** Shown on the login page; both are already public through `/api/v1/node/info`. */
	nodeName: z.string(),
	/** Full hex fingerprint of the node identity. */
	fingerprint: z.string(),
	passwordSet: z.boolean(),
	remoteUiEnabled: z.boolean(),
	/**
	 * Where the UI is reachable from other machines: the tunnel URL, only while remote UI is enabled AND the tunnel is up
	 * (null otherwise, so `remoteUiEnabled && publicUiUrl === null` means "enabled, but the tunnel is not running").
	 */
	publicUiUrl: z.string().nullable(),
	/** How THIS request reached the node. */
	via: z.enum(["loopback", "remote"]),
	/** Remote requests: whether a valid owner session is attached (always true for loopback). */
	signedIn: z.boolean(),
	/** Remote session expiry (sliding), when signed in remotely. */
	sessionExpiresAt: IsoDate.nullable(),
	sessionTtlHours: z.number().int(),
});
export type AccessStatus = z.infer<typeof AccessStatus>;

export const MIN_PASSWORD_LENGTH = 12;
/** First password: loopback only. Change: loopback, or a signed-in remote session that also proves `currentPassword`. */
export const SetPasswordBody = z.object({
	password: z.string().min(MIN_PASSWORD_LENGTH).max(256),
	currentPassword: z.string().max(256).optional(),
});
export const LoginBody = z.object({ password: z.string().min(1).max(256) });
/** Enabling requires a password; loopback only. */
export const UpdateAccessBody = z.object({
	remoteUiEnabled: z.boolean().optional(),
	sessionTtlHours: z.number().int().min(1).max(24 * 7).optional(),
});
