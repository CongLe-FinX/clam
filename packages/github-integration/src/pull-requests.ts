import type { PullRequest } from "@clam/contracts";
import { type FetchFn, githubRequest } from "./api-client.ts";
import { GithubError } from "./errors.ts";

/** GitHub's raw pull request object (only the fields we read). */
interface RawPull {
	number: number;
	title: string;
	body: string | null;
	state: "open" | "closed";
	draft?: boolean;
	merged?: boolean;
	merged_at?: string | null;
	html_url: string;
	head: { ref: string; sha: string };
	base: { ref: string };
	user: { login: string } | null;
	mergeable?: boolean | null;
	created_at: string;
	updated_at: string;
}

interface RawCombinedStatus {
	state?: "failure" | "pending" | "success" | "error";
	total_count?: number;
}
interface RawCheckRuns {
	check_runs?: Array<{ status: string; conclusion: string | null }>;
}

export interface CreatePullInput {
	title: string;
	body: string;
	/** Source branch (same repository). */
	head: string;
	base: string;
	draft: boolean;
}

const repoPath = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export function toPullRequest(raw: RawPull, extra: { mergeable?: boolean | null; checks?: PullRequest["checks"] } = {}): PullRequest {
	return {
		number: raw.number,
		title: raw.title,
		body: raw.body ?? "",
		state: raw.merged === true || raw.merged_at ? "merged" : raw.state,
		draft: raw.draft === true,
		htmlUrl: raw.html_url,
		head: raw.head.ref,
		base: raw.base.ref,
		author: raw.user?.login ?? "ghost",
		mergeable: extra.mergeable ?? raw.mergeable ?? null,
		checks: extra.checks ?? null,
		createdAt: raw.created_at,
		updatedAt: raw.updated_at,
	};
}

/** The extras `githubRequest` attaches to a failed response's `details`. */
interface FailureDetails {
	errors?: unknown;
	sso?: string | null;
	tokenScopes?: string | null;
	acceptedScopes?: string | null;
}

function failureDetails(err: GithubError): FailureDetails {
	// `details` is produced by `githubRequest` in this package with exactly these optional fields.
	return typeof err.details === "object" && err.details !== null ? (err.details as FailureDetails) : {};
}

/** Messages GitHub attaches to a 422, verbatim. */
function validationMessages(err: GithubError): string[] {
	const { errors } = failureDetails(err);
	if (!Array.isArray(errors)) return [];
	return errors
		.map((e: unknown) => (typeof e === "string" ? e : typeof e === "object" && e !== null && "message" in e ? String(e.message) : ""))
		.filter(Boolean);
}

/**
 * Normalizes GitHub's PR-creation failures: 422 "No commits between" → `no_commits`; 422 "A pull request already
 * exists" → `pull_request_exists` (with the existing PR's URL when it can be found); 403 keeps GitHub's wording and
 * adds the SSO authorization URL / scope hint; 404 explains that GitHub hides inaccessible repositories.
 */
async function explainCreateFailure(err: unknown, fetchFn: FetchFn, token: string, owner: string, repo: string, head: string): Promise<GithubError> {
	if (!(err instanceof GithubError)) return err as GithubError;
	const details = failureDetails(err);
	if (err.status === 422) {
		const messages = validationMessages(err);
		const detail = messages.join("; ");
		if (messages.some((m) => /no commits between/i.test(m)) || /no commits between/i.test(err.message)) {
			return new GithubError(422, "no_commits", `GitHub: ${detail || err.message}`, err.details);
		}
		const exists = messages.find((m) => /pull request already exists/i.test(m));
		if (exists || /pull request already exists/i.test(err.message)) {
			let url: string | null = null;
			try {
				const found = await githubRequest<RawPull[]>(fetchFn, token, `${repoPath(owner, repo)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&per_page=1`);
				url = found.body?.[0]?.html_url ?? null;
			} catch {
				// The existing PR's URL is a courtesy; the refusal stands without it.
			}
			return new GithubError(422, "pull_request_exists", `GitHub: ${exists ?? err.message}${url ? ` (${url})` : ""}`, { ...details, url });
		}
		return new GithubError(422, "validation", `GitHub: ${detail || err.message}`, err.details);
	}
	if (err.status === 403) {
		const sso = details.sso?.match(/url=(\S+)/)?.[1];
		if (details.sso) {
			return new GithubError(403, "forbidden", `${err.message} — SAML single sign-on authorization is required for this token${sso ? `: ${sso}` : ""}`, { ...details, kind: "sso", ssoUrl: sso ?? null });
		}
		const scopeHint =
			details.acceptedScopes && details.tokenScopes !== null && details.tokenScopes !== undefined
				? ` (token scopes: ${details.tokenScopes || "none"}; accepted: ${details.acceptedScopes})`
				: "";
		return new GithubError(403, "forbidden", `${err.message}${scopeHint}`, { ...details, kind: scopeHint ? "scope" : "permission" });
	}
	if (err.status === 404) {
		return new GithubError(404, "not_found", `${err.message} — the repository ${owner}/${repo} does not exist or this account cannot access it (GitHub answers 404 for repositories you cannot see)`, err.details);
	}
	return err;
}

export async function createPullRequest(fetchFn: FetchFn, token: string, owner: string, repo: string, input: CreatePullInput): Promise<PullRequest> {
	try {
		const res = await githubRequest<RawPull>(fetchFn, token, `${repoPath(owner, repo)}/pulls`, {
			method: "POST",
			json: { title: input.title, body: input.body, head: input.head, base: input.base, draft: input.draft },
		});
		return toPullRequest(res.body);
	} catch (err) {
		throw await explainCreateFailure(err, fetchFn, token, owner, repo, input.head);
	}
}

export async function listPullRequests(
	fetchFn: FetchFn,
	token: string,
	owner: string,
	repo: string,
	state: "open" | "closed" | "all",
): Promise<PullRequest[]> {
	const res = await githubRequest<RawPull[]>(fetchFn, token, `${repoPath(owner, repo)}/pulls?state=${state}&sort=updated&direction=desc&per_page=50`);
	return (res.body ?? []).map((raw) => toPullRequest(raw));
}

/** The pull request plus `mergeable` (GitHub computes it lazily: null while pending) and the head commit's combined checks. */
export async function getPullRequest(fetchFn: FetchFn, token: string, owner: string, repo: string, number: number): Promise<PullRequest> {
	const res = await githubRequest<RawPull>(fetchFn, token, `${repoPath(owner, repo)}/pulls/${number}`);
	const raw = res.body;
	const checks = await combinedChecks(fetchFn, token, owner, repo, raw.head.sha);
	return toPullRequest(raw, { mergeable: raw.mergeable ?? null, checks });
}

const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);

/** Merges legacy commit statuses and check runs; null when neither is readable with this token. */
async function combinedChecks(fetchFn: FetchFn, token: string, owner: string, repo: string, sha: string): Promise<PullRequest["checks"]> {
	const base = `${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}`;
	const [status, runs] = await Promise.all([
		githubRequest<RawCombinedStatus>(fetchFn, token, `${base}/status`, { allowStatus: [403, 404] }).catch(() => null),
		githubRequest<RawCheckRuns>(fetchFn, token, `${base}/check-runs?per_page=100`, { allowStatus: [403, 404] }).catch(() => null),
	]);
	const statusOk = status !== null && status.status === 200;
	const runsOk = runs !== null && runs.status === 200;
	if (!statusOk && !runsOk) return null;

	let failure = false;
	let pending = false;
	let success = false;
	if (statusOk && (status.body.total_count ?? 0) > 0) {
		const state = status.body.state;
		if (state === "failure" || state === "error") failure = true;
		else if (state === "pending") pending = true;
		else if (state === "success") success = true;
	}
	if (runsOk) {
		for (const run of runs.body.check_runs ?? []) {
			if (run.status !== "completed") pending = true;
			else if (run.conclusion && FAILING_CONCLUSIONS.has(run.conclusion)) failure = true;
			else if (run.conclusion === "success") success = true;
		}
	}
	if (failure) return "failure";
	if (pending) return "pending";
	return success ? "success" : "neutral";
}
