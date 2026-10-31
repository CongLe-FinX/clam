import type { ContextAuthor } from "@clam/contracts";
import { canonicalBody, canonicalTitle, contextSha, versionId } from "./canonical.ts";

/**
 * Version model and the rules that decide what happens when versions meet (docs/agent-network-protocol.md §5.9).
 *
 * A context is a line of immutable versions. Every version names the version it was edited from (`base`), the versions
 * it resolves (`merged`, only for conflict resolutions) and the ids of everything it descends from (`ancestors`, capped), so a
 * receiver can tell a *fast-forward* (my head is in your ancestry) from *concurrent* work (neither contains the other)
 * without holding the history. Concurrent versions are never merged: the receiver keeps its head, remembers the other as
 * the competing version, and a human resolves it (`resolveConflict`) — the resolution is a new version that descends
 * from both, so it fast-forwards everywhere it is delivered.
 */

export interface VersionRef {
	version: number;
	sha256: string;
}

export interface VersionRecord {
	version: number;
	sha256: string;
	/** Canonical (`canonicalTitle`). Empty body for a tombstone. */
	title: string;
	/** Canonical (`canonicalBody`). */
	body: string;
	/** Tombstone: the context was deleted (or stopped being shared) in this version. */
	deleted: boolean;
	base: VersionRef | null;
	merged: VersionRef[];
	/** `<version>:<sha256>` of every ancestor, nearest first, at most `MAX_ANCESTORS`. */
	ancestors: string[];
	author: ContextAuthor;
	/** Node whose user (or agent) wrote this version. */
	originNodeId: string;
	createdAt: string;
}

/** A version of another node that could not be fast-forwarded onto the head. */
export interface CompetingVersion extends VersionRecord {
	fromNodeId: string;
	fromNodeName: string;
	/** When this node learned about it. */
	at: string;
}

export const MAX_ANCESTORS = 256;

const refOf = (v: VersionRef): VersionRef => ({ version: v.version, sha256: v.sha256 });

/** Ids of the parents and of everything they descend from, nearest first, unique, capped. */
export function lineageOf(parents: readonly VersionRecord[]): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	const add = (id: string): void => {
		if (!seen.has(id)) {
			seen.add(id);
			ids.push(id);
		}
	};
	for (const p of parents) add(versionId(p));
	for (const p of parents) for (const id of p.ancestors) add(id);
	return ids.slice(0, MAX_ANCESTORS);
}

export interface EditInput {
	title: string;
	body: string;
	deleted?: boolean;
	author: ContextAuthor;
	originNodeId: string;
	at: string;
}

/** The next version of a context on this node (`prev` null → version 1). Title and body are canonicalised here. */
export function createVersion(prev: VersionRecord | null, edit: EditInput): VersionRecord {
	const title = canonicalTitle(edit.title);
	const deleted = edit.deleted === true;
	const body = deleted ? "" : canonicalBody(edit.body);
	return {
		version: prev ? prev.version + 1 : 1,
		sha256: contextSha({ title, body, deleted }),
		title,
		body,
		deleted,
		base: prev ? refOf(prev) : null,
		merged: [],
		ancestors: prev ? lineageOf([prev]) : [],
		author: edit.author,
		originNodeId: edit.originNodeId,
		createdAt: edit.at,
	};
}

/** True when `sha256` really is the hash of the content (a peer or a file cannot claim another hash for its text). */
export function hasValidSha(v: Pick<VersionRecord, "title" | "body" | "deleted" | "sha256">): boolean {
	return contextSha({ title: v.title, body: v.body, deleted: v.deleted }) === v.sha256;
}

export type Verdict =
	/** Nothing local yet. */
	| "new"
	/** Same version already held. */
	| "duplicate"
	/** The incoming version descends from the head (or has the same content with a longer history): the head moves. */
	| "fast_forward"
	/** The incoming version is already part of the head's history. */
	| "stale"
	/** Concurrent edit of a deleted context: the edit wins and the context comes back. */
	| "resurrect"
	/** Concurrent deletion of an edited context: the edit stays, the deletion is ignored. */
	| "ignore_deletion"
	/** Concurrent edits (never merged). */
	| "conflict";

const sameContent = (a: VersionRecord, b: VersionRecord): boolean => a.sha256 === b.sha256 && a.deleted === b.deleted;

/** Everything `incoming` descends from: its ancestors and its direct parents. */
function descendsFrom(incoming: VersionRecord, ref: VersionRef): boolean {
	const id = versionId(ref);
	return incoming.ancestors.includes(id) || (incoming.base !== null && versionId(incoming.base) === id) || incoming.merged.some((m) => versionId(m) === id);
}

export function classify(head: VersionRecord | null, incoming: VersionRecord): Verdict {
	if (head === null) return "new";
	if (versionId(head) === versionId(incoming)) return "duplicate";
	if (descendsFrom(incoming, head)) return "fast_forward";
	if (descendsFrom(head, incoming)) return "stale";
	// Same text reached by different histories: no conflict, the longer history wins (both sides pick the same one).
	if (sameContent(head, incoming)) return incoming.version > head.version ? "fast_forward" : "stale";
	if (incoming.deleted && !head.deleted) return "ignore_deletion";
	if (head.deleted && !incoming.deleted) return "resurrect";
	if (head.deleted && incoming.deleted) return "stale";
	return "conflict";
}

export interface ContextState {
	head: VersionRecord | null;
	conflict: CompetingVersion | null;
}

export type Outcome = Verdict | "conflict_updated" | "conflict_extra";

export interface Applied {
	state: ContextState;
	outcome: Outcome;
	/** The incoming version should be kept as a snapshot (it became the head or the competing version). */
	keep: boolean;
}

/** True when `v` (the new head) makes the competing version obsolete: it descends from it, or it is the same text. */
function resolvesCompeting(v: VersionRecord, competing: CompetingVersion): boolean {
	return versionId(v) === versionId(competing) || descendsFrom(v, competing) || sameContent(v, competing);
}

/**
 * The pure state transition for one incoming version from another node. `from` names the node it came from. Never throws;
 * the caller persists `state` and, when `keep`, the incoming snapshot.
 */
export function applyIncoming(state: ContextState, incoming: VersionRecord, from: { nodeId: string; nodeName: string }, at: string): Applied {
	const verdict = classify(state.head, incoming);
	const moveHead = (outcome: Outcome): Applied => {
		const stillCompeting = state.conflict !== null && !resolvesCompeting(incoming, state.conflict);
		return { state: { head: incoming, conflict: stillCompeting ? state.conflict : null }, outcome, keep: true };
	};
	switch (verdict) {
		case "new":
			return moveHead("new");
		case "fast_forward":
		case "resurrect":
			return moveHead(verdict);
		case "duplicate":
		case "stale":
		case "ignore_deletion":
			return { state, outcome: verdict, keep: false };
		case "conflict": {
			const known = state.conflict;
			if (known === null) {
				return { state: { head: state.head, conflict: { ...incoming, fromNodeId: from.nodeId, fromNodeName: from.nodeName, at } }, outcome: "conflict", keep: true };
			}
			if (versionId(known) === versionId(incoming) || sameContent(known, incoming) || descendsFrom(known, incoming)) return { state, outcome: "duplicate", keep: false };
			// The same node moved on from the version we hold as competing: show its newest one.
			if (descendsFrom(incoming, known)) {
				return { state: { head: state.head, conflict: { ...incoming, fromNodeId: from.nodeId, fromNodeName: from.nodeName, at } }, outcome: "conflict_updated", keep: true };
			}
			// A third line of work while one conflict is open: reported, resolved later (the resolution reaches that node as a conflict of its own).
			return { state, outcome: "conflict_extra", keep: false };
		}
	}
}

export type ResolveKeep = "local" | "remote" | "merged";

export interface ResolveInput {
	keep: ResolveKeep;
	/** Required for `merged`. */
	body?: string;
	author: ContextAuthor;
	originNodeId: string;
	at: string;
}

/**
 * The resolution of an open conflict: a NEW version that descends from both the head and the competing version, with the
 * chosen content (`local` = head, `remote` = competing, `merged` = the head's title and the given body). Because it
 * descends from both, every node that has either version fast-forwards onto it. Throws `Error` when `merged` has no body.
 */
export function resolveConflict(state: { head: VersionRecord; conflict: CompetingVersion }, input: ResolveInput): VersionRecord {
	const { head, conflict } = state;
	if (input.keep === "merged" && input.body === undefined) throw new Error("A merged resolution needs the merged text");
	const chosen = input.keep === "remote" ? { title: conflict.title, body: conflict.body, deleted: conflict.deleted } : input.keep === "merged" ? { title: head.title, body: input.body ?? "", deleted: false } : { title: head.title, body: head.body, deleted: head.deleted };
	const title = canonicalTitle(chosen.title);
	const body = chosen.deleted ? "" : canonicalBody(chosen.body);
	return {
		version: Math.max(head.version, conflict.version) + 1,
		sha256: contextSha({ title, body, deleted: chosen.deleted }),
		title,
		body,
		deleted: chosen.deleted,
		base: refOf(head),
		merged: [refOf(conflict)],
		ancestors: lineageOf([head, conflict]),
		author: input.author,
		originNodeId: input.originNodeId,
		createdAt: input.at,
	};
}
