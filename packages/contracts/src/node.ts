import { z } from "zod";
import { I18nText, IsoDate } from "./common.ts";

export const NodeInfo = z.object({
	id: z.string(),
	name: z.string(),
	/** SHA-256 fingerprint of the node's Ed25519 public key (hex, colon-free). */
	fingerprint: z.string(),
	publicKey: z.string(),
	version: z.string(),
	platform: z.string(),
	arch: z.string(),
	hostname: z.string(),
	/** Public tunnel URL once configured (M3+); null for local-only nodes. */
	publicUrl: z.string().nullable(),
	bindAddress: z.string(),
	port: z.number().int(),
	dataDir: z.string(),
	startedAt: IsoDate,
});
export type NodeInfo = z.infer<typeof NodeInfo>;

export const HealthStatus = z.enum(["ok", "degraded", "down"]);
export type HealthStatus = z.infer<typeof HealthStatus>;

export const HealthCheck = z.object({
	name: z.string(),
	status: HealthStatus,
	message: z.string().optional(),
	/** Structured twin of `message` for localisation when the message is our own text; absent otherwise. */
	i18n: I18nText.optional(),
	latencyMs: z.number().optional(),
});
export type HealthCheck = z.infer<typeof HealthCheck>;

export const NodeHealth = z.object({
	status: HealthStatus,
	uptimeMs: z.number(),
	checks: z.array(HealthCheck),
	memory: z.object({ rss: z.number(), heapUsed: z.number() }),
	activeRuntimes: z.number().int(),
	checkedAt: IsoDate,
});
export type NodeHealth = z.infer<typeof NodeHealth>;

export const NodeSettings = z.object({
	nodeName: z.string().min(1).max(64),
	/** Stop an idle, settled agent runtime process after this many minutes. */
	runtimeIdleTimeoutMin: z.number().int().min(1).max(24 * 60),
	/** Max concurrently running agent runtime processes on this node. */
	maxConcurrentRuntimes: z.number().int().min(1).max(64),
	/** OMP tool approval mode passed to each runtime (`--approval-mode`). */
	approvalMode: z.enum(["always-ask", "always-ask-cached", "write", "yolo"]),
	/** Start CL Agent Mesh when you log in to this computer. GET reports whether the OS login entry actually exists. */
	autoStart: z.boolean(),
	/** Setup policy when work arrives by handoff / hand-over / takeover: `ask` = show the setup commands for approval first, `auto` = run them (install + reviewed setup commands), `skip` = never run any. */
	dependencySetup: z.enum(["ask", "auto", "skip"]),
	/** Accept incoming task handoffs without asking (the target still verifies everything; it only skips the human decision). */
	autoAcceptHandoffs: z.boolean(),
	/** Read-only explanation of the OS login entry: where it lives, when it takes effect, why it is off. Ignored in PATCH. */
	autoStartDetail: z.string().optional(),
	/** Structured twin of `autoStartDetail` for localisation. Ignored in PATCH. */
	autoStartI18n: I18nText.optional(),
});
export type NodeSettings = z.infer<typeof NodeSettings>;
export const NodeSettingsPatch = NodeSettings.omit({ autoStartDetail: true, autoStartI18n: true }).partial();
export type NodeSettingsPatch = z.infer<typeof NodeSettingsPatch>;

export const SecurityInfo = z.object({
	bindAddress: z.string(),
	allowedHosts: z.array(z.string()),
	remoteApiEnabled: z.boolean(),
	secretStore: z.object({ backend: z.enum(["macos-keychain", "libsecret", "windows-credential", "encrypted-file"]), location: z.string() }),
	fingerprint: z.string(),
});
export type SecurityInfo = z.infer<typeof SecurityInfo>;
