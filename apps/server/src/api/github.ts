import { routes, UpdateGithubConfigBody, i18nMsg } from "@clam/contracts";
import { GithubError } from "@clam/github-integration";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";
import { ApiError } from "../http/errors.ts";

const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const ReposQuery = z.object({
	q: z.string().trim().max(200).optional(),
	page: z.coerce.number().int().min(1).max(1000).optional(),
});

/** Maps service errors onto the shared `ApiError` envelope. */
async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		throw err instanceof GithubError ? new ApiError(err.status, err.code, err.message, err.details) : err;
	}
}

type AccountParams = { Params: { id: string } };

/** Local API for GitHub accounts: OAuth device flow, `gh` import, repositories, permission checks. */
export default async function githubRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const service = ctx.github;

	app.get(routes.githubConfig, () => guard(() => service.getConfig()));

	app.put(routes.githubConfig, (req) => guard(() => service.setClientId(UpdateGithubConfigBody.parse(req.body).clientId)));

	app.post(routes.githubDeviceStart, () => guard(() => service.startDeviceFlow()));

	app.get<{ Params: { flowId: string } }>(routes.githubDeviceStatus(":flowId"), (req) =>
		guard(() => service.deviceFlowStatus(req.params.flowId)),
	);

	app.post(routes.githubImportGh, () => guard(() => service.importFromGhCli()));

	app.get(routes.githubAccounts, () => guard(() => service.listAccounts()));

	app.delete<AccountParams>(routes.githubAccount(":id"), async (req, reply) => {
		await guard(() => service.disconnect(req.params.id));
		return reply.code(204).send();
	});

	app.post<AccountParams>(routes.githubAccountDefault(":id"), (req) => guard(() => service.setDefault(req.params.id)));

	app.post<AccountParams>(routes.githubAccountVerify(":id"), (req) => guard(() => service.verify(req.params.id)));

	app.get<AccountParams>(routes.githubRepos(":id"), (req) =>
		guard(() => service.listRepos(req.params.id, ReposQuery.parse(req.query))),
	);

	app.get<{ Params: { id: string; owner: string; repo: string } }>(routes.githubRepoCheck(":id", ":owner", ":repo"), (req) =>
		guard(() => {
			const { id, owner, repo } = req.params;
			if (!NAME.test(owner) || !NAME.test(repo)) throw ApiError.badRequest(i18nMsg("Invalid repository owner or name."));
			return service.checkRepo(id, owner, repo);
		}),
	);
}
