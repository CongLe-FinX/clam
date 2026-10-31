import type { TunnelMode, TunnelState, UpdateTunnelConfigBody } from "@clam/contracts";
import { node, settings } from "@clam/database";
import type { ClamDb } from "@clam/database";
import { createTunnelManager, detectCloudflared, type CloudflaredInfo, type TunnelManager, type TunnelRuntimeState } from "@clam/cloudflare-tunnel";
import type { SecretStore } from "@clam/secret-store";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { EventBus } from "../context.ts";
import { ApiError } from "../http/errors.ts";

const CONFIG_KEY = "network.tunnel";
const TOKEN_SECRET = "tunnel.token";
const DETECT_CACHE_MS = 30_000;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

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
 */
export class TunnelService {
	private manager: TunnelManager | null = null;
	private offManager: (() => void) | null = null;
	private detectCache: { at: number; info: CloudflaredInfo } | null = null;
	private readonly urlListeners = new Set<(url: string | null) => void>();
	private lastPublicUrl: string | null = null;

	constructor(private readonly deps: TunnelServiceDeps) {}

	config(): StoredTunnelConfig {
		const row = this.deps.db.select().from(settings).where(eq(settings.key, CONFIG_KEY)).get();
		const fallback: StoredTunnelConfig = { mode: "off", hostname: null, autoStart: false };
		if (!row) return fallback;
		try {
			const value = JSON.parse(row.value) as Partial<StoredTunnelConfig>;
			const mode = value.mode === "quick" || value.mode === "named" ? value.mode : "off";
			return { mode, hostname: typeof value.hostname === "string" ? value.hostname : null, autoStart: value.autoStart === true };
		} catch {
			return fallback;
		}
	}

	private writeConfig(next: StoredTunnelConfig): void {
		const value = JSON.stringify(next);
		const updatedAt = new Date().toISOString();
		this.deps.db.insert(settings).values({ key: CONFIG_KEY, value, updatedAt }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
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

	/** HTTPS base URL peers use to reach this node, only while the tunnel is actually up. */
	publicUrl(): string | null {
		const runtime = this.runtime();
		return (runtime.state === "running" || runtime.state === "reconnecting") && runtime.publicUrl ? runtime.publicUrl : null;
	}

	/** Hostname of the public URL (the network listener's Host guard accepts it). */
	publicHostname(): string | null {
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
		return {
			cloudflared: await this.detect(),
			config: { mode: config.mode, hostname: config.hostname, hasToken: await this.hasToken(), autoStart: config.autoStart },
			state: runtime.state,
			publicUrl: runtime.state === "stopped" ? null : runtime.publicUrl,
			pid: runtime.pid,
			connections: runtime.connections,
			lastError: runtime.lastError,
			startedAt: runtime.startedAt,
			networkListener: this.deps.networkListener(),
		};
	}

	async updateConfig(body: z.infer<typeof UpdateTunnelConfigBody>): Promise<TunnelState> {
		const current = this.config();
		const hostname = body.mode === "named" ? (body.hostname === undefined ? current.hostname : body.hostname) : null;
		if (body.mode === "named") {
			if (!hostname) throw ApiError.badRequest("A named tunnel needs the public hostname you routed to this node in the Cloudflare dashboard");
			if (!HOSTNAME.test(hostname)) throw ApiError.badRequest(`"${hostname}" is not a valid hostname (use e.g. node-a.example.com, no scheme or path)`);
		}
		if (body.token === null) await this.deps.secrets.delete(TOKEN_SECRET);
		else if (body.token !== undefined) await this.deps.secrets.set(TOKEN_SECRET, body.token);
		if (body.mode === "named" && !(await this.hasToken())) {
			throw ApiError.badRequest("A named tunnel needs the tunnel token from the Cloudflare dashboard");
		}
		const next: StoredTunnelConfig = { mode: body.mode, hostname: hostname?.toLowerCase() ?? null, autoStart: body.autoStart ?? current.autoStart };
		const changed = next.mode !== current.mode || next.hostname !== current.hostname || body.token !== undefined;
		this.writeConfig(next);
		// A running tunnel keeps serving the old configuration; switch it over so the saved config is what runs.
		const active = this.runtime().state !== "stopped";
		if (active && changed) {
			await this.stopInternal();
			if (next.mode !== "off") await this.startInternal(next);
		}
		return this.publish();
	}

	async start(): Promise<TunnelState> {
		const config = this.config();
		if (config.mode === "off") throw new ApiError(409, "tunnel_mode_off", "Choose a tunnel mode (quick or named) before starting the tunnel");
		await this.startInternal(config);
		return this.publish();
	}

	async stop(): Promise<TunnelState> {
		await this.stopInternal();
		return this.publish();
	}

	/** Boot: start the tunnel when `autoStart` is set. A failure is logged and shown in the state, never fatal. */
	async autoStart(): Promise<void> {
		const config = this.config();
		if (!config.autoStart || config.mode === "off") return;
		try {
			await this.startInternal(config);
		} catch (error) {
			this.deps.log.warn({ err: error instanceof Error ? error.message : String(error) }, "tunnel auto-start failed");
		}
		void this.publish();
	}

	async dispose(): Promise<void> {
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
		const cloudflared = await this.detect();
		if (!cloudflared.installed && !this.deps.createManager) {
			throw new ApiError(409, "cloudflared_not_installed", "cloudflared is not installed. Install it (macOS: brew install cloudflared) and try again.");
		}
		const manager = this.ensureManager();
		try {
			if (config.mode === "quick") {
				await manager.start({ mode: "quick" });
				return;
			}
			const token = await this.deps.secrets.get(TOKEN_SECRET);
			if (!token || !config.hostname) throw ApiError.badRequest("The named tunnel needs both its token and its public hostname");
			await manager.start({ mode: "named", token, hostname: config.hostname });
		} catch (error) {
			// The manager validates the named-tunnel token charset and hostname with TypeError.
			if (error instanceof TypeError) throw ApiError.badRequest(error.message);
			throw error;
		}
	}

	private async stopInternal(): Promise<void> {
		await this.manager?.stop();
	}

	/** Push the current state to the UI, keep `node.public_url` honest and tell listeners when the public URL changed. */
	private async publish(): Promise<TunnelState> {
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
