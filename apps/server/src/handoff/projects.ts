import { i18nMsg } from "@clam/contracts";
import { agents, projects, workspaces } from "@clam/database";
import type { HandoffManifest } from "@clam/handoff-engine";
import { normalizeRepoUrl } from "@clam/task-engine";
import { and, asc, eq } from "drizzle-orm";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { createManagedProject, type ProjectRow } from "../services/project-folders.ts";

export interface AcceptTarget {
	project: ProjectRow;
	/** True when this handoff created the (managed) project, so a cleanup may remove it again. */
	created: boolean;
	agent: { id: string; name: string };
}

/** Local projects linked to a GitHub repository key (`owner/name`, lower case). */
function candidateProjects(ctx: ServerContext, key: string): ProjectRow[] {
	return ctx.db
		.select()
		.from(projects)
		.all()
		.filter((p) => p.repository && `${p.repository.owner}/${p.repository.name}`.toLowerCase() === key);
}

/**
 * Where the handed-over work lives on this node. Git work: the chosen project, else the only local project linked to the repository
 * (the task engine's `repoProject` rule: 409 `project_required` when there is none or several). Files / no files: the chosen project of
 * the task's workspace, else a fresh managed folder created for this handoff only.
 */
export function resolveTargetProject(ctx: ServerContext, manifest: HandoffManifest, choice: { projectId?: string | undefined; existingProjectId?: string | null }): { project: ProjectRow; created: boolean } {
	const chosen = choice.projectId ?? choice.existingProjectId ?? undefined;
	if (manifest.vcs === "git" && manifest.git) {
		const key = normalizeRepoUrl(manifest.git.repoUrl)?.key ?? "";
		const candidates = candidateProjects(ctx, key);
		const projectId = chosen ?? (candidates.length === 1 ? candidates[0]?.id : undefined);
		if (!projectId) {
			throw new ApiError(409, "project_required", candidates.length === 0 ? i18nMsg("No local project is linked to this repository; choose a project explicitly") : i18nMsg("Several local projects match this repository; choose one"), {
				candidates: candidates.map((p) => p.id),
			});
		}
		const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
		if (!project) throw ApiError.notFound("Project");
		if (!project.repository || `${project.repository.owner}/${project.repository.name}`.toLowerCase() !== key) {
			throw new ApiError(409, "project_mismatch", i18nMsg("That project is not linked to the handed-over repository"));
		}
		return { project, created: false };
	}
	if (chosen) {
		const project = ctx.db.select().from(projects).where(eq(projects.id, chosen)).get();
		if (!project) throw ApiError.notFound("Project");
		if (project.workspaceId !== manifest.workspaceId) throw new ApiError(409, "project_mismatch", i18nMsg("That project belongs to another workspace than the task"));
		return { project, created: false };
	}
	if (!ctx.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, manifest.workspaceId)).get()) throw ApiError.notFound("Workspace");
	return { project: createManagedProject(ctx, { workspaceId: manifest.workspaceId, name: `Task ${manifest.task.id.slice(-6)}: ${manifest.task.title}`.slice(0, 80) }), created: true };
}

/** The OMP agent that continues the work: the chosen one, else the one the source named, else the node's first. */
export function resolveTargetAgent(ctx: ServerContext, choice: { agentId?: string | null | undefined }): { id: string; name: string } {
	if (choice.agentId) {
		const agent = ctx.db.select().from(agents).where(and(eq(agents.id, choice.agentId), eq(agents.runtime, "omp"))).get();
		if (!agent) throw new ApiError(400, "unknown_agent", i18nMsg("The agent does not exist on this node"));
		return { id: agent.id, name: agent.name };
	}
	const first = ctx.db.select().from(agents).where(eq(agents.runtime, "omp")).orderBy(asc(agents.createdAt)).get();
	if (!first) throw ApiError.unavailable(i18nMsg("This node has no OMP agent configured"));
	return { id: first.id, name: first.name };
}
