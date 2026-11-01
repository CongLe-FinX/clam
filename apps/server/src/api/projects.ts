import { CreateProjectBody, type Project, routes, UpdateProjectBody, i18nMsg } from "@clam/contracts";
import { agentSessions, projects, workspaces } from "@clam/database";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions, ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { canonicalProjectDir, listDirectory, readProjectFile } from "../services/files.ts";
import { autoLinkRepository } from "../services/git-link.ts";
import { newId } from "../services/ids.ts";
import { publishSessionRemovals, teardownProjectSessions } from "../services/project-cleanup.ts";
import { createManagedProject, deleteManagedFolder, projectVcs } from "../services/project-folders.ts";

type Row = typeof projects.$inferSelect;

const ListQuery = z.object({ workspaceId: z.string().min(1).optional() });
const PathQuery = z.object({ path: z.string().default("") });
/** `DELETE /projects/:id?deleteFiles=true`: also delete the folder of a managed project (never a folder the user chose). */
const DeleteQuery = z.object({ deleteFiles: z.enum(["true", "false", "1", "0"]).optional() });

export function activity(ctx: ServerContext, projectId: string): { sessionCount: number; lastActivityAt: string | null } {
	const r = ctx.db
		.select({ n: sql<number>`count(*)`, last: sql<string | null>`max(${agentSessions.updatedAt})` })
		.from(agentSessions)
		.where(eq(agentSessions.projectId, projectId))
		.get();
	return { sessionCount: r?.n ?? 0, lastActivityAt: r?.last ?? null };
}

export const toProject = (row: Row, a: { sessionCount: number; lastActivityAt: string | null }): Project => ({
	id: row.id,
	workspaceId: row.workspaceId,
	name: row.name,
	path: row.path,
	repository: row.repository ?? null,
	vcs: projectVcs(row.path),
	managed: row.managed,
	origin: row.origin,
	sessionCount: a.sessionCount,
	lastActivityAt: a.lastActivityAt,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

export function requireProject(ctx: ServerContext, id: string): Row {
	const row = ctx.db.select().from(projects).where(eq(projects.id, id)).get();
	if (!row) throw ApiError.notFound("Project");
	return row;
}

/** Project CRUD plus read-only file browsing of the project directory. List order: newest first. */
export default async function projectRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	app.get(routes.projects, (req): Project[] => {
		const { workspaceId } = ListQuery.parse(req.query);
		const stats = new Map(
			ctx.db
				.select({ id: agentSessions.projectId, n: sql<number>`count(*)`, last: sql<string | null>`max(${agentSessions.updatedAt})` })
				.from(agentSessions)
				.groupBy(agentSessions.projectId)
				.all()
				.map((r) => [r.id, { sessionCount: r.n, lastActivityAt: r.last }]),
		);
		return ctx.db
			.select()
			.from(projects)
			.where(workspaceId ? eq(projects.workspaceId, workspaceId) : undefined)
			.orderBy(sql`${projects.createdAt} desc`, projects.id)
			.all()
			.map((row) => toProject(row, stats.get(row.id) ?? { sessionCount: 0, lastActivityAt: null }));
	});

	app.post(routes.projects, async (req, reply): Promise<Project> => {
		const body = CreateProjectBody.parse(req.body);
		if (!ctx.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, body.workspaceId)).get()) {
			throw ApiError.notFound("Workspace");
		}
		if (body.path === undefined) {
			// No path: CL Agent Mesh creates an empty folder under its data dir; no git repository involved.
			const created = createManagedProject(ctx, { workspaceId: body.workspaceId, name: body.name });
			reply.status(201);
			return toProject(created, { sessionCount: 0, lastActivityAt: null });
		}
		const dir = await canonicalProjectDir(body.path);
		if (ctx.db.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, body.workspaceId), eq(projects.path, dir))).get()) {
			throw ApiError.conflict(i18nMsg("This workspace already has a project at {dir}", { dir }));
		}
		const id = newId("prj");
		ctx.db.insert(projects).values({ id, workspaceId: body.workspaceId, name: body.name, path: dir }).run();
		await autoLinkRepository(ctx, id);
		reply.status(201);
		return toProject(requireProject(ctx, id), { sessionCount: 0, lastActivityAt: null });
	});

	app.get<{ Params: { id: string } }>(routes.project(":id"), (req): Project => {
		const row = requireProject(ctx, req.params.id);
		return toProject(row, activity(ctx, row.id));
	});

	app.patch<{ Params: { id: string } }>(routes.project(":id"), (req): Project => {
		const row = requireProject(ctx, req.params.id);
		const body = UpdateProjectBody.parse(req.body);
		ctx.db
			.update(projects)
			.set({
				...(body.name !== undefined && { name: body.name }),
				...(body.repository !== undefined && { repository: body.repository, repositoryId: body.repository?.externalId ?? null }),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(projects.id, row.id))
			.run();
		return toProject(requireProject(ctx, row.id), activity(ctx, row.id));
	});

	app.delete<{ Params: { id: string } }>(routes.project(":id"), async (req, reply) => {
		const row = requireProject(ctx, req.params.id);
		const query = DeleteQuery.parse(req.query);
		const deleteFiles = query.deleteFiles === "true" || query.deleteFiles === "1";
		if (deleteFiles && !row.managed) throw ApiError.conflict(i18nMsg("Only a folder CL Agent Mesh created (a managed project) can be deleted with the project; this project points at a folder you chose"));
		const sessionIds = await teardownProjectSessions(ctx, [row.id]);
		ctx.db.delete(projects).where(eq(projects.id, row.id)).run();
		if (deleteFiles) await deleteManagedFolder(ctx, row);
		publishSessionRemovals(ctx, sessionIds);
		return reply.status(204).send();
	});

	app.get<{ Params: { id: string } }>(routes.projectFiles(":id"), async (req) => {
		const row = requireProject(ctx, req.params.id);
		return listDirectory(row.path, PathQuery.parse(req.query).path);
	});

	app.get<{ Params: { id: string } }>(routes.projectFile(":id"), async (req) => {
		const row = requireProject(ctx, req.params.id);
		return readProjectFile(row.path, PathQuery.parse(req.query).path);
	});
}
