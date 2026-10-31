import { randomUUID } from "node:crypto";
import type {
	DeviceFlowStart,
	DeviceFlowStatus,
	GithubAccount,
	GithubConfig,
	GithubRepo,
	PullRequest,
	RepoPermissionCheck,
} from "@clam/contracts";
import { type ClamDb, githubConnections, githubRepositories, settings } from "@clam/database";
import type { SecretStore } from "@clam/secret-store";
import { asc, eq, sql } from "drizzle-orm";
import { type FetchFn, githubRequest, hasNextPage, parseScopes } from "./api-client.ts";
import { DEVICE_SCOPES, DeviceFlowManager } from "./device-flow.ts";
import { GithubError } from "./errors.ts";
import { createPullRequest, getPullRequest, listPullRequests, type CreatePullInput } from "./pull-requests.ts";
import { ghLoggedIn, createGhRunner, readGhCredentials, type RunGh } from "./gh-cli.ts";

export const CLIENT_ID_SETTING = "github.clientId";
const REPO_PAGE_SIZE = 30;
const REPO_LIST_CACHE_TTL_MS = 60_000;
/** Searching scans the account's repositories; stop after this many 100-item pages. */
const MAX_SCAN_PAGES = 10;
const GH_AVAILABILITY_TTL_MS = 30_000;
const AFFILIATION = "owner,collaborator,organization_member";

export interface GithubServiceDeps {
	db: ClamDb;
	secrets: SecretStore;
	publish: (topic: string, event: unknown) => void;
	fetch?: FetchFn;
	runGh?: RunGh;
	now?: () => number;
	newId?: () => string;
}

export interface GithubService {
	getConfig(): Promise<GithubConfig>;
	setClientId(clientId: string | null): Promise<GithubConfig>;
	startDeviceFlow(): Promise<DeviceFlowStart>;
	deviceFlowStatus(flowId: string): DeviceFlowStatus;
	importFromGhCli(): Promise<GithubAccount>;
	listAccounts(): GithubAccount[];
	setDefault(id: string): GithubAccount[];
	verify(id: string): Promise<GithubAccount>;
	disconnect(id: string): Promise<void>;
	listRepos(id: string, opts: { q?: string; page?: number }): Promise<{ items: GithubRepo[]; nextPage: number | null }>;
	checkRepo(id: string, owner: string, repo: string): Promise<RepoPermissionCheck>;
	/** Repository metadata as the account sees it (404/403 surface as `GithubError`). */
	getRepository(id: string, owner: string, repo: string): Promise<GithubRepo>;
	/**
	 * The account's stored token. **Server-internal**: the only legitimate use is building a `GitAuth` whose token is
	 * handed to the git askpass broker. Never return it over HTTP, log it, or put it in argv/env/URLs/files.
	 */
	tokenFor(id: string): Promise<string>;
	/** Commit identity derived from the account: `<id>+<login>@users.noreply.github.com` unless a primary verified email is readable (`user:email` scope). */
	commitIdentity(id: string): Promise<{ name: string; email: string }>;
	createPullRequest(id: string, owner: string, repo: string, input: CreatePullInput): Promise<PullRequest>;
	listPullRequests(id: string, owner: string, repo: string, state: "open" | "closed" | "all"): Promise<PullRequest[]>;
	getPullRequest(id: string, owner: string, repo: string, number: number): Promise<PullRequest>;
	dispose(): void;
}

type Row = typeof githubConnections.$inferSelect;

interface RawUser {
	id: number;
	login: string;
	name: string | null;
	email: string | null;
	avatar_url: string | null;
}
interface RawEmail {
	email: string;
	primary: boolean;
	verified: boolean;
}
interface RawRepo {
	id: number;
	name: string;
	full_name: string;
	private: boolean;
	description: string | null;
	html_url: string;
	default_branch?: string;
	pushed_at: string | null;
	owner: { login: string };
	permissions?: { pull?: boolean; push?: boolean; admin?: boolean };
}

export function createGithubService(deps: GithubServiceDeps): GithubService {
	const { db, secrets, publish } = deps;
	const fetchFn: FetchFn = deps.fetch ?? fetch;
	const runGh = deps.runGh ?? createGhRunner();
	const now = deps.now ?? Date.now;
	const newId = deps.newId ?? randomUUID;
	const credentialRef = (id: string) => `github.token.${id}`;

	let ghCache: { at: number; value: boolean } | null = null;
	const repoCache = new Map<string, { at: number; items: GithubRepo[] }>();

	// ---- rows ------------------------------------------------------------------------------

	const toAccount = (r: Row): GithubAccount => ({
		id: r.id,
		login: r.login,
		name: r.name,
		email: r.email,
		avatarUrl: r.avatarUrl,
		scopes: parseJsonArray(r.scopes),
		source: r.source === "gh-cli" ? "gh-cli" : "oauth-device",
		isDefault: r.isDefault,
		status: r.status === "connected" || r.status === "invalid" ? r.status : "unknown",
		lastVerifiedAt: r.lastVerifiedAt,
		createdAt: r.createdAt,
	});

	const allRows = (): Row[] => db.select().from(githubConnections).orderBy(asc(githubConnections.createdAt), asc(githubConnections.login)).all();
	const getRow = (id: string): Row => {
		const row = db.select().from(githubConnections).where(eq(githubConnections.id, id)).get();
		if (!row) throw new GithubError(404, "account_not_found", "GitHub account not found.");
		return row;
	};
	const setStatus = (id: string, status: "connected" | "invalid") => {
		db.update(githubConnections).set({ status }).where(eq(githubConnections.id, id)).run();
	};

	async function readToken(row: Row): Promise<string> {
		const token = await secrets.get(row.credentialRef);
		if (!token) {
			setStatus(row.id, "invalid");
			throw new GithubError(409, "token_invalid", "The stored GitHub token is missing. Reconnect the account.");
		}
		return token;
	}

	/** Runs an API call for an account; a 401 marks the account `invalid` before the error propagates. */
	async function withAccount<T>(id: string, fn: (token: string, row: Row) => Promise<T>): Promise<T> {
		const row = getRow(id);
		const token = await readToken(row);
		try {
			return await fn(token, row);
		} catch (err) {
			if (err instanceof GithubError && err.code === "token_invalid") setStatus(id, "invalid");
			throw err;
		}
	}

	// ---- connecting accounts ---------------------------------------------------------------

	/** Validates a token against `/user`, stores it in the secret store and upserts the account row. */
	async function connectToken(token: string, source: "oauth-device" | "gh-cli", hintScopes: string[]): Promise<GithubAccount> {
		const userRes = await githubRequest<RawUser>(fetchFn, token, "/user");
		const user = userRes.body;
		const scopes = parseScopes(userRes.headers) ?? hintScopes;
		const email = await primaryEmail(token, user);

		const existing = allRows().find((r) => r.login.toLowerCase() === user.login.toLowerCase());
		const id = existing?.id ?? newId();
		const ref = credentialRef(id);
		await secrets.set(ref, token);
		const iso = new Date(now()).toISOString();
		try {
			const values = {
				login: user.login,
				name: user.name,
				email,
				avatarUrl: user.avatar_url,
				scopes: JSON.stringify(scopes),
				source,
				status: "connected",
				credentialRef: ref,
				lastVerifiedAt: iso,
			};
			db.transaction((tx) => {
				if (existing) {
					tx.update(githubConnections).set(values).where(eq(githubConnections.id, id)).run();
				} else {
					const first = tx.select({ n: sql<number>`count(*)` }).from(githubConnections).get()?.n === 0;
					tx.insert(githubConnections).values({ id, ...values, isDefault: first, createdAt: iso }).run();
				}
			});
		} catch (err) {
			if (!existing) await secrets.delete(ref).catch(() => {});
			throw err;
		}
		repoCache.delete(id);
		return toAccount(getRow(id));
	}

	async function primaryEmail(token: string, user: RawUser): Promise<string | null> {
		try {
			const res = await githubRequest<RawEmail[]>(fetchFn, token, "/user/emails", { allowStatus: [403, 404] });
			if (Array.isArray(res.body)) {
				const primary = res.body.find((e) => e.primary && e.verified) ?? res.body.find((e) => e.verified);
				if (primary) return primary.email;
			}
		} catch (err) {
			if (err instanceof GithubError && err.code === "token_invalid") throw err;
			// Emails are best effort: the token may lack `user:email`.
		}
		return user.email;
	}

	const flows = new DeviceFlowManager({
		fetch: fetchFn,
		completeLogin: (token, scopes) => connectToken(token, "oauth-device", scopes),
		publish,
		newId,
		now,
	});

	async function clientId(): Promise<string | null> {
		const row = db.select().from(settings).where(eq(settings.key, CLIENT_ID_SETTING)).get();
		if (!row) return null;
		try {
			const value = JSON.parse(row.value) as unknown;
			return typeof value === "string" && value.trim() ? value.trim() : null;
		} catch {
			return null;
		}
	}

	async function ghAvailable(): Promise<boolean> {
		if (ghCache && now() - ghCache.at < GH_AVAILABILITY_TTL_MS) return ghCache.value;
		const value = await ghLoggedIn(runGh);
		ghCache = { at: now(), value };
		return value;
	}

	// ---- public API ------------------------------------------------------------------------

	const service: GithubService = {
		async getConfig() {
			return { clientId: await clientId(), ghCliAvailable: await ghAvailable(), scopes: [...DEVICE_SCOPES] };
		},

		async setClientId(value) {
			if (value === null) {
				db.delete(settings).where(eq(settings.key, CLIENT_ID_SETTING)).run();
			} else {
				const json = JSON.stringify(value);
				db.insert(settings)
					.values({ key: CLIENT_ID_SETTING, value: json, updatedAt: new Date(now()).toISOString() })
					.onConflictDoUpdate({ target: settings.key, set: { value: json, updatedAt: new Date(now()).toISOString() } })
					.run();
			}
			return service.getConfig();
		},

		async startDeviceFlow() {
			const id = await clientId();
			if (!id) throw new GithubError(409, "not_configured", "Set the GitHub OAuth App client id first (Settings → GitHub).");
			return flows.start(id);
		},

		deviceFlowStatus(flowId) {
			const status = flows.status(flowId);
			if (!status) throw new GithubError(404, "flow_not_found", "Device flow not found or already cleaned up.");
			return status;
		},

		async importFromGhCli() {
			const creds = await readGhCredentials(runGh);
			ghCache = null;
			return connectToken(creds.token, "gh-cli", creds.scopes);
		},

		listAccounts() {
			return allRows().map(toAccount);
		},

		setDefault(id) {
			getRow(id);
			db.transaction((tx) => {
				tx.update(githubConnections).set({ isDefault: false }).run();
				tx.update(githubConnections).set({ isDefault: true }).where(eq(githubConnections.id, id)).run();
			});
			return service.listAccounts();
		},

		async verify(id) {
			const row = getRow(id);
			const token = await readToken(row);
			try {
				const res = await githubRequest<RawUser>(fetchFn, token, "/user");
				const scopes = parseScopes(res.headers) ?? parseJsonArray(row.scopes);
				db.update(githubConnections)
					.set({
						status: "connected",
						lastVerifiedAt: new Date(now()).toISOString(),
						scopes: JSON.stringify(scopes),
						name: res.body.name,
						avatarUrl: res.body.avatar_url,
					})
					.where(eq(githubConnections.id, id))
					.run();
			} catch (err) {
				if (!(err instanceof GithubError && err.code === "token_invalid")) throw err;
				db.update(githubConnections)
					.set({ status: "invalid", lastVerifiedAt: new Date(now()).toISOString() })
					.where(eq(githubConnections.id, id))
					.run();
			}
			return toAccount(getRow(id));
		},

		async disconnect(id) {
			const row = getRow(id);
			await secrets.delete(row.credentialRef);
			db.transaction((tx) => {
				tx.delete(githubConnections).where(eq(githubConnections.id, id)).run();
				tx.delete(settings).where(eq(settings.key, `github.userId.${id}`)).run();
				// Invariant: exactly one default whenever any account exists.
				const rest = tx.select().from(githubConnections).orderBy(asc(githubConnections.createdAt)).all();
				if (rest.length > 0 && !rest.some((r) => r.isDefault)) {
					tx.update(githubConnections).set({ isDefault: true }).where(eq(githubConnections.id, (rest[0] as Row).id)).run();
				}
			});
			repoCache.delete(id);
		},

		async listRepos(id, { q, page = 1 }) {
			const query = q?.trim().toLowerCase() ?? "";
			const pageNo = Math.max(1, Math.floor(page));
			return withAccount(id, async (token) => {
				if (!query) {
					const res = await githubRequest<RawRepo[]>(fetchFn, token, `/user/repos?affiliation=${AFFILIATION}&sort=pushed&per_page=${REPO_PAGE_SIZE}&page=${pageNo}`);
					const items = (res.body ?? []).map(toRepo);
					persistRepos(id, items);
					return { items, nextPage: hasNextPage(res.headers) ? pageNo + 1 : null };
				}
				const all = await loadAllRepos(id, token);
				const matches = all.filter((r) => r.fullName.toLowerCase().includes(query) || (r.description ?? "").toLowerCase().includes(query));
				const start = (pageNo - 1) * REPO_PAGE_SIZE;
				return { items: matches.slice(start, start + REPO_PAGE_SIZE), nextPage: start + REPO_PAGE_SIZE < matches.length ? pageNo + 1 : null };
			});
		},

		async checkRepo(id, owner, repo) {
			return withAccount(id, async (token, row) => {
				const res = await githubRequest<RawRepo & { message?: string }>(fetchFn, token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { allowStatus: [403, 404] });
				const name = `${owner}/${repo}`;
				if (res.status === 200) {
					const p = res.body.permissions;
					const pull = p ? p.pull === true : true;
					const push = p?.push === true;
					return {
						repo: res.body.full_name ?? name,
						accountId: id,
						clone: pull,
						fetch: pull,
						push,
						createPr: pull,
						details: !p
							? "GitHub did not report permissions for this repository; assuming read-only access."
							: push
								? undefined
								: "Read-only access: this account can clone and fetch but cannot push.",
					};
				}
				const denied = { repo: name, accountId: id, clone: false, fetch: false, push: false, createPr: false };
				const sso = res.headers.get("x-github-sso");
				if (res.status === 404) {
					const scopes = parseJsonArray(row.scopes);
					const scopeHint = scopes.length > 0 && !scopes.includes("repo") && !scopes.includes("public_repo")
						? " The token has no `repo` scope, so private repositories are hidden."
						: "";
					return { ...denied, details: `Repository not found, or ${row.login} has no access to it (GitHub answers 404 for private repositories you cannot see).${scopeHint}` };
				}
				return {
					...denied,
					details: sso
						? `Access is blocked by SAML single sign-on: authorize this token for the organization (${sso}).`
						: `GitHub denied access: ${res.body?.message ?? "forbidden"}.`,
				};
			});
		},

		async getRepository(id, owner, repo) {
			return withAccount(id, async (token) => {
				const res = await githubRequest<RawRepo>(fetchFn, token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
				return toRepo(res.body);
			});
		},

		async tokenFor(id) {
			return readToken(getRow(id));
		},

		async commitIdentity(id) {
			const row = getRow(id);
			const userId = await numericUserId(row);
			const scopes = parseJsonArray(row.scopes);
			const emailReadable = scopes.includes("user:email") || scopes.includes("user");
			return {
				name: row.name?.trim() || row.login,
				email: emailReadable && row.email ? row.email : `${userId}+${row.login}@users.noreply.github.com`,
			};
		},

		createPullRequest: (id, owner, repo, input) => withAccount(id, (token) => createPullRequest(fetchFn, token, owner, repo, input)),
		listPullRequests: (id, owner, repo, state) => withAccount(id, (token) => listPullRequests(fetchFn, token, owner, repo, state)),
		getPullRequest: (id, owner, repo, number) => withAccount(id, (token) => getPullRequest(fetchFn, token, owner, repo, number)),

		dispose() {
			flows.dispose();
		},
	};

	/** GitHub's numeric user id (needed for the noreply address); fetched once per account, then remembered in `settings`. */
	async function numericUserId(row: Row): Promise<number> {
		const key = `github.userId.${row.id}`;
		const stored = db.select().from(settings).where(eq(settings.key, key)).get();
		const cached = stored ? Number(JSON.parse(stored.value)) : NaN;
		if (Number.isInteger(cached) && cached > 0) return cached;
		const user = await withAccount(row.id, async (token) => (await githubRequest<RawUser>(fetchFn, token, "/user")).body);
		const value = JSON.stringify(user.id);
		const updatedAt = new Date(now()).toISOString();
		db.insert(settings).values({ key, value, updatedAt }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
		return user.id;
	}

	// ---- repository helpers ----------------------------------------------------------------

	async function loadAllRepos(id: string, token: string): Promise<GithubRepo[]> {
		const cached = repoCache.get(id);
		if (cached && now() - cached.at < REPO_LIST_CACHE_TTL_MS) return cached.items;
		const items: GithubRepo[] = [];
		for (let p = 1; p <= MAX_SCAN_PAGES; p++) {
			const res = await githubRequest<RawRepo[]>(fetchFn, token, `/user/repos?affiliation=${AFFILIATION}&sort=pushed&per_page=100&page=${p}`);
			items.push(...(res.body ?? []).map(toRepo));
			if (!hasNextPage(res.headers)) break;
		}
		repoCache.set(id, { at: now(), items });
		persistRepos(id, items);
		return items;
	}

	/** Remembers the repositories seen for an account (`github_repositories`). */
	function persistRepos(accountId: string, items: GithubRepo[]): void {
		if (items.length === 0) return;
		const updatedAt = new Date(now()).toISOString();
		db.transaction((tx) => {
			for (const r of items) {
				const values = { owner: r.owner, name: r.name, htmlUrl: r.htmlUrl, defaultBranch: r.defaultBranch, accountId, updatedAt };
				tx.insert(githubRepositories).values({ id: r.id, ...values }).onConflictDoUpdate({ target: githubRepositories.id, set: values }).run();
			}
		});
	}

	return service;
}

function toRepo(r: RawRepo): GithubRepo {
	return {
		id: String(r.id),
		owner: r.owner.login,
		name: r.name,
		fullName: r.full_name,
		private: r.private,
		description: r.description,
		htmlUrl: r.html_url,
		defaultBranch: r.default_branch ?? "main",
		pushedAt: r.pushed_at,
		permissions: { pull: r.permissions?.pull === true, push: r.permissions?.push === true, admin: r.permissions?.admin === true },
	};
}

function parseJsonArray(text: string): string[] {
	try {
		const v = JSON.parse(text) as unknown;
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}
