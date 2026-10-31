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
export async function fetchExecutorArtifact(
	ctx: ServerContext,
	task: TaskRow,
	listed: { artifactId: string; sha256: string; size: number },
): Promise<Buffer> {
	const peer = ctx.network.peers.row(task.peerId);
	const origin = peer ? normalizePeerUrl(peer.url, { allowLoopbackHttp: ctx.config.allowLoopbackPeers }) : null;
	if (!peer || peer.status === "revoked" || origin === null) throw ApiError.upstream("The executing node is not reachable");
	if (listed.size > MAX_ARTIFACT_BYTES) throw ApiError.upstream("The artifact is larger than this node accepts");
	const url = `${origin}${API_PREFIX}/tasks/${encodeURIComponent(task.id)}/artifacts/${encodeURIComponent(listed.artifactId)}`;
	const headers = signRequest(signerFromIdentity(ctx.identity), { method: "GET", url, bodyBytes: new Uint8Array(0) });
	let response: Response;
	try {
		response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	} catch (error) {
		throw ApiError.upstream(`The executing node could not be reached: ${errorText(error)}`);
	}
	if (response.status === 404) throw ApiError.notFound("Artifact");
	if (!response.ok) throw ApiError.upstream(`The executing node answered ${response.status}`);
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
		throw ApiError.upstream("The downloaded artifact does not match the digest the executor reported");
	}
	return bytes;
}
