import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, type NodeIdentity } from "@clam/node-identity";
import {
	canonicalString,
	contentDigest,
	errorBody,
	MemoryNonceStore,
	signerFromIdentity,
	toBase64Url,
	verifyRequest,
	type NonceStore,
	type PeerKey,
	type Signer,
	type VerifyInput,
	type VerifyResult,
} from "../src/index.ts";

const dirs: string[] = [];

export function cleanupIdentities(): void {
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
}

export interface TestNode {
	identity: NodeIdentity;
	signer: Signer;
	/** What a peer stores after pairing with this node. */
	peerKey(overrides?: Partial<PeerKey>): PeerKey;
}

export function makeNode(): TestNode {
	const dir = mkdtempSync(join(tmpdir(), "clam-net-"));
	dirs.push(dir);
	const identity = loadOrCreateIdentity({ dataDir: dir });
	const signer = signerFromIdentity(identity);
	return {
		identity,
		signer,
		peerKey: (overrides = {}) => ({ nodeId: identity.nodeId, keyId: signer.keyId, publicKey: identity.publicKey, revoked: false, ...overrides }),
	};
}

export function registry(...peers: PeerKey[]): (nodeId: string) => PeerKey | null {
	return (nodeId) => peers.find((p) => p.nodeId === nodeId) ?? null;
}

/** Hand-built signed request: lets tests produce valid signatures over arbitrary header sets. */
export function forgeSigned(
	signer: Signer,
	f: {
		method: string;
		path: string;
		rawQuery?: string;
		host: string;
		timestamp?: number;
		nonce?: string;
		requestId?: string;
		correlationId?: string;
		idempotencyKey?: string | null;
		body?: Uint8Array;
		version?: string;
	},
): VerifyInput {
	const body = f.body ?? new Uint8Array();
	const digest = contentDigest(body);
	const fields = {
		method: f.method,
		path: f.path,
		rawQuery: f.rawQuery ?? "",
		host: f.host,
		nodeId: signer.nodeId,
		keyId: signer.keyId,
		timestamp: String(f.timestamp ?? Date.now()),
		nonce: f.nonce ?? toBase64Url(Buffer.alloc(16, 7)),
		requestId: f.requestId ?? "01JREQUESTIDREQUESTID0000",
		correlationId: f.correlationId ?? "01JCORRELATIONCORRELAT00",
		idempotencyKey: f.idempotencyKey === undefined ? null : f.idempotencyKey,
		contentDigest: digest,
	};
	const headers: Record<string, string> = {
		"x-clam-version": f.version ?? "1",
		"x-clam-node-id": fields.nodeId,
		"x-clam-key-id": fields.keyId,
		"x-clam-timestamp": fields.timestamp,
		"x-clam-nonce": fields.nonce,
		"x-request-id": fields.requestId,
		"x-correlation-id": fields.correlationId,
		"content-digest": digest,
		"x-clam-signature": toBase64Url(signer.sign(Buffer.from(canonicalString(fields), "utf8"))),
	};
	if (fields.idempotencyKey !== null) headers["idempotency-key"] = fields.idempotencyKey;
	return { method: f.method, path: f.path, rawQuery: f.rawQuery ?? "", host: f.host, headers, bodyBytes: body };
}

export interface VerifyServer {
	/** `http://127.0.0.1:<port>`. */
	origin: string;
	host: string;
	results: VerifyResult[];
	close(): Promise<void>;
}

async function readAll(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

export async function listen(server: Server): Promise<{ origin: string; host: string }> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` };
}

export async function closeServer(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * A real `node:http` server that verifies every request exactly as a protocol endpoint must and
 * answers 200 `{ ok, peerId, … , body }` or the verifier's error envelope.
 */
export async function startVerifyServer(deps: {
	lookupPeer: (nodeId: string) => PeerKey | null;
	nonces?: NonceStore;
	now?: () => number;
	skewMs?: number;
}): Promise<VerifyServer> {
	const nonces = deps.nonces ?? new MemoryNonceStore();
	const results: VerifyResult[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			const bodyBytes = await readAll(req);
			const url = new URL(req.url ?? "/", "http://placeholder");
			const result = await verifyRequest(
				{
					method: req.method ?? "GET",
					path: (req.url ?? "/").split("?")[0] as string,
					rawQuery: url.search,
					host: req.headers.host ?? "",
					headers: req.headers,
					bodyBytes,
				},
				{ lookupPeer: deps.lookupPeer, nonces, ...(deps.now ? { now: deps.now } : {}), ...(deps.skewMs ? { skewMs: deps.skewMs } : {}) },
			);
			results.push(result);
			res.setHeader("content-type", "application/json");
			if (!result.ok) {
				res.statusCode = result.status;
				res.end(JSON.stringify(errorBody(result.code, result.message, result.details)));
				return;
			}
			res.end(JSON.stringify({ ...result, path: req.url, method: req.method, body: bodyBytes.toString("utf8") }));
		})();
	});
	const { origin, host } = await listen(server);
	return { origin, host, results, close: () => closeServer(server) };
}
