export type GithubErrorCode =
	| "not_configured"
	| "flow_not_found"
	| "account_not_found"
	| "gh_unavailable"
	| "token_invalid"
	| "rate_limited"
	| "network"
	| "upstream"
	| "not_found"
	| "forbidden"
	| "validation"
	| "no_commits"
	| "pull_request_exists";

/** Service error carrying the HTTP status the route layer should answer with. */
export class GithubError extends Error {
	constructor(
		readonly status: number,
		readonly code: GithubErrorCode,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "GithubError";
	}
}
