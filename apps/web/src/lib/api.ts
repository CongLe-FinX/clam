import { type ApiErrorBody, LOCAL_API_PREFIX } from "@clam/contracts";
import { authGate } from "@/features/auth/gate.ts";

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details: unknown;
	constructor(status: number, code: string, message: string, details?: unknown) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

export type Query = Record<string, string | number | boolean | null | undefined>;
export interface RequestOpts {
	signal?: AbortSignal;
}

function buildUrl(path: string, query?: Query): string {
	let url = `${LOCAL_API_PREFIX}${path}`;
	if (query) {
		const sp = new URLSearchParams();
		for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
		const qs = sp.toString();
		if (qs) url += `?${qs}`;
	}
	return url;
}

async function request<T>(method: string, path: string, query: Query | undefined, body: unknown, opts?: RequestOpts): Promise<T> {
	let res: Response;
	try {
		res = await fetch(buildUrl(path, query), {
			method,
			signal: opts?.signal,
			headers: body !== undefined ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
	} catch (e) {
		if (e instanceof DOMException && e.name === "AbortError") throw e;
		throw new ApiError(0, "network", "Cannot reach the CL Agent Mesh server. Is it running?");
	}
	if (res.status === 204) return undefined as T;
	const text = await res.text();
	let json: unknown;
	if (text) {
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
	}
	if (!res.ok) {
		const err = (json as ApiErrorBody | undefined)?.error;
		// Signed out on the public origin: flip the global gate once (root layout shows /login, WS pauses). Never retried here.
		if (res.status === 401 && err?.code === "auth_required") authGate.require();
		throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? (res.statusText || `Request failed (${res.status})`), err?.details);
	}
	return json as T;
}

export const api = {
	get: <T>(path: string, query?: Query, opts?: RequestOpts) => request<T>("GET", path, query, undefined, opts),
	post: <T = void>(path: string, body?: unknown, opts?: RequestOpts) => request<T>("POST", path, undefined, body ?? undefined, opts),
	put: <T>(path: string, body?: unknown, opts?: RequestOpts) => request<T>("PUT", path, undefined, body ?? undefined, opts),
	patch: <T>(path: string, body?: unknown, opts?: RequestOpts) => request<T>("PATCH", path, undefined, body ?? undefined, opts),
	delete: <T = void>(path: string, opts?: RequestOpts) => request<T>("DELETE", path, undefined, undefined, opts),
};

export function errorMessage(e: unknown): string {
	if (e instanceof ApiError) return e.message;
	if (e instanceof Error) return e.message;
	return typeof e === "string" ? e : "Something went wrong";
}
