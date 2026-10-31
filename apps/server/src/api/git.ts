import {
	CloneProjectBody,
	CreatePullRequestBody,
	GitCheckoutBody,
	GitCommitBody,
	GitCreateBranchBody,
	GitDiffQuery,
	GitDiscardBody,
	GitPathsBody,
	GitPushBody,
	routes,
	SetGitIdentityBody,
} from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";

const LogQuery = z.object({
	ref: z.string().min(1).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	cursor: z.string().min(1).optional(),
});
const ConflictsQuery = z.object({ against: z.string().min(1).optional() });
const PullsQuery = z.object({ state: z.enum(["open", "closed", "all"]).default("open") });

type ProjectParams = { Params: { id: string } };

/**
 * Git for projects: status/diff/log/branches, stage/unstage/discard/commit, fetch/pull/push (never forced), conflict
 * report, commit identity, pull requests, `.clmesh` bootstrap and clone-into-new-project. All behaviour lives in
 * `GitService`; this plugin only parses requests. Mutations of one project are serialized; every mutation answers
 * the fresh status and publishes `git:<projectId>`.
 */
export default async function gitRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const git = ctx.gitService;
	app.addHook("onClose", async () => git.dispose());

	app.post(routes.projectClone, async (req, reply) => {
		const op = await git.startClone(CloneProjectBody.parse(req.body));
		return reply.status(202).send(op);
	});
	app.get<{ Params: { opId: string } }>(routes.gitOperation(":opId"), (req) => git.operation(req.params.opId));

	app.get(routes.gitOverview, () => git.overview());

	app.get<ProjectParams>(routes.gitStatus(":id"), (req) => git.status(req.params.id));
	app.get<ProjectParams>(routes.gitDiff(":id"), (req) => git.diff(req.params.id, GitDiffQuery.parse(req.query)));
	app.get<ProjectParams>(routes.gitBranches(":id"), (req) => git.branches(req.params.id));
	app.post<ProjectParams>(routes.gitBranches(":id"), (req) => git.createBranch(req.params.id, GitCreateBranchBody.parse(req.body)));
	app.post<ProjectParams>(routes.gitCheckout(":id"), (req) => git.checkout(req.params.id, GitCheckoutBody.parse(req.body).branch));
	app.get<ProjectParams>(routes.gitLog(":id"), (req) => git.log(req.params.id, LogQuery.parse(req.query)));

	app.post<ProjectParams>(routes.gitStage(":id"), (req) => git.stage(req.params.id, GitPathsBody.parse(req.body).paths));
	app.post<ProjectParams>(routes.gitUnstage(":id"), (req) => git.unstage(req.params.id, GitPathsBody.parse(req.body).paths));
	app.post<ProjectParams>(routes.gitDiscard(":id"), (req) => git.discard(req.params.id, GitDiscardBody.parse(req.body).paths));
	app.post<ProjectParams>(routes.gitCommit(":id"), (req) => git.commit(req.params.id, GitCommitBody.parse(req.body)));

	app.post<ProjectParams>(routes.gitFetch(":id"), (req) => git.fetch(req.params.id));
	app.post<ProjectParams>(routes.gitPull(":id"), (req) => git.pull(req.params.id));
	app.post<ProjectParams>(routes.gitPush(":id"), (req) => git.push(req.params.id, GitPushBody.parse(req.body ?? {})));
	app.get<ProjectParams>(routes.gitConflicts(":id"), (req) => git.conflicts(req.params.id, ConflictsQuery.parse(req.query).against));

	app.get<ProjectParams>(routes.gitIdentity(":id"), (req) => git.identity(req.params.id));
	app.put<ProjectParams>(routes.gitIdentity(":id"), (req) => git.setIdentity(req.params.id, SetGitIdentityBody.parse(req.body ?? null)));

	app.get<ProjectParams>(routes.gitPullRequests(":id"), (req) => git.listPullRequests(req.params.id, PullsQuery.parse(req.query).state));
	app.post<ProjectParams>(routes.gitPullRequests(":id"), async (req, reply) => {
		const pr = await git.createPullRequest(req.params.id, CreatePullRequestBody.parse(req.body));
		return reply.status(201).send(pr);
	});
	app.get<{ Params: { id: string; num: string } }>(routes.gitPullRequest(":id", 0).replace(/0$/, ":num"), (req) => {
		const num = z.coerce.number().int().min(1).parse(req.params.num);
		return git.getPullRequest(req.params.id, num);
	});

	app.post<ProjectParams>(routes.clmeshInit(":id"), (req) => git.clmeshInit(req.params.id));
}
