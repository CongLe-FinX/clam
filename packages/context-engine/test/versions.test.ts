import type { ContextAuthor } from "@clam/contracts";
import { describe, expect, it } from "vitest";
import {
	applyIncoming,
	canonicalBody,
	canonicalTitle,
	classify,
	contextSha,
	createVersion,
	hasValidSha,
	resolveConflict,
	versionId,
	type ContextState,
	type VersionRecord,
} from "../src/index.ts";

const A: ContextAuthor = { kind: "human", nodeId: "node_a", nodeName: "A", agentName: null };
const B: ContextAuthor = { kind: "human", nodeId: "node_b", nodeName: "B", agentName: null };
const C: ContextAuthor = { kind: "human", nodeId: "node_c", nodeName: "C", agentName: null };
let clock = 0;
const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();

const edit = (prev: VersionRecord | null, title: string, body: string, who: ContextAuthor = A, deleted = false) =>
	createVersion(prev, { title, body, deleted, author: who, originNodeId: who.nodeId, at: at() });
const from = (n: ContextAuthor) => ({ nodeId: n.nodeId, nodeName: n.nodeName });
const empty: ContextState = { head: null, conflict: null };

describe("canonical text and hashing", () => {
	it("normalises line endings, trailing space and the final newline", () => {
		expect(canonicalBody("a\r\nb  \r\n\r\n")).toBe("a\nb\n");
		expect(canonicalBody("\n\nx")).toBe("x\n");
		expect(canonicalBody("  \n")).toBe("");
		expect(canonicalTitle("  A \n  title  ")).toBe("A title");
	});

	it("hashes title, body and the tombstone flag", () => {
		const base = contextSha({ title: "T", body: "b\n" });
		expect(base).toMatch(/^[0-9a-f]{64}$/);
		expect(contextSha({ title: "T", body: "b\n" })).toBe(base);
		expect(contextSha({ title: "T2", body: "b\n" })).not.toBe(base);
		expect(contextSha({ title: "T", body: "b2\n" })).not.toBe(base);
		expect(contextSha({ title: "T", body: "", deleted: true })).not.toBe(contextSha({ title: "T", body: "" }));
	});

	it("an edit that only changes line endings is the same text", () => {
		const v1 = edit(null, "Style", "tabs\n");
		expect(edit(v1, "Style", "tabs\r\n").sha256).toBe(v1.sha256);
	});
});

describe("local versions", () => {
	it("numbers versions per context and records the lineage", () => {
		const v1 = edit(null, "T", "one");
		const v2 = edit(v1, "T", "two");
		const v3 = edit(v2, "T", "three");
		expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
		expect(v1.base).toBeNull();
		expect(v3.base).toEqual({ version: 2, sha256: v2.sha256 });
		expect(v3.ancestors).toEqual([versionId(v2), versionId(v1)]);
		expect(hasValidSha(v3)).toBe(true);
		expect(hasValidSha({ ...v3, body: "tampered\n" })).toBe(false);
	});

	it("a tombstone has no body and a different hash", () => {
		const v1 = edit(null, "T", "secret text");
		const t = edit(v1, "T", "ignored", A, true);
		expect(t.deleted).toBe(true);
		expect(t.body).toBe("");
		expect(t.sha256).not.toBe(v1.sha256);
	});
});

describe("classifying an incoming version", () => {
	it("creates, deduplicates, fast-forwards and recognises stale versions", () => {
		const v1 = edit(null, "T", "one");
		const v2 = edit(v1, "T", "two");
		const v3 = edit(v2, "T", "three");
		expect(classify(null, v1)).toBe("new");
		expect(classify(v2, v2)).toBe("duplicate");
		expect(classify(v1, v2)).toBe("fast_forward");
		expect(classify(v1, v3)).toBe("fast_forward"); // several versions ahead: the head is in its ancestry
		expect(classify(v3, v1)).toBe("stale");
		expect(classify(v3, v2)).toBe("stale");
	});

	it("same base, different text is a conflict", () => {
		const v1 = edit(null, "T", "base");
		const a = edit(v1, "T", "from A", A);
		const b = edit(v1, "T", "from B", B);
		expect(a.version).toBe(b.version);
		expect(classify(a, b)).toBe("conflict");
		expect(classify(b, a)).toBe("conflict");
	});

	it("the same text written independently is the same version, not a conflict", () => {
		const v1 = edit(null, "T", "base");
		const a = edit(v1, "T", "same words", A);
		const b = edit(v1, "T", "same words", B);
		expect(versionId(a)).toBe(versionId(b));
		expect(classify(a, b)).toBe("duplicate");
	});

	it("equal text reached by different histories converges on the longer one", () => {
		const v1 = edit(null, "T", "base");
		const longA = edit(edit(edit(v1, "T", "x", A), "T", "y", A), "T", "final", A);
		const shortB = edit(edit(v1, "T", "z", B), "T", "final", B);
		expect(longA.version).toBeGreaterThan(shortB.version);
		expect(classify(shortB, longA)).toBe("fast_forward");
		expect(classify(longA, shortB)).toBe("stale");
	});

	it("an edit beats a concurrent deletion on both sides", () => {
		const v1 = edit(null, "T", "base");
		const edited = edit(v1, "T", "edited", B);
		const deleted = edit(v1, "T", "", A, true);
		expect(classify(deleted, edited)).toBe("resurrect");
		expect(classify(edited, deleted)).toBe("ignore_deletion");
	});
});

describe("applying incoming versions (state machine)", () => {
	it("fast-forwards the head and keeps the snapshot", () => {
		const v1 = edit(null, "T", "one");
		const v2 = edit(v1, "T", "two");
		const first = applyIncoming(empty, v1, from(A), at());
		expect(first.outcome).toBe("new");
		const second = applyIncoming(first.state, v2, from(A), at());
		expect(second).toMatchObject({ outcome: "fast_forward", keep: true });
		expect(second.state.head?.version).toBe(2);
		expect(applyIncoming(second.state, v1, from(A), at())).toMatchObject({ outcome: "stale", keep: false });
	});

	it("records the competing version without touching the head", () => {
		const v1 = edit(null, "T", "base");
		const local = edit(v1, "T", "local", A);
		const remote = edit(v1, "T", "remote", B);
		const r = applyIncoming({ head: local, conflict: null }, remote, from(B), at());
		expect(r.outcome).toBe("conflict");
		expect(r.state.head).toBe(local);
		expect(r.state.conflict).toMatchObject({ sha256: remote.sha256, fromNodeId: "node_b", fromNodeName: "B" });
		// The same push again is a duplicate, not a second conflict.
		expect(applyIncoming(r.state, remote, from(B), at()).outcome).toBe("duplicate");
	});

	it("shows the competing node's newest version while the conflict is open", () => {
		const v1 = edit(null, "T", "base");
		const local = edit(v1, "T", "local", A);
		const remote = edit(v1, "T", "remote", B);
		const remote2 = edit(remote, "T", "remote again", B);
		const open = applyIncoming({ head: local, conflict: null }, remote, from(B), at()).state;
		const r = applyIncoming(open, remote2, from(B), at());
		expect(r.outcome).toBe("conflict_updated");
		expect(r.state.conflict?.sha256).toBe(remote2.sha256);
	});

	it("reports (but does not store) a third line of work", () => {
		const v1 = edit(null, "T", "base");
		const local = edit(v1, "T", "local", A);
		const remote = edit(v1, "T", "remote", B);
		const third = edit(v1, "T", "third", C);
		const open = applyIncoming({ head: local, conflict: null }, remote, from(B), at()).state;
		const r = applyIncoming(open, third, from(C), at());
		expect(r).toMatchObject({ outcome: "conflict_extra", keep: false });
		expect(r.state.conflict?.sha256).toBe(remote.sha256);
	});

	it("a resolution made elsewhere fast-forwards and closes the conflict on this node", () => {
		const v1 = edit(null, "T", "base");
		const a = edit(v1, "T", "A text", A);
		const b = edit(v1, "T", "B text", B);
		// Both nodes see the conflict.
		const onA = applyIncoming({ head: a, conflict: null }, b, from(B), at()).state as { head: VersionRecord; conflict: NonNullable<ContextState["conflict"]> };
		const onB = applyIncoming({ head: b, conflict: null }, a, from(A), at()).state as typeof onA;
		// B resolves keeping A's text; delivery to A and B's own state.
		const resolved = resolveConflict(onB, { keep: "remote", author: B, originNodeId: B.nodeId, at: at() });
		expect(resolved.version).toBe(3);
		expect(resolved.body).toBe(a.body);
		expect(resolved.merged).toEqual([{ version: 2, sha256: a.sha256 }]);
		const delivered = applyIncoming(onA, resolved, from(B), at());
		expect(delivered.outcome).toBe("fast_forward");
		expect(delivered.state.conflict).toBeNull();
		expect(delivered.state.head?.sha256).toBe(resolved.sha256);
	});

	it("keep local re-asserts the head with a new version both sides accept", () => {
		const v1 = edit(null, "T", "base");
		const a = edit(v1, "T", "A text", A);
		const b = edit(v1, "T", "B text", B);
		const onA = applyIncoming({ head: a, conflict: null }, b, from(B), at()).state as { head: VersionRecord; conflict: NonNullable<ContextState["conflict"]> };
		const kept = resolveConflict(onA, { keep: "local", author: A, originNodeId: A.nodeId, at: at() });
		expect(kept.sha256).toBe(a.sha256);
		expect(kept.version).toBe(3);
		expect(versionId(kept)).not.toBe(versionId(a));
		// B still holds its own head with A's text as the competing version.
		const onB = applyIncoming({ head: b, conflict: null }, a, from(A), at()).state;
		const r = applyIncoming(onB, kept, from(A), at());
		expect(r.outcome).toBe("fast_forward");
		expect(r.state.conflict).toBeNull();
	});

	it("a merged resolution carries the new text and needs a body", () => {
		const v1 = edit(null, "T", "base");
		const a = edit(v1, "T", "A", A);
		const b = edit(v1, "T", "B", B);
		const open = applyIncoming({ head: a, conflict: null }, b, from(B), at()).state as { head: VersionRecord; conflict: NonNullable<ContextState["conflict"]> };
		expect(() => resolveConflict(open, { keep: "merged", author: A, originNodeId: A.nodeId, at: at() })).toThrow(/merged text/);
		const merged = resolveConflict(open, { keep: "merged", body: "A and B", author: A, originNodeId: A.nodeId, at: at() });
		expect(merged.body).toBe("A and B\n");
		expect(merged.ancestors).toContain(versionId(a));
		expect(merged.ancestors).toContain(versionId(b));
	});

	it("both nodes resolving with the same text converge without a second conflict", () => {
		const v1 = edit(null, "T", "base");
		const a = edit(v1, "T", "A", A);
		const b = edit(v1, "T", "B", B);
		const onA = applyIncoming({ head: a, conflict: null }, b, from(B), at()).state as { head: VersionRecord; conflict: NonNullable<ContextState["conflict"]> };
		const onB = applyIncoming({ head: b, conflict: null }, a, from(A), at()).state as typeof onA;
		const ra = resolveConflict(onA, { keep: "merged", body: "joint", author: A, originNodeId: A.nodeId, at: at() });
		const rb = resolveConflict(onB, { keep: "merged", body: "joint", author: B, originNodeId: B.nodeId, at: at() });
		expect(versionId(ra)).toBe(versionId(rb));
		expect(classify(ra, rb)).toBe("duplicate");
	});

	it("an edit stays when a deletion arrives concurrently; a deleted context comes back with a concurrent edit", () => {
		const v1 = edit(null, "T", "base");
		const edited = edit(v1, "T", "edited", B);
		const deleted = edit(v1, "T", "", A, true);
		expect(applyIncoming({ head: edited, conflict: null }, deleted, from(A), at())).toMatchObject({ outcome: "ignore_deletion", keep: false });
		const back = applyIncoming({ head: deleted, conflict: null }, edited, from(B), at());
		expect(back.outcome).toBe("resurrect");
		expect(back.state.head?.deleted).toBe(false);
	});
});
