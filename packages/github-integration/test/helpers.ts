import type { SecretStore } from "@clam/secret-store";

export function memorySecrets(): SecretStore & { map: Map<string, string> } {
	const map = new Map<string, string>();
	return {
		map,
		backend: "encrypted-file",
		location: "memory",
		get: async (k) => map.get(k) ?? null,
		set: async (k, v) => void map.set(k, v),
		delete: async (k) => void map.delete(k),
	};
}

export interface Call {
	url: string;
	method: string;
	body: string | null;
	auth: string | null;
}

type Reply = { status?: number; json?: unknown; headers?: Record<string, string> } | Error;

/** Routes requests by "METHOD url-prefix"; each route is a reply or a function (call index → reply). */
export function fakeFetch(routes: Record<string, Reply | ((n: number, call: Call) => Reply)>) {
	const calls: Call[] = [];
	const counts = new Map<string, number>();
	const fn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		const call: Call = { url, method, body: typeof init?.body === "string" ? init.body : null, auth: headers.get("authorization") };
		calls.push(call);
		const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
		if (!key) throw new Error(`unexpected request ${method} ${url}`);
		const n = counts.get(key) ?? 0;
		counts.set(key, n + 1);
		const r = routes[key]!;
		const reply = typeof r === "function" ? r(n, call) : r;
		if (reply instanceof Error) throw reply;
		return new Response(reply.json === undefined ? "" : JSON.stringify(reply.json), { status: reply.status ?? 200, headers: reply.headers });
	}) as typeof fetch;
	return { fn, calls };
}
