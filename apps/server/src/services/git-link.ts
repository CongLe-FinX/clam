import type { RepositoryRef } from "@clam/contracts";
import { projects } from "@clam/database";
import { eq } from "drizzle-orm";
import type { ServerContext } from "../context.ts";

/** GitHub metadata is a courtesy at project creation: never hold the request longer than this. */
const METADATA_TIMEOUT_MS = 5000;

/**
 * Link a freshly created project to the GitHub repository its `origin` points at (https or ssh github.com remote),
 * using the node's default account. Metadata (numeric id, default branch, canonical URL) is filled from the API when
 * the account can read the repository; otherwise the link carries owner/name only. Never throws: a project is
 * useful without a link.
 */
export async function autoLinkRepository(ctx: ServerContext, projectId: string): Promise<void> {
	try {
		const row = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
		if (!row || row.repository) return;
		const remote = await ctx.git.githubRemote(row.path);
		if (!remote) return;
		const account = ctx.github.listAccounts().find((a) => a.isDefault) ?? null;
		let repository: RepositoryRef = {
			owner: remote.owner,
			name: remote.repo,
			externalId: null,
			htmlUrl: `https://github.com/${remote.owner}/${remote.repo}`,
			defaultBranch: null,
			accountId: account?.id ?? null,
		};
		if (account) {
			const timeout = new Promise<null>((resolve) => setTimeout(resolve, METADATA_TIMEOUT_MS, null).unref());
			const meta = await Promise.race([ctx.github.getRepository(account.id, remote.owner, remote.repo).catch(() => null), timeout]);
			if (meta) repository = { owner: meta.owner, name: meta.name, externalId: meta.id, htmlUrl: meta.htmlUrl, defaultBranch: meta.defaultBranch, accountId: account.id };
		}
		ctx.db
			.update(projects)
			.set({ repository, repositoryId: repository.externalId, updatedAt: new Date().toISOString() })
			.where(eq(projects.id, projectId))
			.run();
	} catch (err) {
		ctx.log.debug({ err, projectId }, "could not auto-link the project to a GitHub repository");
	}
}
