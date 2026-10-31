import { AgentRuntimeError } from "@clam/agent-runtime";
import { isValidModelRole, isValidModelSelector } from "@clam/agent-runtime/omp";
import {
	type LoginFlow,
	LoginInputBody,
	LogoutBody,
	type ModelInfo,
	type ModelRoles,
	ModelTestBody,
	type ModelTestResult,
	type ProviderAccount,
	type ProvidersOverview,
	routes,
	SetModelRoleBody,
	StartLoginBody,
} from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";
import { ApiError } from "../http/errors.ts";

const ProviderParams = z.object({ providerId: z.string().min(1) });
const FlowParams = z.object({ flowId: z.string().min(1) });
const ModelsQuery = z.object({ refresh: z.enum(["1", "true", "0", "false"]).optional() });

/** OMP provider login/logout (via the control RPC process), model catalogue, model roles and model test. */
export default async function ompRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	// Publish every login flow change; the WS hub replays the latest `login:*` event to late subscribers.
	const unsubscribe = ctx.ompControl.onFlow((flow) => {
		if (flow.state === "success") ctx.ompCli.invalidate();
		ctx.bus.publish(`login:${flow.flowId}`, { type: "flow", flow });
	});
	app.addHook("onClose", async () => {
		unsubscribe();
	});

	function requireFlow(flowId: string): LoginFlow {
		const flow = ctx.ompControl.getFlow(flowId);
		if (!flow) throw ApiError.notFound("Login flow");
		return flow;
	}

	app.get(routes.ompProviders, async (): Promise<ProvidersOverview> => {
		const install = await ctx.ompCli.detect();
		if (!install.installed) return { install, providers: [], defaultModel: null };
		const [providers, roles] = await Promise.all([
			ctx.ompControl.providers(),
			ctx.ompCli.modelRoles().catch((error: unknown): ModelRoles => {
				ctx.log.warn({ err: error instanceof Error ? error.message : String(error) }, "could not read omp model roles");
				return {};
			}),
		]);
		return { install, providers, defaultModel: roles.default ?? null };
	});

	app.get(routes.ompProviderAccounts(":providerId"), async (req): Promise<ProviderAccount[]> => {
		const { providerId } = ProviderParams.parse(req.params);
		return ctx.ompControl.accounts(providerId);
	});

	app.post(routes.ompLogin, async (req): Promise<LoginFlow> => {
		const { providerId } = StartLoginBody.parse(req.body);
		const install = await ctx.ompCli.detect();
		if (!install.installed) throw ApiError.unavailable(install.error ?? "omp is not installed");
		return ctx.ompControl.startLogin(providerId);
	});

	app.post(routes.ompLoginInput(":flowId"), async (req): Promise<LoginFlow> => {
		const { flowId } = FlowParams.parse(req.params);
		const body = LoginInputBody.parse(req.body);
		requireFlow(flowId);
		try {
			return ctx.ompControl.submitLoginInput(flowId, body);
		} catch (error) {
			if (error instanceof AgentRuntimeError && error.code === "invalid_state") throw ApiError.conflict(error.message, error.details);
			throw error;
		}
	});

	app.post(routes.ompLoginCancel(":flowId"), async (req): Promise<LoginFlow> => {
		const { flowId } = FlowParams.parse(req.params);
		requireFlow(flowId);
		return ctx.ompControl.cancelLogin(flowId);
	});

	app.post(routes.ompLogout, async (req): Promise<{ remainingSource: string | null }> => {
		const { providerId, credentialId } = LogoutBody.parse(req.body);
		const result = await ctx.ompControl.logout(providerId, credentialId);
		ctx.ompCli.invalidate();
		return result;
	});

	app.get(routes.ompModels, async (req): Promise<ModelInfo[]> => {
		const { refresh } = ModelsQuery.parse(req.query);
		return ctx.ompCli.models({ refresh: refresh === "1" || refresh === "true" });
	});

	app.get(routes.ompModelRoles, (): Promise<ModelRoles> => ctx.ompCli.modelRoles());

	app.put(routes.ompModelRoles, async (req): Promise<ModelRoles> => {
		const { role, selector } = SetModelRoleBody.parse(req.body);
		if (!isValidModelRole(role)) throw ApiError.badRequest(`Invalid model role name: ${JSON.stringify(role)}`);
		if (selector !== null && !isValidModelSelector(selector)) {
			throw ApiError.badRequest(`Invalid model selector: ${JSON.stringify(selector)} (expected provider/id[:thinking])`);
		}
		return ctx.ompCli.setModelRole(role, selector);
	});

	app.post(routes.ompModelTest, async (req): Promise<ModelTestResult> => {
		const { selector } = ModelTestBody.parse(req.body);
		if (!isValidModelSelector(selector)) throw ApiError.badRequest(`Invalid model selector: ${JSON.stringify(selector)}`);
		return ctx.ompCli.testModel(selector);
	});
}
