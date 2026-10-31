import { createGithubService, type GithubService } from "@clam/github-integration";
import type { ClamDb } from "@clam/database";
import type { SecretStore } from "@clam/secret-store";

export interface FakeCall {
	method: string;
	url: string;
	body: unknown;
	auth: string | null;
}
type Reply = { status?: number; json?: unknown; headers?: Record<string, string> };
export type FakeRoutes = Record<string, Reply | ((call: FakeCall) => Reply)>;

export const FAKE_TOKEN = "gho_FAKEFAKEFAKEFAKEFAKEFAKEFAKE012345";

/**
 * A real `GithubService` whose only fake part is the HTTP transport (routes keyed by "METHOD url-prefix", first match
 * wins) and the secret store. Used where a test needs a GitHub account or the PR endpoints; git itself stays real.
 */
export async function fakeGithub(db: ClamDb, routes: FakeRoutes): Promise<{ service: GithubService; calls: FakeCall[]; accountId: string; secrets: Map<string, string> }> {
	const calls: FakeCall[] = [];
	const stored = new Map<string, string>();
	const secrets: SecretStore = {
		backend: "encrypted-file",
		location: "memory",
		get: async (k) => stored.get(k) ?? null,
		set: async (k, v) => void stored.set(k, v),
		delete: async (k) => void stored.delete(k),
	};
	const all: FakeRoutes = {
		"GET https://api.github.com/user/emails": { json: [{ email: "octo@example.com", primary: true, verified: true }] },
		"GET https://api.github.com/user": { json: { id: 4242, login: "octo", name: "Octo Cat", email: null, avatar_url: "https://avatars/octo" }, headers: { "x-oauth-scopes": "repo, read:user" } },
		...routes,
	};
	const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const call: FakeCall = { method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : null, auth: new Headers(init?.headers).get("authorization") };
		calls.push(call);
		const key = Object.keys(all).find((k) => `${method} ${url}`.startsWith(k));
		if (!key) throw new Error(`unexpected GitHub request ${method} ${url}`);
		const entry = all[key] as Reply | ((c: FakeCall) => Reply);
		const reply = typeof entry === "function" ? entry(call) : entry;
		return new Response(reply.json === undefined ? "" : JSON.stringify(reply.json), { status: reply.status ?? 200, headers: reply.headers });
	}) as typeof fetch;
	const service = createGithubService({
		db,
		secrets,
		fetch: fetchFn,
		publish: () => {},
		runGh: async () => ({ code: 0, stdout: `${FAKE_TOKEN}\n`, stderr: "  - Token scopes: 'repo'\n", missing: false }),
	});
	const account = await service.importFromGhCli();
	calls.length = 0;
	return { service, calls, accountId: account.id, secrets: stored };
}
