import { projects } from "@clam/database";
import type { ClamDb } from "@clam/database";
import { eq } from "drizzle-orm";

type ProjectRow = typeof projects.$inferSelect;

/**
 * The cross-node identity of a project: what two nodes compare to decide that their projects are "the same" for context
 * sync (local project ids differ per node). A project linked to a GitHub repository is `github:<owner>/<name>`
 * (lowercase); any other project is `name:<name>` (trimmed, lowercase) — so two plain-folder projects with the same name in
 * one workspace share their project-level contexts. Computed live from the project row; never stored on the project.
 */
export function projectKeyOf(project: Pick<ProjectRow, "name" | "repository">): string {
	const repo = project.repository;
	if (repo) return `github:${repo.owner}/${repo.name}`.toLowerCase();
	return `name:${project.name.trim().toLowerCase()}`.slice(0, 300);
}

export function projectRow(db: ClamDb, id: string): ProjectRow | undefined {
	return db.select().from(projects).where(eq(projects.id, id)).get();
}

/** The oldest local project of the workspace whose key is `key`; undefined when this node has none. */
export function findProjectByKey(db: ClamDb, workspaceId: string, key: string): ProjectRow | undefined {
	return db
		.select()
		.from(projects)
		.where(eq(projects.workspaceId, workspaceId))
		.orderBy(projects.createdAt, projects.id)
		.all()
		.find((p) => projectKeyOf(p) === key);
}
