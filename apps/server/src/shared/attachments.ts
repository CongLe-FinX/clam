import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { wire } from "@clam/agent-network";
import { ATTACHMENT_MAX_BYTES, type FileEntry, i18nMsg, PROMPT_IMAGES_MAX_BASE64_BYTES, PROMPT_IMAGES_MAX_COUNT, type PromptImage, type SaveAttachmentBody, type SharedAttachment } from "@clam/contracts";
import type { z } from "zod";
import { agentSessions } from "@clam/database";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../http/errors.ts";
import { contentTypeFor, parseRange, safeFileName, sendFile } from "../http/file-response.ts";
import { errorText } from "../network/util.ts";
import { sniffImageMime } from "../services/prompt-images.ts";
import { copyIntoFolder, bodyStream, limitBytes, refuseGitDir } from "../services/file-writes.ts";
import { resolveInsideRoot } from "../services/files.ts";
import { checkoutFolder } from "../services/checkouts.ts";
import type { AttachmentApi, SharedHub } from "./hub.ts";
import { downloadSnapshot } from "./snapshots.ts";
import { newAttachmentId, type AttachmentRow } from "./store.ts";

/** Longest wait between two attempts to fetch the same missing file. */
const MAX_BACKOFF_MS = 5 * 60_000;

/** Backpressure-aware write that gives up quietly when the reader went away (a client that closed the tab keeps the download going). */
async function writeTo(sink: Writable, chunk: Buffer): Promise<void> {
	if (sink.destroyed || sink.writableEnded) return;
	if (sink.write(chunk)) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	const done = (): void => {
		sink.off("drain", done);
		sink.off("close", done);
		resolve();
	};
	sink.once("drain", done);
	sink.once("close", done);
	await promise;
}

/**
 * Files of the group chat (docs/shared-sessions.md §4.7). The bytes are stored once per sha-256 in
 * `<dataDir>/attachments/<sha256>` (temp file + rename, mode 0600); the message carries only metadata, and each member node
 * fetches the bytes it lacks from any member that has them (signed `GET /api/v1/shared/:id/attachments/:attId`, verified
 * against the announced size and digest): at once up to `attachmentEagerMaxBytes` (a scan of the database, so it survives a
 * restart and retries with backoff), otherwise when somebody opens the file (streamed to the client while it is stored).
 */
export class AttachmentService implements AttachmentApi {
	private readonly root: string;
	/** One download per digest, whoever asks. */
	private readonly jobs = new Map<string, Promise<void>>();
	private readonly failures = new Map<string, { attempts: number; nextAt: number }>();
	private readonly disposers: Array<() => void> = [];
	private timer: NodeJS.Timeout | undefined;
	private scanning = false;
	private rescan = false;
	private stopped = true;

	constructor(private readonly hub: SharedHub) {
		this.root = path.resolve(hub.ctx.config.dataDir, "attachments");
	}

	private get store() {
		return this.hub.store;
	}

	private get ctx() {
		return this.hub.ctx;
	}

	private blobPath(sha256: string): string {
		return path.join(this.root, sha256);
	}

	private hasBlob(row: Pick<AttachmentRow, "sha256" | "size">): boolean {
		try {
			return statSync(this.blobPath(row.sha256)).size === row.size;
		} catch {
			return false;
		}
	}

	private view(row: AttachmentRow): SharedAttachment {
		return { id: row.id, name: row.name, mimeType: row.mimeType, size: row.size, sha256: row.sha256, originNodeId: row.originNodeId, available: row.stored };
	}

	// ------------------------------------------------------------------ lifecycle

	start(): void {
		this.stopped = false;
		this.disposers.push(
			this.ctx.network.peers.onChange((change) => {
				if (change.type !== "online" && change.type !== "url_changed") return;
				this.failures.clear();
				this.kick();
			}),
		);
		this.timer = setInterval(() => this.kick(), this.hub.options.retryMs);
		this.timer.unref();
		this.kick();
	}

	stop(): void {
		this.stopped = true;
		for (const dispose of this.disposers.splice(0)) dispose();
		clearInterval(this.timer);
		this.timer = undefined;
	}

	// ------------------------------------------------------------------ storing bytes

	private async temporary(): Promise<string> {
		const dir = path.join(this.root, ".tmp");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		return path.join(dir, `${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`);
	}

	/** Move a finished, verified temporary file to its content address (an existing copy of the same digest wins). */
	private async place(tmp: string, sha256: string): Promise<void> {
		const target = this.blobPath(sha256);
		if (existsSync(target)) return void (await rm(tmp, { force: true }));
		await chmod(tmp, 0o600);
		await rename(tmp, target);
	}

	/** The bytes of `sha256` are here now: mark every row with that digest and tell the UIs (`available`). */
	private stored(sha256: string): void {
		for (const messageId of this.store.markStored(sha256)) {
			const message = this.store.message(messageId);
			if (message) this.hub.changed(message.sharedSessionId, { messages: [message] });
		}
	}

	/** Hash and store a stream; the temporary file is removed on any failure. */
	private async ingestStream(source: NodeJS.ReadableStream, max: number): Promise<{ sha256: string; size: number }> {
		const tmp = await this.temporary();
		const hash = createHash("sha256");
		let size = 0;
		const meter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				hash.update(chunk);
				size += chunk.length;
				callback(null, chunk);
			},
		});
		try {
			await pipeline(source, limitBytes(max), meter, createWriteStream(tmp, { mode: 0o600, flags: "wx" }));
		} catch (error) {
			await rm(tmp, { force: true });
			throw error;
		}
		const sha256 = hash.digest("hex");
		await this.place(tmp, sha256);
		return { sha256, size };
	}

	async upload(sharedId: string, input: { name: string; mimeType: string | undefined; body: unknown; contentLength: string | undefined }): Promise<SharedAttachment> {
		const shared = this.store.get(sharedId);
		if (shared.state !== "active") throw new ApiError(409, "not_a_participant", i18nMsg("This node left the shared session"));
		if (input.contentLength !== undefined && /^\d{1,16}$/.test(input.contentLength) && Number(input.contentLength) > ATTACHMENT_MAX_BYTES) {
			throw new ApiError(413, "payload_too_large", i18nMsg("The file is larger than the {mb} MB limit", { mb: Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024) }));
		}
		const { sha256, size } = await this.ingestStream(bodyStream(input.body), ATTACHMENT_MAX_BYTES);
		const name = safeFileName(input.name);
		const declared = input.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
		const mimeType = declared && declared !== "application/octet-stream" ? declared : contentTypeFor(name).split(";", 1)[0] as string;
		return this.register(sharedId, { name, mimeType, size, sha256, copiedPath: null });
	}

	private register(sharedId: string, file: { name: string; mimeType: string; size: number; sha256: string; copiedPath: string | null }): SharedAttachment {
		const id = newAttachmentId();
		this.store.insertAttachment({ id, sharedSessionId: sharedId, messageId: null, ...file, originNodeId: this.ctx.identity.nodeId, stored: true });
		return this.view(this.store.attachment(id) as AttachmentRow);
	}

	claim(sharedId: string, ids: readonly string[]): AttachmentRow[] {
		return [...new Set(ids)].map((id) => {
			const row = this.store.attachment(id);
			if (!row || row.sharedSessionId !== sharedId || row.originNodeId !== this.ctx.identity.nodeId || row.messageId !== null || !row.stored) {
				throw ApiError.badRequest(i18nMsg("Attachment {id} is unknown, already posted, or was not uploaded to this shared session on this node", { id }));
			}
			return row;
		});
	}

	// ------------------------------------------------------------------ receiving metadata

	received(sharedId: string, messageId: string, originNodeId: string, files: readonly wire.SharedAttachmentWire[]): void {
		if (files.length === 0) return;
		for (const file of files) {
			const known = this.store.attachment(file.id);
			if (known) {
				if (known.sharedSessionId !== sharedId || known.sha256 !== file.sha256) this.hub.log.warn({ sharedId, attachmentId: file.id }, "ignored an attachment whose id is already used by another file");
				continue;
			}
			this.store.insertAttachment({ id: file.id, sharedSessionId: sharedId, messageId, name: safeFileName(file.name), mimeType: file.mimeType, size: file.size, sha256: file.sha256, originNodeId, stored: this.hasBlob(file) });
		}
		this.kick();
	}

	// ------------------------------------------------------------------ fetching bytes from members

	/** Members that may hold the bytes, the origin first and reachable ones before the rest. */
	private holders(row: AttachmentRow): Array<{ id: string; url: string }> {
		const rank = (status: string): number => (status === "online" ? 0 : status === "degraded" ? 1 : 2);
		return this.store
			.activePeers(row.sharedSessionId)
			.flatMap((p) => {
				const peer = this.ctx.network.peers.row(p.nodeId);
				return peer && peer.status !== "revoked" ? [{ id: peer.id, url: peer.url, status: peer.status }] : [];
			})
			.sort((a, b) => Number(b.id === row.originNodeId) - Number(a.id === row.originNodeId) || rank(a.status) - rank(b.status))
			.map(({ id, url }) => ({ id, url }));
	}

	private async download(row: AttachmentRow, sink: Writable | undefined): Promise<void> {
		const holders = this.holders(row);
		let last: unknown = ApiError.upstream(i18nMsg("No other member node of this shared session is known to hold the file"));
		for (const peer of holders) {
			const tmp = await this.temporary();
			let sent = 0;
			try {
				await downloadSnapshot(
					this.ctx,
					peer,
					{ sharedId: row.sharedSessionId, seq: 0, expected: { sha256: row.sha256, size: row.size }, blobPath: `attachments/${encodeURIComponent(row.id)}` },
					tmp,
					{
						maxBytes: ATTACHMENT_MAX_BYTES,
						idleMs: this.hub.options.downloadIdleMs,
						...(sink && {
							onChunk: async (chunk: Buffer) => {
								sent += chunk.length;
								await writeTo(sink, chunk);
							},
						}),
					},
				);
				await this.place(tmp, row.sha256);
				if (sink && !sink.destroyed) sink.end();
				this.stored(row.sha256);
				return;
			} catch (error) {
				last = error;
				// Bytes already went to a client: another holder cannot continue them.
				if (sink && sent > 0) break;
			}
		}
		const failure = last instanceof ApiError ? last : ApiError.upstream(i18nMsg("The file could not be fetched from the other member nodes: {error}", { error: errorText(last) }));
		sink?.destroy(failure);
		throw failure;
	}

	/** Make sure this node holds the bytes: fetched from a member when it does not, one download per digest. */
	private ensureStored(row: AttachmentRow): Promise<void> {
		if (this.hasBlob(row)) {
			if (!row.stored) this.stored(row.sha256);
			return Promise.resolve();
		}
		const running = this.jobs.get(row.sha256);
		if (running) return running;
		return this.track(row, this.download(row, undefined));
	}

	private track(row: AttachmentRow, job: Promise<void>): Promise<void> {
		const tracked = job.finally(() => this.jobs.delete(row.sha256));
		this.jobs.set(row.sha256, tracked);
		// A download nobody waits for (a client that left) must not become an unhandled rejection.
		tracked.catch(() => {});
		return tracked;
	}

	kick(): void {
		if (this.stopped) return;
		void this.scan();
	}

	/** Fetch every file up to the eager limit that this node lacks; failures back off (doubling, up to 5 minutes). Never throws. */
	private async scan(): Promise<void> {
		if (this.scanning) {
			this.rescan = true;
			return;
		}
		this.scanning = true;
		try {
			do {
				this.rescan = false;
				for (const row of this.store.missingAttachments()) {
					if (this.stopped) return;
					if (row.size > this.hub.options.attachmentEagerMaxBytes) continue;
					const failed = this.failures.get(row.id);
					if (failed && failed.nextAt > Date.now()) continue;
					try {
						await this.ensureStored(row);
						this.failures.delete(row.id);
					} catch (error) {
						const attempts = (failed?.attempts ?? 0) + 1;
						this.failures.set(row.id, { attempts, nextAt: Date.now() + Math.min(this.hub.options.retryMs * 2 ** attempts, MAX_BACKOFF_MS) });
						this.hub.log.debug({ err: errorText(error), attachmentId: row.id, attempts }, "could not fetch a group chat file yet; will retry");
					}
				}
			} while (this.rescan && !this.stopped);
		} catch (error) {
			this.hub.log.warn({ err: errorText(error) }, "fetching group chat files failed");
		} finally {
			this.scanning = false;
		}
	}

	// ------------------------------------------------------------------ serving

	private requireRow(sharedId: string, attachmentId: string): AttachmentRow {
		this.store.get(sharedId);
		const row = this.store.attachment(attachmentId);
		if (!row || row.sharedSessionId !== sharedId || row.messageId === null) throw ApiError.notFound("Attachment");
		return row;
	}

	async serve(request: FastifyRequest, reply: FastifyReply, sharedId: string, attachmentId: string, download: boolean): Promise<FastifyReply> {
		const row = this.requireRow(sharedId, attachmentId);
		const file = { abs: this.blobPath(row.sha256), size: row.size, name: row.name, mimeType: row.mimeType, download };
		if (this.hasBlob(row)) {
			if (!row.stored) this.stored(row.sha256);
			return sendFile(request, reply, file);
		}
		// Not here yet. The first opener of a file nobody is fetching gets it streamed while it is stored; a request for the middle of
		// the file (or one that arrives while the fetch runs) waits for the whole file, then reads it from disk with ranges.
		const range = parseRange(request.headers.range, row.size);
		const fromStart = range === null || (range !== "unsatisfiable" && range.start === 0);
		if (fromStart && !this.jobs.has(row.sha256)) {
			const sink = new PassThrough();
			// The client may be gone when the download fails: nobody listens then, and that must not crash the process.
			sink.on("error", () => {});
			void this.track(row, this.download(row, sink)).catch(() => {});
			return sendFile(request, reply, { ...file, live: sink });
		}
		await this.ensureStored(row);
		return sendFile(request, reply, file);
	}

	wireFile(sharedId: string, attachmentId: string): { path: string; size: number; sha256: string; name: string } {
		const row = this.store.attachment(attachmentId);
		if (!row || row.sharedSessionId !== sharedId || row.messageId === null || !this.hasBlob(row)) throw ApiError.notFound("Attachment");
		return { path: this.blobPath(row.sha256), size: row.size, sha256: row.sha256, name: row.name };
	}

	// ------------------------------------------------------------------ into project folders

	/** The folder the session's agent works in (the shared session's worktree for its driving session, else the project's folder). */
	private async projectOf(sessionId: string): Promise<{ path: string }> {
		const row = this.ctx.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
		if (!row) throw ApiError.notFound("Project");
		return { path: (await this.ctx.sessions.workdir(row)).dir };
	}

	async save(sharedId: string, attachmentId: string, body: z.infer<typeof SaveAttachmentBody>): Promise<FileEntry> {
		const row = this.requireRow(sharedId, attachmentId);
		// `projectId` is a checkout id: a project id, or the worktree of a shared session.
		const folder = await checkoutFolder(this.ctx, body.projectId);
		await this.ensureStored(row);
		const rel = await copyIntoFolder(folder, body.path ?? `attachments/${safeFileName(row.name)}`, this.blobPath(row.sha256));
		const info = await stat((await resolveInsideRoot(folder, rel)).abs);
		return { name: path.posix.basename(rel), path: rel, kind: "file", size: info.size, modifiedAt: info.mtime.toISOString() };
	}

	async promptImages(files: readonly AttachmentRow[]): Promise<Map<string, PromptImage>> {
		const images = new Map<string, PromptImage>();
		let budget = PROMPT_IMAGES_MAX_BASE64_BYTES;
		for (const file of files) {
			if (images.size >= PROMPT_IMAGES_MAX_COUNT) break;
			const base64Length = Math.ceil(file.size / 3) * 4;
			if (base64Length > budget || !this.hasBlob(file)) continue;
			try {
				const bytes = await readFile(this.blobPath(file.sha256));
				// The announced type is the sender's word; what the bytes are decides (a provider fails the whole turn on a mislabelled image).
				const mimeType = sniffImageMime(bytes.subarray(0, 16));
				if (!mimeType || bytes.length !== file.size) continue;
				images.set(file.id, { mimeType, data: bytes.toString("base64") });
				budget -= base64Length;
			} catch (error) {
				this.hub.log.debug({ err: errorText(error), attachmentId: file.id }, "could not read a group chat image for the agent");
			}
		}
		return images;
	}

	async placeInFolder(sessionId: string, files: readonly AttachmentRow[]): Promise<Array<{ file: AttachmentRow; relativePath: string | null }>> {
		const project = await this.projectOf(sessionId);
		const placed: Array<{ file: AttachmentRow; relativePath: string | null }> = [];
		for (const file of files) {
			// Already in this folder (injected before, or the agent itself shared it from here): reuse, never copy twice.
			const known = file.copiedPath ? await stat(path.join(project.path, file.copiedPath)).catch(() => null) : null;
			if (file.copiedPath && known?.isFile() && known.size === file.size) {
				placed.push({ file, relativePath: file.copiedPath });
				continue;
			}
			try {
				await this.ensureStored(file);
				const rel = await copyIntoFolder(project.path, `attachments/${safeFileName(file.name)}`, this.blobPath(file.sha256));
				this.store.updateAttachment(file.id, { copiedPath: rel });
				placed.push({ file, relativePath: rel });
			} catch (error) {
				this.hub.log.warn({ err: errorText(error), attachmentId: file.id, sessionId }, "could not copy a group chat file into the agent's folder");
				placed.push({ file, relativePath: null });
			}
		}
		return placed;
	}

	/**
	 * Store a file of the agent's working folder as an unattached group chat file (the one code path of `mesh_share_file` and of
	 * the files a turn produced): a regular file inside the folder, at most `maxBytes`, snapshotted as it is now. With
	 * `skipIfPosted` a file that is already in the group chat from this folder path with the same digest (the agent shared it
	 * with `mesh_share_file`, or it is a file of the group copied into the folder) yields null, so a file is never posted twice.
	 */
	async registerFromFolder(sharedId: string, sessionId: string, wantedPath: string, options: { maxBytes?: number; skipIfPosted?: boolean } = {}): Promise<AttachmentRow | null> {
		const maxBytes = options.maxBytes ?? ATTACHMENT_MAX_BYTES;
		const project = await this.projectOf(sessionId);
		const root = await resolveInsideRoot(project.path, ".");
		// Agents think in absolute paths too: accept one when it lies inside the working folder.
		const wanted = path.isAbsolute(wantedPath) ? path.relative(root.abs, wantedPath) : wantedPath;
		const { rel, abs } = await resolveInsideRoot(project.path, wanted);
		if (rel === "") throw ApiError.badRequest(i18nMsg("path must name a file"));
		refuseGitDir(rel);
		const info = await stat(abs);
		if (!info.isFile()) throw ApiError.badRequest(i18nMsg("\"{path}\" is not a regular file", { path: rel }));
		if (info.size > maxBytes) throw ApiError.badRequest(i18nMsg("\"{path}\" is {size} bytes; the limit for a file in the group chat is {max}", { path: rel, size: info.size, max: maxBytes }));
		// The agent may keep editing its file: the group gets a snapshot of it as it is now.
		const { sha256, size } = await this.ingestStream(createReadStream(abs), maxBytes);
		if (options.skipIfPosted && (this.store.postedFromFolder(sharedId, sha256, rel) || this.store.postedDigest(sharedId, sha256))) return null;
		const name = safeFileName(path.posix.basename(rel));
		const attachment = this.register(sharedId, { name, mimeType: contentTypeFor(name).split(";", 1)[0] as string, size, sha256, copiedPath: rel });
		return this.store.attachment(attachment.id) as AttachmentRow;
	}

	async shareFile(sharedId: string, sessionId: string, input: { path: string; caption: string | undefined; agent: { id: string | null; name: string | null } }): Promise<{ attachment: SharedAttachment; messageId: string }> {
		const row = (await this.registerFromFolder(sharedId, sessionId, input.path)) as AttachmentRow;
		const message = await this.hub.discussion.post(sharedId, { text: input.caption?.trim() ?? "", kind: "note", author: { kind: "agent", agentId: input.agent.id, agentName: input.agent.name }, attachmentIds: [row.id] });
		return { attachment: message.attachments.find((a) => a.id === row.id) ?? this.view(row), messageId: message.id };
	}
}
