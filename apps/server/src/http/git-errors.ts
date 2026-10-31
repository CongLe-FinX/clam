import { GitEngineError } from "@clam/git-engine";
import { GithubError } from "@clam/github-integration";
import { ApiError } from "./errors.ts";

/** Git's own words, credentials already scrubbed by the engine; the engine's message when git said nothing. */
function verbatim(err: GitEngineError): string {
	return err.stderr.trim() || err.message;
}

/** 403 when the remote refused an authenticated identity (permission/SSO), 401 when it rejected the credentials. */
function authStatus(stderr: string): 401 | 403 {
	return /\b403\b|forbidden|permission to .* denied|SAML|SSO|not permitted|protected branch/i.test(stderr) ? 403 : 401;
}

/** Maps an engine failure onto the shared `ApiError` envelope; the remote's/ git's message is kept verbatim. */
export function gitEngineApiError(err: GitEngineError): ApiError {
	const details = { gitCode: err.code, stderr: err.stderr };
	const message = verbatim(err);
	switch (err.code) {
		case "git_missing":
			return new ApiError(503, "git_missing", message, details);
		case "not_a_repo":
			return new ApiError(404, "not_a_repo", message, details);
		case "invalid_ref":
			return new ApiError(400, "git_invalid_ref", message, details);
		case "dest_not_empty":
			return new ApiError(409, "git_dest_not_empty", message, details);
		case "would_overwrite":
			return new ApiError(409, "git_would_overwrite", message, details);
		case "dirty_worktree":
			return new ApiError(409, "git_dirty_worktree", message, details);
		case "operation_in_progress":
			return new ApiError(409, "git_operation_in_progress", message, details);
		case "auth_failed": {
			const status = authStatus(err.stderr);
			return new ApiError(status, status === 403 ? "git_forbidden" : "git_unauthorized", message, details);
		}
		case "network":
			return new ApiError(502, "git_network", message, details);
		case "timeout":
			return new ApiError(504, "git_timeout", message, details);
		case "secret_detected":
			return new ApiError(422, "git_secret_detected", message, details);
		case "failed":
			return new ApiError(500, "git_failed", message, details);
	}
}

/** Maps any error thrown while serving a git route; other errors pass through to the global handler. */
export function toGitApiError(err: unknown): unknown {
	if (err instanceof GitEngineError) return gitEngineApiError(err);
	if (err instanceof GithubError) return new ApiError(err.status, err.code, err.message, err.details);
	return err;
}

/** The verbatim failure text of any error, for operation records and logs. */
export function failureText(err: unknown): string {
	if (err instanceof GitEngineError) return verbatim(err);
	return err instanceof Error ? err.message : String(err);
}
