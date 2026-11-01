import type { IncomingHttpHeaders } from "node:http";
import {
	PREVIEW_RESERVED_PREFIX,
	type I18nMessage,
	type PreviewCheckResult,
	type PreviewStatus,
	type PreviewTicket,
	type PreviewTicketBody,
	type PreviewUnavailableReason,
	i18nMsg,
} from "@clam/contracts";
import { settings } from "@clam/database";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { RequestAccess } from "../auth/service.ts";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { errorText } from "../network/util.ts";
import { recordAudit } from "../services/audit.ts";
import { deriveDefaultHost, landingPath, matchPreviewHost, parsePreviewHost, type HostError } from "./preview-host.ts";
import { refusePort, type PortRefusal } from "./port-policy.ts";

const KEY_HOST = "preview.host";
const CHECK_TIMEOUT_MS = 8_000;

/** Where a request to the network listener lands when it is a preview request. */
export interface PreviewRoute {
	/** The name the browser used (no port), and the origin it implies: what redirects and `Origin` are rewritten against. */
	host: string;
	origin: string;
	/** The request URL (path + query) as the browser sent it. */
	url: string;
}

export interface PreviewServiceOptions {
	/** Test seam: HTTP client of `check()` (default: global `fetch`). */
	fetch?: typeof fetch;
	checkTimeoutMs?: number;
}

type Deps = Pick<ServerContext, "db" | "network" | "config" | "identity" | "log" | "access" | "browser">;

/** An app listening on this machine that the preview host may reach (the port picker's rows). */
export interface PreviewApp {
	port: number;
	title: string | null;
	process: string | null;
}

function hostError(error: HostError): I18nMessage {
	return error === "tunnel"
		? i18nMsg("The preview host must differ from this machine's tunnel hostname (that one serves the UI)")
		: i18nMsg("The preview host must be a plain hostname such as {example}", { example: "my-machine-preview.example.com" });
}

const UNAVAILABLE = i18nMsg("Previews need a named tunnel with a hostname. Set one up under Settings → Cloudflare Tunnel first.");

/** What `/__clam_preview/health` answers (see `gateway.ts`). */
const HealthBody = z.object({ service: z.literal("clam-preview"), nodeId: z.string() });

/** `fetch failed` hides its reason in `cause` (`ENOTFOUND`, `ECONNREFUSED`, a TLS error…): name it. */
function networkErrorText(error: unknown): string {
	const cause = error instanceof Error ? error.cause : undefined;
	if (cause instanceof Error) {
		const code = "code" in cause && typeof cause.code === "string" ? cause.code : null;
		return code ?? errorText(cause, 120);
	}
	return errorText(error, 120);
}

/** The one place that knows the preview host and which ports it may reach. Owns the saved host. */
export class PreviewService {
	constructor(
		private readonly ctx: Deps,
		private readonly options: PreviewServiceOptions = {},
	) {}

	// ---------------------------------------------------------------------------------------------- host

	private savedHost(): string | null {
		return this.ctx.db.select().from(settings).where(eq(settings.key, KEY_HOST)).get()?.value ?? null;
	}

	private resolveConfig(): { host: string | null; hostname: string | null; reason: PreviewUnavailableReason | null; defaultHost: string | null; saved: string | null } {
		const config = this.ctx.network.tunnel.config();
		const saved = this.savedHost();
		if (config.mode !== "named" || !config.hostname) return { host: null, hostname: null, reason: "no_named_tunnel", defaultHost: null, saved };
		const hostname = config.hostname;
		const defaultHost = deriveDefaultHost(hostname);
		const wanted = saved ?? defaultHost;
		if (wanted === null) return { host: null, hostname, reason: "hostname_too_short", defaultHost, saved };
		const parsed = parsePreviewHost(wanted, hostname);
		return parsed.ok ? { host: parsed.host, hostname, reason: null, defaultHost, saved } : { host: null, hostname, reason: "bad_host", defaultHost, saved };
	}

	/** The effective preview host; null when previews cannot be addressed (no named tunnel, nothing to derive from, invalid saved host). */
	host(): string | null {
		return this.resolveConfig().host;
	}

	/** Save (or, with null, clear) the preview host. Loopback UI only (the route is gated). */
	setHost(input: string | null): PreviewStatus {
		const config = this.ctx.network.tunnel.config();
		if (config.mode !== "named" || !config.hostname) throw ApiError.badRequest(UNAVAILABLE);
		let value: string | null = null;
		if (input !== null) {
			const parsed = parsePreviewHost(input, config.hostname);
			if (!parsed.ok) throw ApiError.badRequest(hostError(parsed.error));
			value = parsed.host;
		}
		if (value === null || value === deriveDefaultHost(config.hostname)) this.ctx.db.delete(settings).where(eq(settings.key, KEY_HOST)).run();
		else {
			const updatedAt = new Date().toISOString();
			this.ctx.db.insert(settings).values({ key: KEY_HOST, value, updatedAt }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
		}
		return this.status();
	}

	status(): PreviewStatus {
		const { host, hostname, reason, defaultHost, saved } = this.resolveConfig();
		const access = this.ctx.access.config();
		const parent = (name: string | null): string | null => (name === null ? null : name.slice(name.indexOf(".") + 1));
		return {
			available: host !== null,
			unavailableReason: reason,
			hostname,
			host,
			defaultHost,
			customHost: host !== null && saved !== null,
			universalSsl: host !== null && parent(host) === parent(hostname),
			remoteEnabled: access.remoteUiEnabled && access.remotePreviewEnabled,
		};
	}

	// ---------------------------------------------------------------------------------------------- routing

	/**
	 * THE routing decision of preview: is this request for the preview host? Every consumer (the network listener's hooks, the gateway)
	 * goes through here, so another scheme (a forwarded-host header, say) is one change in this method. Which PORT a request is for is
	 * the gateway's business (`/port/<port>/…` and the port cookie).
	 */
	resolve(req: { headers: IncomingHttpHeaders; url?: string | undefined }): PreviewRoute | null {
		const host = this.host();
		const matched = host === null ? null : matchPreviewHost(host, req.headers.host);
		return matched === null ? null : { host: matched, origin: `https://${matched}`, url: req.url ?? "/" };
	}

	/** Ports of this node's own listeners (UI, network): never previewable. */
	ownPorts(): number[] {
		return [this.ctx.config.port, this.ctx.config.networkPort].filter((p) => p > 0);
	}

	refusal(port: number): PortRefusal | null {
		return refusePort(port, this.ownPorts());
	}

	/** The web apps listening on this machine that may be previewed: the port picker's rows. */
	async apps(): Promise<PreviewApp[]> {
		const seen = new Set<number>();
		const out: PreviewApp[] = [];
		for (const entry of await this.ctx.browser.ports()) {
			if (seen.has(entry.port) || this.refusal(entry.port)) continue;
			seen.add(entry.port);
			out.push({ port: entry.port, title: entry.title, process: entry.hint ?? entry.process });
		}
		return out;
	}

	// ---------------------------------------------------------------------------------------------- tickets

	/**
	 * `POST /preview/ticket`: validate the port against the policy and mint the one-time sign-in URL for the preview host; it lands on
	 * `/port/<port><path>`. The caller has asserted `access.assertTool(request.access, "preview")`.
	 */
	async ticket(request: RequestAccess, body: PreviewTicketBody): Promise<PreviewTicket> {
		const host = this.host();
		if (!host) throw new ApiError(409, "preview_unavailable", UNAVAILABLE);
		const refusal = this.refusal(body.port);
		if (refusal) throw new ApiError(403, "port_not_allowed", refusal === "own" ? i18nMsg("Port {port} belongs to CL Agent Mesh itself and cannot be previewed", { port: body.port }) : i18nMsg("Port {port} cannot be previewed (databases, remote login, debuggers and other non-web services are never opened)", { port: body.port }));
		const path = body.path === undefined || body.path === "" ? "/" : body.path;
		if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\r\n]/.test(path)) throw ApiError.badRequest(i18nMsg("path must start with a single /"));
		const { token, expiresAt } = await this.ctx.access.issuePreviewTicket(request, { port: body.port, host, path: landingPath(body.port, path) });
		recordAudit(this.ctx, "preview.open", { via: request.via, port: body.port, host, sid: request.session?.sid.slice(0, 8) ?? null });
		return { url: `https://${host}${PREVIEW_RESERVED_PREFIX}auth?ticket=${encodeURIComponent(token)}`, expiresAt: new Date(expiresAt).toISOString() };
	}

	// ---------------------------------------------------------------------------------------------- reachability check

	/** Does `https://<preview host>/__clam_preview/health` answer from THIS node (id match)? */
	async check(): Promise<PreviewCheckResult> {
		const host = this.host();
		if (!host) throw new ApiError(409, "preview_unavailable", UNAVAILABLE);
		const done = (ok: boolean, reason: PreviewCheckResult["reason"], say: I18nMessage): PreviewCheckResult => ({ ok, host, reason, message: say.text, ...(say.i18n && { i18n: say.i18n }) });
		let health: z.infer<typeof HealthBody> | null = null;
		try {
			const res = await (this.options.fetch ?? fetch)(`https://${host}${PREVIEW_RESERVED_PREFIX}health`, {
				headers: { accept: "application/json" },
				redirect: "manual",
				signal: AbortSignal.timeout(this.options.checkTimeoutMs ?? CHECK_TIMEOUT_MS),
			});
			const parsed = HealthBody.safeParse(res.ok ? await res.json().catch(() => null) : null);
			health = parsed.success ? parsed.data : null;
		} catch (error) {
			return done(false, "unreachable", i18nMsg("Could not reach https://{host} ({error}). Check that this public hostname exists in Cloudflare and points at this machine's network listener, and give DNS a minute.", { host, error: networkErrorText(error) }));
		}
		if (health?.nodeId === this.ctx.identity.nodeId) return done(true, "ok", i18nMsg("https://{host} reaches this machine. Previews are ready.", { host }));
		return done(false, "not_this_node", i18nMsg("https://{host} answered, but not from this machine. Check that it is routed to this machine's network listener and that no other tunnel claims it.", { host }));
	}
}
