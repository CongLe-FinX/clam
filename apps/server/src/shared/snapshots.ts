import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { API_PREFIX, normalizePeerUrl, signRequest, signerFromIdentity } from "@clam/agent-network";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { ServerContext } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { errorText } from "../network/util.ts";

/** What a snapshot download needs to know about the snapshot it expects (from the checkpoint notice). */
export interface ExpectedSnapshot {
	sha256: string;
	size: number;
}

/** A download that cannot succeed by retrying (the holder does not have it, it is too large, it does not match its digest). */
export class SnapshotRejectedError extends Error {}

/**
 * Where session snapshots live: `<dataDir>/shared/<sharedId>/snapshots/<seq>.tar`, owner-only (0600 files, 0700 directories).
 * Snapshots are private node-to-node data (they contain whole conversations): they are never written to Git and not
 * secret-scanned. Paths in the database are relative to `<dataDir>/shared`.
 */
export class SnapshotFiles {
	readonly root: string;

	constructor(dataDir: string) {
		this.root = path.resolve(dataDir, "shared");
	}

	relative(sharedId: string, seq: number): string {
		return path.posix.join(sharedId, "snapshots", `${seq}.tar`);
	}

	/** Absolute path of a stored relative path; refuses anything that would leave the snapshot root. */
	absolute(relative: string): string {
		const full = path.resolve(this.root, relative);
		const rel = path.relative(this.root, full);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`snapshot path escapes the snapshot directory: ${relative}`);
		return full;
	}

	/** A fresh temporary file next to where the snapshot will live (same filesystem: the final move is a rename). */
	async temporary(sharedId: string, label: string): Promise<string> {
		const dir = path.join(this.root, sharedId, "snapshots");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmod(this.root, 0o700).catch(() => {});
		await chmod(path.join(this.root, sharedId), 0o700).catch(() => {});
		return path.join(dir, `.${label}.${process.pid}.${Date.now()}.tmp`);
	}

	/** Move a finished temporary file into place as `<seq>.tar` (mode 0600) and return its relative path. */
	async place(tmp: string, sharedId: string, seq: number): Promise<string> {
		const relative = this.relative(sharedId, seq);
		await chmod(tmp, 0o600);
		await rename(tmp, this.absolute(relative));
		return relative;
	}

	async digest(file: string): Promise<{ sha256: string; size: number }> {
		const hash = createHash("sha256");
		let size = 0;
		for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
			hash.update(chunk);
			size += chunk.length;
		}
		return { sha256: hash.digest("hex"), size };
	}

	async size(relative: string): Promise<number | null> {
		try {
			return (await stat(this.absolute(relative))).size;
		} catch {
			return null;
		}
	}

	async remove(relative: string): Promise<void> {
		await rm(this.absolute(relative), { force: true });
	}

	async removeSession(sharedId: string): Promise<void> {
		await rm(path.join(this.root, sharedId), { recursive: true, force: true });
	}
}

/** `Content-Digest` header value of a known sha-256 (hex). */
export function digestHeader(sha256: string): string {
	return `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`;
}

export interface DownloadOptions {
	/** Largest snapshot accepted (also checked against the announced size and `Content-Length`). */
	maxBytes: number;
	/** Abort when no byte arrived for this long. */
	idleMs: number;
}

/**
 * Download a snapshot from the node that holds it (`GET /api/v1/shared/:id/snapshots/:seq`, signed like every request) into
 * `tmp`, streaming: the digest and the size are computed while writing and compared with what the checkpoint notice
 * announced; a mismatch or an oversized body deletes the file and rejects (`SnapshotRejectedError` = retrying cannot help,
 * `ApiError` 502 = the holder could not be reached or broke the transfer).
 */
export async function downloadSnapshot(
	ctx: Pick<ServerContext, "identity" | "config">,
	peer: { url: string },
	request: { sharedId: string; seq: number; expected: ExpectedSnapshot },
	tmp: string,
	options: DownloadOptions,
): Promise<void> {
	const { expected } = request;
	if (expected.size > options.maxBytes) throw new SnapshotRejectedError(`The snapshot (${expected.size} bytes) is larger than this node accepts (${options.maxBytes})`);
	const origin = normalizePeerUrl(peer.url, { allowLoopbackHttp: ctx.config.allowLoopbackPeers });
	if (origin === null) throw ApiError.upstream("The node that holds the snapshot has no usable address");
	const url = `${origin}${API_PREFIX}/shared/${encodeURIComponent(request.sharedId)}/snapshots/${request.seq}`;
	const headers = signRequest(signerFromIdentity(ctx.identity), { method: "GET", url, bodyBytes: new Uint8Array(0) });
	const controller = new AbortController();
	let idle: NodeJS.Timeout | undefined;
	const arm = (): void => {
		clearTimeout(idle);
		idle = setTimeout(() => controller.abort(), options.idleMs);
	};
	arm();
	try {
		let response: Response;
		try {
			response = await fetch(url, { method: "GET", headers, redirect: "manual", signal: controller.signal });
		} catch (error) {
			throw ApiError.upstream(`The node that holds the snapshot could not be reached: ${errorText(error)}`);
		}
		if (response.status === 404) throw new SnapshotRejectedError("The node no longer holds this snapshot");
		if (response.status === 403) throw new SnapshotRejectedError("The node refused the download (sessions.share not granted?)");
		if (!response.ok || !response.body) throw ApiError.upstream(`The node that holds the snapshot answered ${response.status}`);
		const declared = Number(response.headers.get("content-length") ?? expected.size);
		if (declared > options.maxBytes || declared !== expected.size) throw new SnapshotRejectedError(`The snapshot announces ${declared} bytes, expected ${expected.size}`);
		const hash = createHash("sha256");
		let received = 0;
		const meter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				arm();
				received += chunk.length;
				if (received > expected.size || received > options.maxBytes) return callback(new SnapshotRejectedError("The snapshot is larger than announced"));
				hash.update(chunk);
				callback(null, chunk);
			},
		});
		try {
			await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), meter, createWriteStream(tmp, { mode: 0o600 }), { signal: controller.signal });
		} catch (error) {
			if (error instanceof SnapshotRejectedError) throw error;
			throw ApiError.upstream(`The snapshot download was interrupted: ${errorText(error)}`);
		}
		if (received !== expected.size || hash.digest("hex") !== expected.sha256) throw new SnapshotRejectedError("The downloaded snapshot does not match the digest the driver announced");
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	} finally {
		clearTimeout(idle);
	}
}
