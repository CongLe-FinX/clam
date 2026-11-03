import { z } from "zod";
import { IsoDate } from "./common.ts";

export const OmpInstall = z.object({
	installed: z.boolean(),
	version: z.string().nullable(),
	binaryPath: z.string().nullable(),
	/** Directory containing config.yml (from `omp config path`). */
	configPath: z.string().nullable(),
	error: z.string().optional(),
});
export type OmpInstall = z.infer<typeof OmpInstall>;

/** From RPC `get_login_providers`. */
export const LoginProvider = z.object({
	id: z.string(),
	name: z.string(),
	available: z.boolean(),
	authenticated: z.boolean(),
});
export type LoginProvider = z.infer<typeof LoginProvider>;

/** From RPC `get_logout_accounts`. */
export const ProviderAccount = z.object({
	credentialId: z.number().int(),
	provider: z.string(),
	label: z.string(),
	detail: z.string().optional(),
	type: z.string(),
	active: z.boolean().optional(),
});
export type ProviderAccount = z.infer<typeof ProviderAccount>;

export const LoginFlowState = z.enum([
	"starting",
	"awaiting_browser", // url is set; user must open it
	"awaiting_input", // prompt is set; user must answer via /input
	"success",
	"error",
	"cancelled",
]);
export type LoginFlowState = z.infer<typeof LoginFlowState>;

export const LoginFlow = z.object({
	flowId: z.string(),
	providerId: z.string(),
	state: LoginFlowState,
	url: z.string().optional(),
	instructions: z.string().optional(),
	prompt: z
		.object({
			requestId: z.string(),
			message: z.string(),
			placeholder: z.string().optional(),
		})
		.optional(),
	error: z.string().optional(),
	updatedAt: IsoDate,
});
export type LoginFlow = z.infer<typeof LoginFlow>;

export const StartLoginBody = z.object({ providerId: z.string().min(1) });
export const LoginInputBody = z.object({ requestId: z.string(), value: z.string() });
export const LogoutBody = z.object({ providerId: z.string().min(1), credentialId: z.number().int() });

export const ModelInfo = z.object({
	provider: z.string(),
	id: z.string(),
	/** `provider/id` */
	selector: z.string(),
	name: z.string(),
	contextWindow: z.number().nullable(),
	maxTokens: z.number().nullable(),
	reasoning: z.boolean(),
	thinking: z.array(z.string()),
	input: z.array(z.string()),
	cost: z
		.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() })
		.nullable(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

/**
 * Model roles as stored in OMP config (`modelRoles`). Keys are open-ended: OMP
 * defines roles beyond the five the UI highlights. Values are `provider/id[:thinking]`.
 */
export const ModelRoles = z.record(z.string(), z.string());
export type ModelRoles = z.infer<typeof ModelRoles>;
export const HIGHLIGHTED_MODEL_ROLES = ["default", "smol", "slow", "plan", "commit"] as const;

export const SetModelRoleBody = z.object({ role: z.string().min(1), selector: z.string().nullable() });

export const ModelTestBody = z.object({ selector: z.string().min(1) });
export const ModelTestResult = z.object({
	ok: z.boolean(),
	selector: z.string(),
	latencyMs: z.number(),
	output: z.string().optional(),
	error: z.string().optional(),
});
export type ModelTestResult = z.infer<typeof ModelTestResult>;

export const ProvidersOverview = z.object({
	install: OmpInstall,
	providers: z.array(LoginProvider),
	/** Default model from `modelRoles.default`, if set. */
	defaultModel: z.string().nullable(),
});
export type ProvidersOverview = z.infer<typeof ProvidersOverview>;

/** `GET /omp/update`: the installed OMP and the newest release on its update channel. */
export const OmpUpdateCheck = z.object({
	current: z.string().nullable(),
	/** Null when omp could not tell (it printed neither an offer nor "up to date"). */
	latest: z.string().nullable(),
	available: z.boolean(),
	checkedAt: z.string(),
});
export type OmpUpdateCheck = z.infer<typeof OmpUpdateCheck>;

/** `POST /omp/update`: what `omp update` did. */
export const OmpUpdateResult = z.object({
	previous: z.string().nullable(),
	/** The version now installed (`omp --version` after the update). */
	version: z.string().nullable(),
	updated: z.boolean(),
	/** omp's own output, for the details view. */
	output: z.string(),
	/** Agent runtimes still running the previous version: they switch when they restart. */
	runningSessions: z.number().int(),
});
export type OmpUpdateResult = z.infer<typeof OmpUpdateResult>;
