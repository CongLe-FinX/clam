import { GithubError } from "./errors.ts";

export type FetchFn = typeof fetch;

export const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "CL-Agent-Mesh";
const REQUEST_TIMEOUT_MS = 15_000;

export interface ApiResponse<T> {
	status: number;
	headers: Headers;
	body: T;
}

export interface RateLimit {
	limit: number | null;
	remaining: number | null;
	/** Epoch seconds when the window resets. */
	resetAt: number | null;
}

export function readRateLimit(headers: Headers): RateLimit {
	const n = (name: string) => {
		const v = headers.get(name);
		return v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
	};
	return { limit: n("x-ratelimit-limit"), remaining: n("x-ratelimit-remaining"), resetAt: n("x-ratelimit-reset") };
}

/** Parses the `x-oauth-scopes` header ("repo, read:user") into a list. */
export function parseScopes(headers: Headers): string[] | null {
	const raw = headers.get("x-oauth-scopes");
	if (raw === null) return null; // fine-grained / GitHub App tokens carry no scope header
	return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function hasNextPage(headers: Headers): boolean {
	return /<[^>]+>;\s*rel="next"/.test(headers.get("link") ?? "");
}

/**
 * Thin GitHub REST wrapper. Never logs or echoes the token. Maps failures onto `GithubError`:
 * network/timeouts → 502 `network`, 401 → 409 `token_invalid`, exhausted rate limit → 429 `rate_limited`,
 * other non-2xx → the upstream status with GitHub's own message. 404 and 403 (non rate-limit) are returned
 * to the caller when `allowStatus` lists them so permission checks can explain themselves.
 */
export async function githubRequest<T>(
	fetchFn: FetchFn,
	token: string,
	path: string,
	opts: { allowStatus?: readonly number[]; signal?: AbortSignal; method?: "GET" | "POST" | "PATCH"; json?: unknown } = {},
): Promise<ApiResponse<T>> {
	let res: Response;
	try {
		res = await fetchFn(`${GITHUB_API}${path}`, {
			method: opts.method ?? "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": API_VERSION,
				"User-Agent": USER_AGENT,
				...(opts.json !== undefined && { "Content-Type": "application/json" }),
			},
			...(opts.json !== undefined && { body: JSON.stringify(opts.json) }),
			signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (err) {
		throw new GithubError(502, "network", `Could not reach GitHub: ${describeNetworkError(err)}`);
	}

	let body: unknown = null;
	const text = await res.text().catch(() => "");
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = null;
		}
	}
	if (res.ok || opts.allowStatus?.includes(res.status)) {
		return { status: res.status, headers: res.headers, body: body as T };
	}

	const message = (body as { message?: string } | null)?.message ?? res.statusText ?? "request failed";
	const rate = readRateLimit(res.headers);
	const retryAfter = Number(res.headers.get("retry-after"));
	if (res.status === 429 || (res.status === 403 && (rate.remaining === 0 || Number.isFinite(retryAfter) && res.headers.has("retry-after")))) {
		const resetAt = res.headers.has("retry-after") && Number.isFinite(retryAfter)
			? Math.floor(Date.now() / 1000) + retryAfter
			: rate.resetAt;
		throw new GithubError(429, "rate_limited", `GitHub rate limit reached${resetAt ? `; retry after ${new Date(resetAt * 1000).toISOString()}` : ""}`, {
			resetAt: resetAt ? new Date(resetAt * 1000).toISOString() : null,
			limit: rate.limit,
		});
	}
	if (res.status === 401) throw new GithubError(409, "token_invalid", "GitHub rejected the stored token (revoked or expired). Reconnect the account.");
	throw new GithubError(res.status >= 500 ? 502 : res.status, res.status === 404 ? "not_found" : res.status === 403 ? "forbidden" : "upstream", `GitHub: ${message}`, {
		status: res.status,
		documentationUrl: (body as { documentation_url?: string } | null)?.documentation_url,
		/** GitHub's per-field validation errors (422), verbatim. */
		errors: (body as { errors?: unknown } | null)?.errors,
		/** `x-github-sso` header: SAML SSO authorization is required (`required; url=...`). */
		sso: res.headers.get("x-github-sso"),
		/** Scopes the token has vs scopes the endpoint accepts (classic tokens). */
		tokenScopes: res.headers.get("x-oauth-scopes"),
		acceptedScopes: res.headers.get("x-accepted-oauth-scopes"),
	});
}

export function describeNetworkError(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === "TimeoutError" || err.name === "AbortError") return "request timed out";
		const cause = (err as { cause?: { code?: string; message?: string } }).cause;
		return cause?.code ?? cause?.message ?? err.message;
	}
	return String(err);
}
