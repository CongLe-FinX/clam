import { openDatabase, type ClamDb } from "@clam/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGithubService, type GithubService } from "../src/index.ts";
import { fakeFetch, memorySecrets } from "./helpers.ts";

const TOKEN = "gho_supersecrettoken0123456789";
const rawPull = (over: Record<string, unknown> = {}) => ({
	number: 7,
	title: "Add feature",
	body: "details",
	state: "open",
	draft: true,
	merged: false,
	html_url: "https://github.com/octo/r/pull/7",
	head: { ref: "feature", sha: "abc123" },
	base: { ref: "main" },
	user: { login: "octo" },
	mergeable: null,
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-02T00:00:00Z",
	...over,
});

let db: ClamDb;
let secrets: ReturnType<typeof memorySecrets>;
beforeEach(() => {
	db = openDatabase({ file: ":memory:" });
	secrets = memorySecrets();
});
afterEach(() => db.$client.close());

const userRoutes = {
	"GET https://api.github.com/user/emails": { json: [{ email: "o@example.com", primary: true, verified: true }] },
	"GET https://api.github.com/user": { json: { id: 4242, login: "octo", name: "Octo Cat", email: null, avatar_url: "a" }, headers: { "x-oauth-scopes": "repo, read:user, user:email" } },
};

async function setup(routes: Parameters<typeof fakeFetch>[0]) {
	const ff = fakeFetch({ ...routes, ...userRoutes });
	const service: GithubService = createGithubService({ db, secrets, fetch: ff.fn, publish: () => {}, newId: () => "acc1", runGh: async () => ({ code: 0, stdout: `${TOKEN}\n`, stderr: "  - Token scopes: 'repo'\n", missing: false }) });
	const account = await service.importFromGhCli();
	ff.calls.length = 0;
	return { service, ff, account };
}

describe("pull requests", () => {
	it("creates a draft PR with the expected request and maps the result", async () => {
		const { service, ff, account } = await setup({ "POST https://api.github.com/repos/octo/r/pulls": { status: 201, json: rawPull() } });
		const pr = await service.createPullRequest(account.id, "octo", "r", { title: "Add feature", body: "details", head: "feature", base: "main", draft: true });
		expect(pr).toMatchObject({ number: 7, state: "open", draft: true, head: "feature", base: "main", author: "octo", mergeable: null, checks: null, htmlUrl: "https://github.com/octo/r/pull/7" });
		const call = ff.calls[0]!;
		expect(JSON.parse(call.body!)).toEqual({ title: "Add feature", body: "details", head: "feature", base: "main", draft: true });
		expect(call.auth).toBe(`Bearer ${TOKEN}`);
	});

	it("maps 'No commits between' to no_commits (422)", async () => {
		const { service, account } = await setup({
			"POST https://api.github.com/repos/octo/r/pulls": { status: 422, json: { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "No commits between main and feature" }] } },
		});
		await expect(service.createPullRequest(account.id, "octo", "r", { title: "t", body: "", head: "feature", base: "main", draft: false })).rejects.toMatchObject({
			status: 422,
			code: "no_commits",
			message: expect.stringContaining("No commits between main and feature"),
		});
	});

	it("maps 'A pull request already exists' to pull_request_exists with the existing URL", async () => {
		const { service, ff, account } = await setup({
			"POST https://api.github.com/repos/octo/r/pulls": { status: 422, json: { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "A pull request already exists for octo:feature." }] } },
			"GET https://api.github.com/repos/octo/r/pulls?state=open&head=octo%3Afeature": { json: [rawPull()] },
		});
		const err = await service.createPullRequest(account.id, "octo", "r", { title: "t", body: "", head: "feature", base: "main", draft: false }).catch((e: unknown) => e);
		expect(err).toMatchObject({ status: 422, code: "pull_request_exists", details: { url: "https://github.com/octo/r/pull/7" } });
		expect((err as Error).message).toContain("A pull request already exists for octo:feature.");
		expect((err as Error).message).toContain("https://github.com/octo/r/pull/7");
		expect(ff.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
	});

	it("surfaces SSO and scope 403s and 404s", async () => {
		const sso = await setup({
			"POST https://api.github.com/repos/org/r/pulls": { status: 403, json: { message: "Resource protected by organization SAML enforcement." }, headers: { "x-github-sso": "required; url=https://github.com/orgs/org/sso?authorization_request=1" } },
		});
		await expect(sso.service.createPullRequest(sso.account.id, "org", "r", { title: "t", body: "", head: "f", base: "main", draft: false })).rejects.toMatchObject({
			status: 403,
			code: "forbidden",
			message: expect.stringMatching(/Resource protected by organization SAML enforcement\..*single sign-on.*authorization_request=1/),
			details: { kind: "sso", ssoUrl: "https://github.com/orgs/org/sso?authorization_request=1" },
		});
		db.$client.close();
		db = openDatabase({ file: ":memory:" });
		secrets = memorySecrets();
		const scope = await setup({
			"POST https://api.github.com/repos/octo/r/pulls": { status: 403, json: { message: "Resource not accessible by personal access token" }, headers: { "x-oauth-scopes": "read:user", "x-accepted-oauth-scopes": "repo" } },
			"POST https://api.github.com/repos/octo/gone/pulls": { status: 404, json: { message: "Not Found" } },
		});
		await expect(scope.service.createPullRequest(scope.account.id, "octo", "r", { title: "t", body: "", head: "f", base: "main", draft: false })).rejects.toMatchObject({
			code: "forbidden",
			message: expect.stringContaining("Resource not accessible by personal access token (token scopes: read:user; accepted: repo)"),
			details: { kind: "scope" },
		});
		await expect(scope.service.createPullRequest(scope.account.id, "octo", "gone", { title: "t", body: "", head: "f", base: "main", draft: false })).rejects.toMatchObject({ status: 404, code: "not_found", message: expect.stringContaining("octo/gone") });
	});

	it("lists by state and marks merged PRs", async () => {
		const { service, ff, account } = await setup({
			"GET https://api.github.com/repos/octo/r/pulls?state=all": { json: [rawPull(), rawPull({ number: 8, state: "closed", merged_at: "2026-01-03T00:00:00Z" }), rawPull({ number: 9, state: "closed" })] },
		});
		const list = await service.listPullRequests(account.id, "octo", "r", "all");
		expect(list.map((p) => [p.number, p.state])).toEqual([[7, "open"], [8, "merged"], [9, "closed"]]);
		expect(ff.calls[0]!.url).toContain("state=all");
	});

	it("getPullRequest combines mergeable with statuses and check runs", async () => {
		const { service, account } = await setup({
			"GET https://api.github.com/repos/octo/r/pulls/7": { json: rawPull({ mergeable: true }) },
			"GET https://api.github.com/repos/octo/r/commits/abc123/status": { json: { state: "success", total_count: 1 } },
			"GET https://api.github.com/repos/octo/r/commits/abc123/check-runs": { json: { check_runs: [{ status: "completed", conclusion: "success" }, { status: "in_progress", conclusion: null }] } },
		});
		expect(await service.getPullRequest(account.id, "octo", "r", 7)).toMatchObject({ number: 7, mergeable: true, checks: "pending" });
	});

	it("getPullRequest reports failure, neutral and unreadable checks", async () => {
		const failing = await setup({
			"GET https://api.github.com/repos/octo/r/pulls/7": { json: rawPull() },
			"GET https://api.github.com/repos/octo/r/commits/abc123/status": { json: { state: "pending", total_count: 0 } },
			"GET https://api.github.com/repos/octo/r/commits/abc123/check-runs": { json: { check_runs: [{ status: "completed", conclusion: "failure" }] } },
		});
		expect((await failing.service.getPullRequest(failing.account.id, "octo", "r", 7)).checks).toBe("failure");
		db.$client.close();
		db = openDatabase({ file: ":memory:" });
		secrets = memorySecrets();
		const none = await setup({
			"GET https://api.github.com/repos/octo/r/pulls/7": { json: rawPull() },
			"GET https://api.github.com/repos/octo/r/commits/abc123/status": { json: { state: "pending", total_count: 0 } },
			"GET https://api.github.com/repos/octo/r/commits/abc123/check-runs": { json: { check_runs: [] } },
		});
		expect((await none.service.getPullRequest(none.account.id, "octo", "r", 7)).checks).toBe("neutral");
		db.$client.close();
		db = openDatabase({ file: ":memory:" });
		secrets = memorySecrets();
		const hidden = await setup({
			"GET https://api.github.com/repos/octo/r/pulls/7": { json: rawPull() },
			"GET https://api.github.com/repos/octo/r/commits/abc123/status": { status: 403, json: { message: "forbidden" } },
			"GET https://api.github.com/repos/octo/r/commits/abc123/check-runs": { status: 404, json: { message: "Not Found" } },
		});
		expect((await hidden.service.getPullRequest(hidden.account.id, "octo", "r", 7)).checks).toBeNull();
	});
});

describe("git credentials and identity", () => {
	it("tokenFor returns the stored token; unknown accounts and missing tokens fail", async () => {
		const { service, account } = await setup({});
		expect(await service.tokenFor(account.id)).toBe(TOKEN);
		await expect(service.tokenFor("nope")).rejects.toMatchObject({ code: "account_not_found" });
		secrets.map.clear();
		await expect(service.tokenFor(account.id)).rejects.toMatchObject({ code: "token_invalid" });
	});

	it("derives the commit identity: verified primary email with the email scope", async () => {
		const { service, account } = await setup({});
		expect(await service.commitIdentity(account.id)).toEqual({ name: "Octo Cat", email: "o@example.com" });
	});

	it("falls back to the noreply address (numeric id) without the email scope, fetching the id once", async () => {
		const ff = fakeFetch({
			"GET https://api.github.com/user/emails": { status: 403, json: { message: "forbidden" } },
			"GET https://api.github.com/user": { json: { id: 4242, login: "octo", name: null, email: "public@example.com", avatar_url: "a" }, headers: { "x-oauth-scopes": "repo" } },
		});
		const service = createGithubService({ db, secrets, fetch: ff.fn, publish: () => {}, newId: () => "acc1", runGh: async () => ({ code: 0, stdout: `${TOKEN}\n`, stderr: "  - Token scopes: 'repo'\n", missing: false }) });
		const account = await service.importFromGhCli();
		ff.calls.length = 0;
		expect(await service.commitIdentity(account.id)).toEqual({ name: "octo", email: "4242+octo@users.noreply.github.com" });
		expect(await service.commitIdentity(account.id)).toEqual({ name: "octo", email: "4242+octo@users.noreply.github.com" });
		expect(ff.calls.filter((c) => c.url.endsWith("/user"))).toHaveLength(1);
	});
});
