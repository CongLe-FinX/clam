import { hostname, arch, platform } from "node:os";
import {
	type NodeInfo,
	type NodeSettings,
	type SecurityInfo,
	NodeSettingsPatch,
	type TunnelState,
	UpdateTunnelConfigBody,
	routes,
} from "@clam/contracts";
import { node as nodeTable, nodeEvents } from "@clam/database";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { RoutePluginOptions } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { ALLOWED_HOSTS } from "../http/host-guard.ts";
import { AutostartError } from "../services/autostart.ts";
import { HealthService } from "../services/health.ts";
import { readNodeSettings, toSupervisorSettings, writeNodeSettings } from "../services/settings.ts";

const AUTOSTART_STATUS = { not_built: 409, unsupported: 409, failed: 502 } as const;

/** Autostart failures reach the user as typed API errors with the OS-level reason in the message. */
function toApiError(error: unknown): unknown {
	if (!(error instanceof AutostartError)) return error;
	return new ApiError(AUTOSTART_STATUS[error.code], `autostart_${error.code}`, { text: error.message, i18n: error.i18n });
}

/** Node identity/health/settings/security and the Cloudflare Tunnel. */
export default async function nodeRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const health = new HealthService(ctx);
	health.startPublishing();
	app.addHook("onClose", async () => health.stop());

	app.get(routes.node, async (): Promise<NodeInfo> => ({
		id: ctx.identity.nodeId,
		name: readNodeSettings(ctx.db).nodeName,
		fingerprint: ctx.identity.fingerprint,
		publicKey: ctx.identity.publicKey,
		version: ctx.config.version,
		platform: platform(),
		arch: arch(),
		hostname: hostname(),
		publicUrl: ctx.network.tunnel.publicUrl(),
		bindAddress: ctx.config.host,
		port: ctx.config.port,
		dataDir: ctx.config.dataDir,
		startedAt: ctx.startedAt.toISOString(),
	}));

	app.get(routes.health, async () => health.check());

	/** Stored settings, with `autoStart` replaced by what the OS login entry really is. */
	async function effectiveSettings(): Promise<NodeSettings> {
		const login = await ctx.autostart.status();
		return { ...readNodeSettings(ctx.db), autoStart: login.enabled, autoStartDetail: login.detail, ...(login.i18n && { autoStartI18n: login.i18n }) };
	}

	app.get(routes.settings, effectiveSettings);

	app.patch(routes.settings, async (req) => {
		const patch = NodeSettingsPatch.parse(req.body);
		if (patch.autoStart !== undefined) {
			// The OS entry first: if it cannot be made, nothing else in this patch is applied either.
			try {
				patch.autoStart = (patch.autoStart ? await ctx.autostart.enable() : await ctx.autostart.disable()).enabled;
			} catch (error) {
				throw toApiError(error);
			}
		}
		const next = writeNodeSettings(ctx.db, patch);
		ctx.db.insert(nodeEvents).values({ nodeId: ctx.identity.nodeId, type: "settings.updated", payload: { changed: Object.keys(patch) } }).run();
		ctx.runtime.updateOptions(toSupervisorSettings(next));
		if (patch.nodeName !== undefined) {
			ctx.db.update(nodeTable).set({ name: next.nodeName, updatedAt: new Date().toISOString() }).where(eq(nodeTable.id, ctx.identity.nodeId)).run();
			void ctx.network.announceSelf();
		}
		return effectiveSettings();
	});

	app.get(routes.security, async (): Promise<SecurityInfo> => ({
		bindAddress: ctx.config.host,
		allowedHosts: [...ALLOWED_HOSTS],
		// The /api/v1 listener always runs on loopback; it is reachable from outside only while the tunnel is up.
		remoteApiEnabled: ctx.network.tunnel.publicUrl() !== null,
		secretStore: { backend: ctx.secrets.backend, location: ctx.secrets.location },
		fingerprint: ctx.identity.fingerprint,
	}));

	app.get(routes.tunnel, async (): Promise<TunnelState> => ctx.network.tunnel.state());
	app.put(routes.tunnelConfig, async (req): Promise<TunnelState> => ctx.network.tunnel.updateConfig(UpdateTunnelConfigBody.parse(req.body)));
	app.post(routes.tunnelStart, async (): Promise<TunnelState> => ctx.network.tunnel.start());
	app.post(routes.tunnelStop, async (): Promise<TunnelState> => ctx.network.tunnel.stop());
	app.post(routes.tunnelProbe, async (): Promise<TunnelState> => ctx.network.tunnel.probe());
}
