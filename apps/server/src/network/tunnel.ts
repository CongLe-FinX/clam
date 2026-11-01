import { i18nMsg, type I18nText, type TunnelMode, type TunnelState, type UpdateTunnelConfigBody } from "@clam/contracts";
import { node, settings } from "@clam/database";
import type { ClamDb } from "@clam/database";
import { createTunnelManager, detectCloudflared, TunnelConfigError, type CloudflaredInfo, type TunnelManager, type TunnelRuntimeState } from "@clam/cloudflare-tunnel";
import type { SecretStore } from "@clam/secret-store";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { EventBus } from "../context.ts";
import { ApiError } from "../http/errors.ts";

const CONFIG_KEY = "network.tunnel";
const TOKEN_SECRET = "tunnel.token";
const DETECT_CACHE_MS = 30_000;
const EXTERNAL_PROBE_MS = 60_000;
const EXTERNAL_PROBE_TIMEOUT_MS = 5_000;
const PROBE_BODY_MAX = 64 * 1024;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** The stored JSON, tolerant of anything unexpected (a missing or damaged row means "off"). */
function parseConfig(raw: string | undefined): StoredTunnelConfig {
	const fallback: StoredTunnelConfig = { mode: "off", hostname: null, autoStart: false };
	if (raw === undefined) return fallback;
	try {
		const value = JSON.parse(raw) as Partial<StoredTunnelConfig>;
		const mode = value.mode === "quick" || value.mode === "named" ? value.mode : "off";
		return { mode, hostname: typeof value.hostname === "string" ? value.hostname : null, autoStart: value.autoStart === true };
	} catch {
		return fallback;
	}
}

export interface StoredTunnelConfig {
	mode: TunnelMode;
	hostname: string | null;
	autoStart: boolean;
}

export interface TunnelLog {
	info(o: object, m?: string): void;
	warn(o: object, m?: string): void;
}

export interface TunnelServiceDeps {
	db: ClamDb;
	secrets: SecretStore;
	bus: EventBus;
	log: TunnelLog;
	nodeId: string;
	/** This node's key fingerprint: the external-connector probe only trusts an answer that carries it. */
	fingerprint: string;
	/** Test seam: the HTTP client of the external-connector probe (default: global `fetch`). */
	fetch?: typeof fetch;
	/** Period of the external-connector probe while a named tunnel is not running (default 60 s). */
	externalProbeMs?: number;
	/** Timeout of one probe request (default 5 s). */
	externalProbeTimeoutMs?: number;
	/** Private directory for the tunnel's 0600 token file. */
	runtimeDir: string;
	/** `cloudflared` executable override (`CLAM_CLOUDFLARED_BIN`). */
	binary?: string;
	/** Test seam: replaces the real cloudflared process manager. */
	createManager?: (o: { originUrl: string; runtimeDir: string; binary?: string; log: TunnelLog }) => TunnelManager;
	networkListener(): { host: string; port: number };
}

/**
 * Cloudflare Tunnel for this node: persists the configuration (`settings`; the named-tunnel token only in the secret
 * store), wraps `@clam/cloudflare-tunnel`, and reports the public URL peers must use. The tunnel's origin is the
 * network listener, which serves nothing but `/api/v1`.
 *
 * Named mode DECLARES the hostname: the network listener accepts it as `Host` whether or not CLAM's own cloudflared is
 * running, because another connector (the owner's own cloudflared) may serve the route. Whether that is really so is not
 * assumed: while a named tunnel is not running, `https://<hostname>/api/v1/node/info` is probed and only an answer carrying
 * this node's id and fingerprint makes the hostname the public URL (`externalConnector`).
 */
export class TunnelService {
	private manager: TunnelManager | null = null;
	private offManager: (() => void) | null = null;
	private detectCache: { at: number; info: CloudflaredInfo } | null = null;
	private readonly urlListeners = new Set<(url: string | null) => void>();
	private lastPublicUrl: string | null = null;
	private cachedConfig: StoredTunnelConfig | null = null;
	/** Why the last automatic start failed (the manager only reports its own failures). */
	private startError: { text: string; i18n: I18nText | undefined } | null = null;
	/** Hostname that answered the probe with this node's identity (named mode, own connector not running). */
	private externalFor: string | null = null;
	private probing: Promise<void> | null = null;
	private probeTimer: ReturnType<typeof setInterval> | null = null;
	private active = false;
	private disposed = false;

	constructor(private readonly deps: TunnelServiceDeps) {}

	config(): StoredTunnelConfig {
		if (this.cachedConfig) return this.cachedConfig;
		const row = this.deps.db.select().from(settings).where(eq(settings.key, CONFIG_KEY)).get();
		this.cachedConfig = parseConfig(row?.value);
		return this.cachedConfig;
	}

	private writeConfig(next: StoredTunnelConfig): void {
		const value = JSON.stringify(next);
		const updatedAt = new Date().toISOString();
		this.deps.db.insert(settings).values({ key: CONFIG_KEY, value, updatedAt }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
		this.cachedConfig = next;
	}

	private async hasToken(): Promise<boolean> {
		return (await this.deps.secrets.get(TOKEN_SECRET)) !== null;
	}

	private async detect(): Promise<CloudflaredInfo> {
		if (this.detectCache && Date.now() - this.detectCache.at < DETECT_CACHE_MS) return this.detectCache.info;
		const info = await detectCloudflared({ binary: this.deps.binary });
		this.detectCache = { at: Date.now(), info };
		return info;
	}

	private runtime(): TunnelRuntimeState {
		return this.manager?.state() ?? { state: "stopped", mode: "off", publicUrl: null, pid: null, connections: 0, lastError: null, startedAt: null };
	}

	private ownConnectorUp(): boolean {
		const { state } = this.runtime();
		return state === "running" || state === "reconnecting";
	}

	/** The named hostname another cloudflared has been seen serving (null whenever the evidence no longer applies). */
	private externalHost(): string | null {
		const config = this.config();
		return this.externalFor !== null && config.mode === "named" && config.hostname === this.externalFor && !this.ownConnectorUp() ? this.externalFor : null;
	}

	/** HTTPS base URL peers use to reach this node: our own connector's URL while it is up, else a named hostname that provably reaches this node. */
	publicUrl(): string | null {
		const runtime = this.runtime();
		if (this.ownConnectorUp() && runtime.publicUrl) return runtime.publicUrl;
		const external = this.externalHost();
		return external ? `https://${external}` : null;
	}

	/**
	 * Hostname the network listener (and the remote-UI origin check) accepts. Named mode declares it from the saved
	 * configuration even while CLAM's own connector is stopped; quick mode only knows its random hostname at runtime.
	 */
	publicHostname(): string | null {
		const config = this.config();
		if (config.mode === "named" && config.hostname) return config.hostname.toLowerCase();
		const url = this.publicUrl() ?? this.runtime().publicUrl;
		return url ? new URL(url).host.toLowerCase() : null;
	}

	onPublicUrlChange(listener: (url: string | null) => void): () => void {
		this.urlListeners.add(listener);
		return () => this.urlListeners.delete(listener);
	}

	async state(): Promise<TunnelState> {
		const config = this.config();
		const runtime = this.runtime();
		const lastError = runtime.lastError ?? this.startError?.text ?? null;
		const lastErrorI18n = runtime.lastError ? runtime.lastErrorI18n : this.startError?.i18n;
		return {
			cloudflared: await this.detect(),
			config: { mode: config.mode, hostname: config.hostname, hasToken: await this.hasToken(), autoStart: config.autoStart },
			state: runtime.state,
			publicUrl: this.publicUrl() ?? (runtime.state === "stopped" ? null : runtime.publicUrl),
			externalConnector: this.externalHost() !== null,
			pid: runtime.pid,
			connections: runtime.connections,
			lastError,
			...(lastErrorI18n && { lastErrorI18n }),
			startedAt: runtime.startedAt,
			networkListener: this.deps.networkListener(),
		};
	}

	async updateConfig(body: z.infer<typeof UpdateTunnelConfigBody>): Promise<TunnelState> {
		const current = this.config();
		const hostname = body.mode === "named" ? (body.hostname === undefined ? current.hostname : body.hostname) : null;
		if (body.mode === "named") {
			if (!hostname) throw ApiError.badRequest(i18nMsg("A named tunnel needs the public hostname you routed to this node in the Cloudflare dashboard"));
			if (!HOSTNAME.test(hostname)) throw ApiError.badRequest(i18nMsg('"{hostname}" is not a valid hostname (use e.g. node-a.example.com, no scheme or path)', { hostname }));
		}
		if (body.token === null) await this.deps.secrets.delete(TOKEN_SECRET);
		else if (body.token !== undefined) await this.deps.secrets.set(TOKEN_SECRET, body.token);
		if (body.mode === "named" && !(await this.hasToken())) {
			throw ApiError.badRequest(i18nMsg("A named tunnel needs the tunnel token from the Cloudflare dashboard"));
		}
		const next: StoredTunnelConfig = { mode: body.mode, hostname: hostname?.toLowerCase() ?? null, autoStart: body.autoStart ?? current.autoStart };
		const changed = next.mode !== current.mode || next.hostname !== current.hostname || body.token !== undefined;
		this.writeConfig(next);
		this.startError = null;
		if (changed) {
			// What was learnt about the old hostname says nothing about the new one: forget it and probe afresh.
			this.externalFor = null;
			this.stopProbeTimer();
		}
		// A running tunnel keeps serving the old configuration; switch it over so the saved config is what runs.
		const active = this.runtime().state !== "stopped";
		if (active && changed) {
			await this.stopInternal();
			if (next.mode !== "off") await this.startInternal(next);
		} else if (!active && next.autoStart && next.mode !== "off") {
			// "Start automatically" is a promise that the saved configuration is live, not only after the next boot.
			await this.startFromSettings(next);
		}
		return this.publish();
	}

	/** Check now whether another cloudflared already serves the named hostname (the Tunnel page's "Check again"). */
	async probe(): Promise<TunnelState> {
		await this.probeExternal();
		return this.publish();
	}

	async start(): Promise<TunnelState> {
		const config = this.config();
		if (config.mode === "off") throw new ApiError(409, "tunnel_mode_off", i18nMsg("Choose a tunnel mode (quick or named) before starting the tunnel"));
		await this.startInternal(config);
		return this.publish();
	}

	async stop(): Promise<TunnelState> {
		await this.stopInternal();
		return this.publish();
	}

	/** Boot: start the tunnel when `autoStart` is set. A failure is logged and shown in the state, never fatal. */
	async autoStart(): Promise<void> {
		this.active = true;
		const config = this.config();
		if (config.autoStart && config.mode !== "off") await this.startFromSettings(config);
		void this.publish();
	}

	async dispose(): Promise<void> {
		this.active = false;
		this.disposed = true;
		this.syncProbe();
		this.offManager?.();
		this.offManager = null;
		await this.manager?.dispose();
		this.manager = null;
	}

	private ensureManager(): TunnelManager {
		if (this.manager) return this.manager;
		const listener = this.deps.networkListener();
		const options = {
			originUrl: `http://${listener.host.includes(":") ? `[${listener.host}]` : listener.host}:${listener.port}`,
			runtimeDir: this.deps.runtimeDir,
			binary: this.deps.binary,
			log: this.deps.log,
		};
		const manager = this.deps.createManager ? this.deps.createManager(options) : createTunnelManager(options);
		this.manager = manager;
		this.offManager = manager.onChange(() => void this.publish());
		return manager;
	}

	private async startInternal(config: StoredTunnelConfig): Promise<void> {
		this.startError = null;
		const cloudflared = await this.detect();
		if (!cloudflared.installed && !this.deps.createManager) {
			throw new ApiError(409, "cloudflared_not_installed", i18nMsg("cloudflared is not installed. Install it (macOS: brew install cloudflared) and try again."));
		}
		const manager = this.ensureManager();
		try {
			if (config.mode === "quick") {
				await manager.start({ mode: "quick" });
				return;
			}
			const token = await this.deps.secrets.get(TOKEN_SECRET);
			if (!token || !config.hostname) throw ApiError.badRequest(i18nMsg("The named tunnel needs both its token and its public hostname"));
			await manager.start({ mode: "named", token, hostname: config.hostname });
		} catch (error) {
			// The manager validates the named-tunnel token charset and hostname with `TunnelConfigError`.
			if (error instanceof TunnelConfigError) throw ApiError.badRequest(error.detail);
			throw error;
		}
	}

	/** Start from saved settings without failing the caller: the reason is logged and reported in `lastError`. */
	private async startFromSettings(config: StoredTunnelConfig): Promise<void> {
		try {
			await this.startInternal(config);
		} catch (error) {
			this.deps.log.warn({ err: error instanceof Error ? error.message : String(error) }, "tunnel auto-start failed");
			this.startError = { text: error instanceof Error ? error.message : String(error), i18n: error instanceof ApiError ? error.i18n : undefined };
		}
	}

	private async stopInternal(): Promise<void> {
		await this.manager?.stop();
	}

	/** The probe runs periodically exactly while a named tunnel is configured and CLAM's own connector is not up. */
	private syncProbe(): void {
		const config = this.config();
		const wanted = this.active && config.mode === "named" && config.hostname !== null && !this.ownConnectorUp();
		if (wanted && !this.probeTimer) {
			this.probeTimer = setInterval(() => void this.probe().catch(() => undefined), this.deps.externalProbeMs ?? EXTERNAL_PROBE_MS);
			this.probeTimer.unref();
			void this.probe().catch(() => undefined);
		} else if (!wanted) {
			this.stopProbeTimer();
		}
	}

	private stopProbeTimer(): void {
		if (this.probeTimer) clearInterval(this.probeTimer);
		this.probeTimer = null;
	}

	private probeExternal(): Promise<void> {
		this.probing ??= this.runProbe().finally(() => {
			this.probing = null;
		});
		return this.probing;
	}

	private async runProbe(): Promise<void> {
		const config = this.config();
		const hostname = config.mode === "named" ? config.hostname : null;
		if (!hostname || this.ownConnectorUp()) {
			this.externalFor = null;
			return;
		}
		const reached = await this.reachesThisNode(hostname);
		// The configuration may have moved on while the request was in flight.
		if (this.config().hostname !== hostname) return;
		this.externalFor = reached ? hostname : null;
	}

	/** Does `https://<hostname>/api/v1/node/info` answer with THIS node's id and fingerprint (not just any 200)? */
	private async reachesThisNode(hostname: string): Promise<boolean> {
		try {
			const res = await (this.deps.fetch ?? fetch)(`https://${hostname}/api/v1/node/info`, {
				headers: { accept: "application/json" },
				redirect: "manual",
				signal: AbortSignal.timeout(this.deps.externalProbeTimeoutMs ?? EXTERNAL_PROBE_TIMEOUT_MS),
			});
			if (!res.ok || Number(res.headers.get("content-length") ?? 0) > PROBE_BODY_MAX) return false;
			const body = (await res.json()) as { nodeId?: unknown; fingerprint?: unknown } | null;
			return body?.nodeId === this.deps.nodeId && body.fingerprint === this.deps.fingerprint;
		} catch {
			return false;
		}
	}

	/** Push the current state to the UI, keep `node.public_url` honest and tell listeners when the public URL changed. */
	private async publish(): Promise<TunnelState> {
		// After dispose the database may already be closed: report the state, change nothing.
		if (this.disposed) return this.state();
		this.syncProbe();
		const state = await this.state();
		this.deps.bus.publish("tunnel", { type: "state", state });
		const url = this.publicUrl();
		if (url !== this.lastPublicUrl) {
			this.lastPublicUrl = url;
			this.deps.db.update(node).set({ publicUrl: url, updatedAt: new Date().toISOString() }).where(eq(node.id, this.deps.nodeId)).run();
			for (const listener of [...this.urlListeners]) {
				try {
					listener(url);
				} catch (error) {
					this.deps.log.warn({ err: error instanceof Error ? error.message : String(error) }, "tunnel url listener failed");
				}
			}
		}
		return state;
	}
}
