import type { Peer, PairingRequest, Invitation, OutgoingPairing, Workspace } from "@clam/contracts";
import { signRequest, signerFromIdentity } from "@clam/agent-network";
import type { SecretStore } from "@clam/secret-store";
import type { NetworkOptions } from "../src/network/index.ts";
import type { SharedOptions } from "../src/shared/hub.ts";
import type { ContextTimings } from "../src/context/service.ts";
import { api, createFullHarness, type FullHarness } from "./full-harness.ts";

/** Fast timers so heartbeat/offline/confirm retries are observable in milliseconds. */
export const FAST: NetworkOptions = {
	monitor: { intervalMs: 150, jitter: 0, missesForOffline: 3, agentsRefreshMs: 60_000, sseOpenTimeoutMs: 2_000, sseRetryAfterFailedOpenMs: 60_000 },
	pairingTickMs: 100,
	confirmRetryMs: 200,
	probeTimeoutMs: 1_500,
};

export async function startNode(
	name: string,
	extra: { dataDir?: string; port?: number; options?: NetworkOptions; secrets?: SecretStore; webDistDir?: string; sharedTimings?: Partial<SharedOptions>; contextTimings?: Partial<ContextTimings> } = {},
): Promise<FullHarness> {
	return createFullHarness({
		dataDir: extra.dataDir,
		secrets: extra.secrets,
		webDistDir: extra.webDistDir,
		sharedTimings: extra.sharedTimings,
		contextTimings: extra.contextTimings,
		network: { port: extra.port, nodeName: name, options: { ...FAST, ...extra.options } },
	});
}

export async function eventually<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, what: string, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	for (;;) {
		try {
			const value = await fn();
			if (value) return value;
		} catch (error) {
			last = error;
		}
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
}

export async function peersOf(node: FullHarness): Promise<Peer[]> {
	return (await api(node).get<Peer[]>("/network/peers")).body;
}

export async function peerOf(node: FullHarness, id: string): Promise<Peer | undefined> {
	return (await peersOf(node)).find((p) => p.id === id);
}

export interface Paired {
	workspace: Workspace;
	invitation: Invitation;
	request: PairingRequest;
	join: OutgoingPairing;
}

/** Pair `joiner` into `inviter` through the local UI routes only, exactly as a user would. Resolves once both see each other online. */
export async function pair(inviter: FullHarness, joiner: FullHarness, options: { capabilities?: string[]; workspaceName?: string } = {}): Promise<Paired> {
	const a = api(inviter);
	const b = api(joiner);
	const workspace = (await a.post<Workspace>("/workspaces", { name: options.workspaceName ?? "Alpha" })).body;
	const created = await a.post<Invitation>("/network/invitations", { workspaceId: workspace.id });
	if (created.status !== 201) throw new Error(`invitation failed: ${JSON.stringify(created.body)}`);
	const invitation = created.body;
	const joined = await b.post<OutgoingPairing>("/network/join", { url: inviter.netUrl, code: invitation.code, expectedFingerprint: inviter.ctx.identity.fingerprint });
	if (joined.status !== 201) throw new Error(`join failed: ${JSON.stringify(joined.body)}`);
	const request = await eventually(async () => (await a.get<PairingRequest[]>("/network/pairing-requests")).body.find((r) => r.state === "awaiting_approval"), "pairing request on the inviter");
	const approved = await a.post<PairingRequest>(`/network/pairing-requests/${request.id}/approve`, { capabilities: options.capabilities ?? ["agents.read", "events.read", "tasks.send", "tasks.receive"] });
	if (approved.status !== 200) throw new Error(`approve failed: ${JSON.stringify(approved.body)}`);
	await eventually(async () => (await peerOf(inviter, joiner.ctx.identity.nodeId))?.status === "online" && (await peerOf(joiner, inviter.ctx.identity.nodeId))?.status === "online", "both peers online");
	return { workspace, invitation, request: approved.body, join: joined.body };
}

/** A fully signed request from `from` to another node's network listener; returns what the server answered. */
export async function signedRequest(
	from: FullHarness,
	toNetUrl: string,
	r: { method?: string; path: string; body?: unknown; idempotencyKey?: string; now?: number; mutate?: (headers: Record<string, string>) => void; bodyOverride?: string; hostHeader?: string },
): Promise<{ status: number; body: any; text: string; headers: Headers; sent: { url: string; init: RequestInit } }> {
	const method = r.method ?? "GET";
	const url = `${toNetUrl}/api/v1${r.path}`;
	const bodyText = r.body === undefined ? undefined : JSON.stringify(r.body);
	const headers = signRequest(signerFromIdentity(from.ctx.identity), {
		method,
		url,
		bodyBytes: bodyText === undefined ? new Uint8Array(0) : Buffer.from(bodyText),
		idempotencyKey: r.idempotencyKey ?? (method === "GET" ? undefined : `test-${Math.random().toString(36).slice(2)}`),
		now: r.now,
	});
	r.mutate?.(headers);
	if (bodyText !== undefined || r.bodyOverride !== undefined) headers["Content-Type"] = "application/json";
	const init: RequestInit = { method, headers, body: r.bodyOverride ?? bodyText };
	const res = await fetch(url, init);
	const text = await res.text();
	let body: unknown;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {
		// Not JSON (an artifact download): callers read `text`.
	}
	return { status: res.status, body, text, headers: res.headers, sent: { url, init } };
}
