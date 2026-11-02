/**
 * A checkout id addresses a folder of a project for the git, file and terminal routes: `<projectId>` is the project's own folder,
 * `<projectId>~<sharedSessionId>` the git worktree this node keeps for a git-mode shared session of that project.
 */
export const CHECKOUT_SEPARATOR = "~";

export function checkoutIdOf(projectId: string, sharedSessionId: string | null): string {
	return sharedSessionId ? `${projectId}${CHECKOUT_SEPARATOR}${sharedSessionId}` : projectId;
}

export function parseCheckoutId(id: string): { projectId: string; sharedSessionId: string | null } {
	const at = id.indexOf(CHECKOUT_SEPARATOR);
	return at < 0 ? { projectId: id, sharedSessionId: null } : { projectId: id.slice(0, at), sharedSessionId: id.slice(at + 1) };
}
