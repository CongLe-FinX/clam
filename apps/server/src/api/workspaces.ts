import { AddWorkspaceMemberBody, CreateWorkspaceBody, routes, UpdateWorkspaceBody, type Workspace, type WorkspaceMember } from "@clam/contracts";
import { projects, workspaceMembers, workspaces } from "@clam/database";
import { and, eq, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { RoutePluginOptions, ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { newId } from "../services/ids.ts";
import { publishSessionRemovals, teardownProjectSessions } from "../services/project-cleanup.ts";

type Row = typeof workspaces.$inferSelect;
const toWorkspace = (row: Row, projectCount: number): Workspace => ({
	id: row.id,
	name: row.name,
	description: row.description,
	ownerNodeId: row.ownerNodeId,
	projectCount,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

/** Chat folders (origin `chat`) are listed under Chats, so they do not count as projects. */
function projectCount(ctx: ServerContext, workspaceId: string): number {
	return (
		ctx.db
			.select({ n: sql<number>`count(*)` })
			.from(projects)
			.where(and(eq(projects.workspaceId, workspaceId), ne(projects.origin, "chat")))
			.get()?.n ?? 0
	);
}

function requireWorkspace(ctx: ServerContext, id: string): Row {
	const row = ctx.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
	if (!row) throw ApiError.notFound("Workspace");
	return row;
}

function assertNameFree(ctx: ServerContext, name: string, exceptId?: string): void {
	const clash = ctx.db
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(sql`lower(${workspaces.name}) = lower(${name})`)
		.all()
		.find((r) => r.id !== exceptId);
	if (clash) throw ApiError.conflict(`A workspace named "${name}" already exists`);
}

/** Workspace CRUD. The list is ordered by name (case-insensitive). */
export default async function workspaceRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	app.get(routes.workspaces, (): Workspace[] => {
		const counts = new Map(
			ctx.db
				.select({ id: projects.workspaceId, n: sql<number>`count(*)` })
				.from(projects)
				.where(ne(projects.origin, "chat"))
				.groupBy(projects.workspaceId)
				.all()
				.map((r) => [r.id, r.n]),
		);
		return ctx.db
			.select()
			.from(workspaces)
			.orderBy(sql`lower(${workspaces.name})`, workspaces.id)
			.all()
			.map((row) => toWorkspace(row, counts.get(row.id) ?? 0));
	});

	app.post(routes.workspaces, (req, reply): Workspace => {
		const body = CreateWorkspaceBody.parse(req.body);
		assertNameFree(ctx, body.name);
		const id = newId("ws");
		ctx.db.transaction((tx) => {
			tx.insert(workspaces).values({ id, name: body.name, description: body.description, ownerNodeId: ctx.identity.nodeId }).run();
			tx.insert(workspaceMembers).values({ workspaceId: id, memberId: ctx.identity.nodeId, role: "owner" }).run();
		});
		reply.status(201);
		return toWorkspace(requireWorkspace(ctx, id), 0);
	});

	app.get<{ Params: { id: string } }>(routes.workspace(":id"), (req): Workspace => {
		const row = requireWorkspace(ctx, req.params.id);
		return toWorkspace(row, projectCount(ctx, row.id));
	});

	app.patch<{ Params: { id: string } }>(routes.workspace(":id"), (req): Workspace => {
		const row = requireWorkspace(ctx, req.params.id);
		const body = UpdateWorkspaceBody.parse(req.body);
		if (body.name !== undefined) assertNameFree(ctx, body.name, row.id);
		ctx.db
			.update(workspaces)
			.set({
				...(body.name !== undefined && { name: body.name }),
				...(body.description !== undefined && { description: body.description }),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(workspaces.id, row.id))
			.run();
		return toWorkspace(requireWorkspace(ctx, row.id), projectCount(ctx, row.id));
	});

	app.delete<{ Params: { id: string } }>(routes.workspace(":id"), async (req, reply) => {
		const row = requireWorkspace(ctx, req.params.id);
		const projectIds = ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.workspaceId, row.id)).all().map((p) => p.id);
		const sessionIds = await teardownProjectSessions(ctx, projectIds);
		ctx.db.delete(workspaces).where(eq(workspaces.id, row.id)).run();
		publishSessionRemovals(ctx, sessionIds);
		return reply.status(204).send();
	});

	// Members (M6): this node and the paired peers that share the workspace.
	app.get<{ Params: { id: string } }>(routes.workspaceMembers(":id"), (req): WorkspaceMember[] => ctx.contexts.members.list(req.params.id));
	app.post<{ Params: { id: string } }>(routes.workspaceMembers(":id"), (req, reply): WorkspaceMember[] => {
		const members = ctx.contexts.members.add(req.params.id, AddWorkspaceMemberBody.parse(req.body));
		reply.status(201);
		return members;
	});
	app.delete<{ Params: { id: string; nodeId: string } }>(routes.workspaceMember(":id", ":nodeId"), (req): WorkspaceMember[] => ctx.contexts.members.remove(req.params.id, req.params.nodeId));
}
