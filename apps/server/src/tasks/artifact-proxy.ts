import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { API_PREFIX, contentDigest, normalizePeerUrl, signRequest, signerFromIdentity } from "@clam/agent-network";
import type { FastifyReply } from "fastify";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { errorText } from "../network/util.ts";
import { MAX_ARTIFACT_BYTES } from "./artifacts.ts";
import type { TaskRow } from "./store.ts";

const FETCH_TIMEOUT_MS = 30_000;

/** Answer with artifact bytes: always a download (`attachment`), with the digest of the bytes the receiver can verify. */
export function sendArtifact(reply: FastifyReply, artifact: { bytes: Buffer; name: string; mediaType: string }): FastifyReply {
	return reply
		.header("Content-Length", artifact.bytes.length)
		.header("Content-Digest", contentDigest(artifact.bytes))
		.header("Content-Disposition", `attachment; filename="${artifact.name}"`)
		.type(artifact.mediaType)
		.send(artifact.bytes);
}

/**
 * Sender side: download an artifact of an outgoing task from its executor. `NetworkClient` only speaks JSON, so the
 * signed request is built here. The bytes are checked against the `sha256` the executor listed in the task result.
 */
export function fetchExecutorArtifact(ctx: ServerContext, task: TaskRow, listed: { artifactId: string; sha256: string; size: number }): Promise<Buffer> {
	return fetchTaskBlob(ctx, task, "artifacts", listed);
}

/**
 * Executor side: download the input bundle of an incoming task from its sender (`GET /tasks/:id/inputs/:artifactId`,
 * served only to the executor of that task and only while it holds `tasks.receive` from the sender). Checked against the
 * digest the sender announced in the task.
 */
export function fetchSenderInput(ctx: ServerContext, task: TaskRow, listed: { artifactId: string; sha256: string; size: number }): Promise<Buffer> {
	return fetchTaskBlob(ctx, task, "inputs", listed);
}

async function fetchTaskBlob(ctx: ServerContext, task: TaskRow, segment: "artifacts" | "inputs", listed: { artifactId: string; sha256: string; size: number }): Promise<Buffer> {
	const other = segment === "artifacts" ? "executing" : "delegating";
	const peer = ctx.network.peers.row(task.peerId);
	const origin = peer ? normalizePeerUrl(peer.url, { allowLoopbackHttp: ctx.config.allowLoopbackPeers }) : null;
	if (!peer || peer.status === "revoked" || origin === null) throw ApiError.upstream(`The ${other} node is not reachable`);
	if (listed.size > MAX_ARTIFACT_BYTES) throw ApiError.upstream("The artifact is larger than this node accepts");
	const url = `${origin}${API_PREFIX}/tasks/${encodeURIComponent(task.id)}/${segment}/${encodeURIComponent(listed.artifactId)}`;
	const headers = signRequest(signerFromIdentity(ctx.identity), { method: "GET", url, bodyBytes: new Uint8Array(0) });
	let response: Response;
	try {
		response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	} catch (error) {
		throw ApiError.upstream(`The ${other} node could not be reached: ${errorText(error)}`);
	}
	if (response.status === 404) throw ApiError.notFound("Artifact");
	if (response.status === 403 && segment === "inputs") throw new ApiError(403, "forbidden", "The delegating node did not grant this node tasks.receive, so the input files cannot be fetched");
	if (!response.ok) throw ApiError.upstream(`The ${other} node answered ${response.status}`);
	const declared = Number(response.headers.get("content-length") ?? 0);
	if (declared > MAX_ARTIFACT_BYTES) throw ApiError.upstream("The artifact is larger than this node accepts");
	let bytes: Buffer;
	try {
		bytes = Buffer.from(await response.arrayBuffer());
	} catch (error) {
		throw ApiError.upstream(`The artifact download was interrupted: ${errorText(error)}`);
	}
	if (bytes.length > MAX_ARTIFACT_BYTES) throw ApiError.upstream("The artifact is larger than this node accepts");
	if (createHash("sha256").update(bytes).digest("hex") !== listed.sha256) {
		throw ApiError.upstream("The downloaded artifact does not match the digest the other node reported");
	}
	return bytes;
}
