import { openDatabase, type ClamDb } from "@clam/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGithubService, parseGhStatusScopes, type GithubService } from "../src/index.ts";
import { fakeFetch, memorySecrets } from "./helpers.ts";

const user = (login: string, id: number) => ({ id, login, name: `${login} name`, email: null, avatar_url: `https://avatars/${login}` });
const emails = [{ email: "o@example.com", primary: true, verified: true }];
const repo = (id: number, full: string, push = true) => ({
	id,
	name: full.split("/")[1],
	full_name: full,
	private: false,
	description: `desc of ${full}`,
	html_url: `https://github.com/${full}`,
	default_branch: "main",
	pushed_at: "2026-01-01T00:00:00Z",
	owner: { login: full.split("/")[0] },
	permissions: { pull: true, push, admin: false },
});

let db: ClamDb;
let secrets: ReturnType<typeof memorySecrets>;
beforeEach(() => {
	db = openDatabase({ file: ":memory:" });
	secrets = memorySecrets();
});
afterEach(() => db.$client.close());

function make(routes: Parameters<typeof fakeFetch>[0], extra: { ghToken?: string | null } = {}) {
	const ff = fakeFetch(routes);
	let n = 0;
	const events: unknown[] = [];
	const service: GithubService = createGithubService({
		db,
		secrets,
		fetch: ff.fn,
		publish: (t, e) => events.push([t, e]),
		newId: () => `acc${++n}`,
		runGh: async (args) =>
			args[1] === "token"
				? extra.ghToken
					? { code: 0, stdout: `${extra.ghToken}\n`, stderr: "", missing: false }
					: { code: 1, stdout: "", stderr: "not logged in", missing: false }
				: { code: extra.ghToken ? 0 : 1, stdout: "", stderr: "  - Token scopes: 'gist', 'read:org', 'repo'\n", missing: false },
	});
	return { service, ff, events };
}

describe("accounts", () => {
	it("imports from gh, stores the token only in the secret store, and uses gh's scopes when GitHub sends none", async () => {
		const { service } = make(
			{ "GET https://api.github.com/user/emails": { json: emails }, "GET https://api.github.com/user": { json: user("octo", 1) } },
			{ ghToken: "gho_secrettoken" },
		);
		const account = await service.importFromGhCli();
		expect(account).toMatchObject({ login: "octo", email: "o@example.com", source: "gh-cli", isDefault: true, status: "connected", scopes: ["gist", "read:org", "repo"] });
		expect(secrets.map.get("github.token.acc1")).toBe("gho_secrettoken");
		const raw = JSON.stringify(db.$client.prepare("select * from github_connections").all());
		expect(raw).not.toContain("gho_secrettoken");
		expect(raw).toContain("github.token.acc1");
	});

	it("fails clearly when gh is not logged in", async () => {
		const { service } = make({}, { ghToken: null });
		await expect(service.importFromGhCli()).rejects.toMatchObject({ code: "gh_unavailable" });
	});

	it("keeps exactly one default across connect, switch and disconnect; re-linking a login reuses its row", async () => {
		const logins = ["alice", "bob", "carol"];
		let i = 0;
		const { service } = make({
			"GET https://api.github.com/user/emails": { json: [] },
			"GET https://api.github.com/user": () => ({ json: user(logins[i++ % 3]!, i), headers: { "x-oauth-scopes": "repo, read:user" } }),
		}, { ghToken: "t" });
		const a = await service.importFromGhCli();
		const b = await service.importFromGhCli();
		const c = await service.importFromGhCli();
		expect([a, b, c].map((x) => x.login)).toEqual(["alice", "bob", "carol"]);
		expect(service.listAccounts().filter((x) => x.isDefault).map((x) => x.login)).toEqual(["alice"]);
		expect(a.scopes).toEqual(["repo", "read:user"]);

		expect(service.setDefault(c.id).filter((x) => x.isDefault).map((x) => x.login)).toEqual(["carol"]);
		await service.disconnect(c.id);
		expect(secrets.map.has(`github.token.${c.id}`)).toBe(false);
		const left = service.listAccounts();
		expect(left).toHaveLength(2);
		expect(left.filter((x) => x.isDefault)).toHaveLength(1);

		const again = await service.importFromGhCli(); // "alice" again → same id
		expect(again.id).toBe(a.id);
		expect(service.listAccounts()).toHaveLength(2);
	});

	it("verify marks an account invalid on 401 and connected again after a good token", async () => {
		let status = 200;
		const { service } = make({
			"GET https://api.github.com/user/emails": { json: [] },
			"GET https://api.github.com/user": () => (status === 200 ? { json: user("octo", 1) } : { status, json: { message: "Bad credentials" } }),
		}, { ghToken: "t" });
		const acc = await service.importFromGhCli();
		status = 401;
		expect(await service.verify(acc.id)).toMatchObject({ status: "invalid" });
		status = 200;
		expect(await service.verify(acc.id)).toMatchObject({ status: "connected" });
	});

	it("persists the OAuth client id in settings (JSON) and reports config", async () => {
		const { service } = make({}, { ghToken: "t" });
		expect(await service.getConfig()).toEqual({ clientId: null, ghCliAvailable: true, scopes: ["repo", "read:user", "user:email"] });
		await service.setClientId("Iv1.abc");
		expect((await service.getConfig()).clientId).toBe("Iv1.abc");
		expect(db.$client.prepare("select value from settings where key='github.clientId'").get()).toEqual({ value: '"Iv1.abc"' });
		await service.setClientId(null);
		expect((await service.getConfig()).clientId).toBeNull();
		await expect(service.startDeviceFlow()).rejects.toMatchObject({ code: "not_configured" });
	});
});

describe("repositories", () => {
	async function connected(extraRoutes: Parameters<typeof fakeFetch>[0]) {
		const ctx = make({
			"GET https://api.github.com/user/emails": { json: [] },
			"GET https://api.github.com/user/repos": { json: [] },
			...extraRoutes,
			"GET https://api.github.com/user": { json: user("octo", 1), headers: { "x-oauth-scopes": "repo" } },
		}, { ghToken: "tok" });
		const account = await ctx.service.importFromGhCli();
		return { ...ctx, account };
	}

	it("lists a page sorted by push date, reports the next page and remembers repos", async () => {
		const { service, ff, account } = await connected({
			"GET https://api.github.com/user/repos": { json: [repo(10, "octo/a"), repo(11, "org/b", false)], headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } },
		});
		const res = await service.listRepos(account.id, { page: 1 });
		expect(res.nextPage).toBe(2);
		expect(res.items.map((r) => r.fullName)).toEqual(["octo/a", "org/b"]);
		expect(res.items[1]?.permissions).toEqual({ pull: true, push: false, admin: false });
		const url = ff.calls.find((c) => c.url.includes("/user/repos"))!.url;
		expect(url).toContain("affiliation=owner,collaborator,organization_member");
		expect(url).toContain("sort=pushed");
		expect(db.$client.prepare("select count(*) n from github_repositories where account_id = ?").get(account.id)).toEqual({ n: 2 });
	});

	it("filters by query across pages and caches the scan", async () => {
		const { service, ff, account } = await connected({
			"GET https://api.github.com/user/repos": (n) =>
				n === 0
					? { json: [repo(1, "octo/alpha"), repo(2, "octo/beta")], headers: { link: '<x>; rel="next"' } }
					: { json: [repo(3, "org/alphabet")] },
		});
		const first = await service.listRepos(account.id, { q: "ALPHA" });
		expect(first.items.map((r) => r.fullName)).toEqual(["octo/alpha", "org/alphabet"]);
		expect(first.nextPage).toBeNull();
		const calls = ff.calls.filter((c) => c.url.includes("/user/repos")).length;
		await service.listRepos(account.id, { q: "beta" });
		expect(ff.calls.filter((c) => c.url.includes("/user/repos")).length).toBe(calls);
	});

	it("maps permissions onto clone/fetch/push/createPr", async () => {
		const { service, account } = await connected({
			"GET https://api.github.com/repos/octo/rw": { json: repo(1, "octo/rw", true) },
			"GET https://api.github.com/repos/octo/ro": { json: repo(2, "octo/ro", false) },
		});
		expect(await service.checkRepo(account.id, "octo", "rw")).toMatchObject({ repo: "octo/rw", clone: true, fetch: true, push: true, createPr: true, details: undefined });
		const ro = await service.checkRepo(account.id, "octo", "ro");
		expect(ro).toMatchObject({ clone: true, fetch: true, push: false, createPr: true });
		expect(ro.details).toContain("Read-only");
	});

	it("explains 404 and 403 and surfaces SSO", async () => {
		const { service, account } = await connected({
			"GET https://api.github.com/repos/octo/missing": { status: 404, json: { message: "Not Found" } },
			"GET https://api.github.com/repos/org/sso": { status: 403, json: { message: "Resource protected by organization SAML enforcement." }, headers: { "x-github-sso": "required; url=https://github.com/orgs/org/sso" } },
			"GET https://api.github.com/repos/org/blocked": { status: 403, json: { message: "Repository access blocked" } },
		});
		const nf = await service.checkRepo(account.id, "octo", "missing");
		expect(nf).toMatchObject({ clone: false, push: false });
		expect(nf.details).toContain("not found");
		expect((await service.checkRepo(account.id, "org", "sso")).details).toContain("single sign-on");
		expect((await service.checkRepo(account.id, "org", "blocked")).details).toContain("Repository access blocked");
	});

	it("turns rate limits, 401 and network failures into typed errors", async () => {
		let mode: "rate" | "401" | "net" = "rate";
		const { service, account } = await connected({
			"GET https://api.github.com/user/repos": () =>
				mode === "rate"
					? { status: 403, json: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" } }
					: mode === "401"
						? { status: 401, json: { message: "Bad credentials" } }
						: new TypeError("fetch failed"),
		});
		await expect(service.listRepos(account.id, {})).rejects.toMatchObject({ status: 429, code: "rate_limited", details: { resetAt: "2030-01-01T00:00:00.000Z" } });
		mode = "net";
		await expect(service.listRepos(account.id, {})).rejects.toMatchObject({ status: 502, code: "network" });
		mode = "401";
		await expect(service.listRepos(account.id, {})).rejects.toMatchObject({ code: "token_invalid" });
		expect(service.listAccounts()[0]?.status).toBe("invalid");
	});
});

describe("gh helpers", () => {
	it("parses scopes from `gh auth status`", () => {
		expect(parseGhStatusScopes("  - Token scopes: 'gist', 'read:org', 'repo'\n")).toEqual(["gist", "read:org", "repo"]);
		expect(parseGhStatusScopes("nothing")).toEqual([]);
	});
});
