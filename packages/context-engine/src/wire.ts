import { ContextAuthor, ContextType } from "@clam/contracts";
import { z } from "zod";
import { CONTEXT_ID, MAX_BODY_CHARS, MAX_TITLE_CHARS, SHA256 } from "./canonical.ts";
import { MAX_ANCESTORS } from "./versions.ts";

/**
 * Wire payloads of the context endpoints (docs/agent-network-protocol.md §5.9). Unknown fields are ignored (protocol
 * §13). Every payload entry is validated again by the receiver: sizes here, the hash of the text in the engine.
 */

const ContextId = z.string().regex(CONTEXT_ID);
const Sha = z.string().regex(SHA256);
const VersionNo = z.number().int().min(1).max(1_000_000_000);
const Ref = z.object({ version: VersionNo, sha256: Sha });

/** One version of a shareable context (`push`). */
export const WireVersion = z.object({
	contextId: ContextId,
	type: ContextType,
	/** Cross-node project identity; null = workspace-wide. */
	projectKey: z.string().max(300).nullable(),
	/** The node that created the context. */
	originNodeId: z.string().min(1).max(128),
	/** When the context was created (its first version's time on the creating node). */
	contextCreatedAt: z.string().min(1).max(64),
	version: VersionNo,
	sha256: Sha,
	title: z.string().max(MAX_TITLE_CHARS),
	body: z.string().max(MAX_BODY_CHARS),
	deleted: z.boolean().default(false),
	base: Ref.nullable().default(null),
	merged: z.array(Ref).max(16).default([]),
	ancestors: z.array(z.string().max(80)).max(MAX_ANCESTORS).default([]),
	author: ContextAuthor,
	/** The node whose user or agent wrote this version. */
	versionOriginNodeId: z.string().min(1).max(128),
	createdAt: z.string().min(1).max(64),
});
export type WireVersion = z.infer<typeof WireVersion>;

export const WireHave = z.object({ contextId: ContextId, version: VersionNo, sha256: Sha, deleted: z.boolean().default(false) });
export type WireHave = z.infer<typeof WireHave>;

/** Entries per request / per answer (bounds the request size under the listener's 1 MiB body limit). */
export const MAX_HAVE = 400;
export const MAX_PUSH = 40;
/** Serialized push bytes one request carries (a single larger entry travels alone). */
export const MAX_PUSH_BYTES = 640 * 1024;

/** `POST /context/sync` request (sender → receiver). */
export const ContextSyncRequest = z.object({
	workspaceId: z.string().min(1).max(128),
	have: z.array(WireHave).max(MAX_HAVE).default([]),
	push: z.array(WireVersion).max(MAX_PUSH).default([]),
});
export type ContextSyncRequest = z.infer<typeof ContextSyncRequest>;

const Head = z.object({ contextId: ContextId, version: VersionNo, sha256: Sha });

/** The receiver's answer. */
export const ContextSyncResponse = z.object({
	/** Versions the receiver lacks: the sender pushes them next. */
	want: z.array(z.object({ contextId: ContextId, sinceVersion: z.number().int().min(0) })).default([]),
	/** Pushes applied (or already held) and `have` entries it holds: the receiver's head after applying. */
	accepted: z.array(Head).default([]),
	/** Concurrent edits, never merged: both sides now report a conflict. */
	conflicts: z.array(z.object({ contextId: ContextId, localVersion: z.number().int(), remoteVersion: z.number().int() })).default([]),
	/** The receiver's head already descends from what was offered: it is ahead (it pushes to the sender by itself). */
	ahead: z.array(Head).default([]),
	/** Entries the receiver refused (unknown workspace, private on the receiver, hash mismatch, ...). */
	rejected: z.array(z.object({ contextId: z.string(), reason: z.string().max(200) })).default([]),
});
export type ContextSyncResponse = z.infer<typeof ContextSyncResponse>;

/** `POST /context/membership`: a node added to / removed from a workspace tells that node. */
export const ContextMembershipRequest = z.object({
	workspaceId: z.string().min(1).max(128),
	workspaceName: z.string().min(1).max(200),
	action: z.enum(["add", "remove"]),
	/** The workspace owner's node id as the sender knows it. */
	ownerNodeId: z.string().min(1).max(128),
	/** Capabilities the sender lists for the receiver in this workspace (informational). */
	permissions: z.array(z.string().max(64)).max(32).default([]),
});
export type ContextMembershipRequest = z.infer<typeof ContextMembershipRequest>;
