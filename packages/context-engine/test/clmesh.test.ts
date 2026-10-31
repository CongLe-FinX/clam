import { describe, expect, it } from "vitest";
import {
	applyIncoming,
	classify,
	contextPath,
	createVersion,
	fileToVersion,
	isContextFilePath,
	parseContextFile,
	parseIndex,
	renderContextFile,
	renderIndex,
	slugify,
	type ExportableContext,
} from "../src/index.ts";

const A = { kind: "human", nodeId: "node_a", nodeName: "Node A", agentName: null } as const;
const at = "2026-10-31T10:00:00.000Z";

const exportable = (over: Partial<ExportableContext> = {}): ExportableContext => ({
	id: "ctx_0123456789abcdef",
	type: "memory",
	title: 'Coding style: "tabs", no semicolons',
	body: "Use tabs.\nNo semicolons.\n",
	version: 2,
	sha256: "a".repeat(64),
	base: { version: 1, sha256: "b".repeat(64) },
	scope: "project",
	author: A,
	updatedAt: at,
	...over,
});

describe("paths", () => {
	it("slugifies titles (diacritics folded, never empty)", () => {
		expect(slugify("Coding style: tabs!")).toBe("coding-style-tabs");
		expect(slugify("Quy ước đặt tên")).toBe("quy-uoc-dat-ten");
		expect(slugify("日本語")).toBe("context");
		expect(slugify("x".repeat(100))).toHaveLength(60);
	});

	it("maps each type to its directory; decisions are dated; clashes get the id suffix", () => {
		const base = { id: "ctx_0123456789abcdef", title: "Use SQLite", createdAt: "2026-03-09T08:00:00.000Z" };
		expect(contextPath({ ...base, type: "memory" }, new Set())).toBe("memory/use-sqlite.md");
		expect(contextPath({ ...base, type: "decision" }, new Set())).toBe("decisions/2026-03-09-use-sqlite.md");
		expect(contextPath({ ...base, type: "plan" }, new Set())).toBe("plans/use-sqlite.md");
		expect(contextPath({ ...base, type: "note" }, new Set())).toBe("notes/use-sqlite.md");
		expect(contextPath({ ...base, type: "summary" }, new Set())).toBe("summaries/use-sqlite.md");
		expect(contextPath({ ...base, type: "memory" }, new Set(["memory/use-sqlite.md"]))).toBe("memory/use-sqlite-abcdef.md");
	});

	it("only memory/decisions/plans/notes/summaries markdown files are context files", () => {
		for (const ok of ["memory/a.md", "decisions/2026-01-01-x.md", "plans/p.md", "notes/n.md", "summaries/s.md"]) expect(isContextFilePath(ok)).toBe(true);
		for (const bad of ["README.md", "memory/sub/a.md", "memory/a.txt", "tasks/t.json", "../memory/a.md", "memory/.md", "memory/"]) expect(isContextFilePath(bad)).toBe(false);
	});
});

describe("files", () => {
	it("round-trips a context through its file", () => {
		const text = renderContextFile(exportable());
		expect(text.startsWith("---\nid: ctx_0123456789abcdef\n")).toBe(true);
		const parsed = parseContextFile(text, "memory/coding-style.md");
		if (!parsed.ok) throw new Error(parsed.reason);
		expect(parsed.title).toBe('Coding style: "tabs", no semicolons');
		expect(parsed.body).toBe("Use tabs.\nNo semicolons.\n");
		expect(parsed.front).toMatchObject({ id: "ctx_0123456789abcdef", version: 2, sha256: "a".repeat(64), base: `1:${"b".repeat(64)}`, scope: "project", shareable: true });
	});

	it("rejects malformed, mismatched and private files", () => {
		const good = renderContextFile(exportable());
		expect(parseContextFile("no front matter", "memory/a.md")).toMatchObject({ ok: false });
		expect(parseContextFile(good.replace("type: memory", "type: plan"), "memory/a.md")).toMatchObject({ ok: false });
		expect(parseContextFile(good.replace("shareable: true", "shareable: false"), "memory/a.md")).toMatchObject({ ok: false });
		expect(parseContextFile(good.replace("id: ctx_0123456789abcdef", "id: ../../etc/passwd"), "memory/a.md")).toMatchObject({ ok: false });
		expect(parseContextFile(good.replace(/sha256: a+/, "sha256: nothex"), "memory/a.md")).toMatchObject({ ok: false });
		expect(parseContextFile(good.replace("\n---\n", "\n"), "memory/a.md")).toMatchObject({ ok: false });
	});

	it("a title with quotes, colons or newlines cannot break the front matter", () => {
		const text = renderContextFile(exportable({ title: 'a: b\n---\nid: ctx_evilevilevil0000' }));
		const parsed = parseContextFile(text, "memory/a.md");
		if (!parsed.ok) throw new Error(parsed.reason);
		expect(parsed.front.id).toBe("ctx_0123456789abcdef");
	});
});

describe("importing a file as a version", () => {
	const local = createVersion(null, { title: "Style", body: "tabs", author: A, originNodeId: A.nodeId, at });
	const next = createVersion(local, { title: "Style", body: "tabs, always", author: A, originNodeId: A.nodeId, at });
	const fileOf = (v: typeof next) =>
		renderContextFile(exportable({ title: v.title, body: v.body, version: v.version, sha256: v.sha256, base: v.base }));

	it("an untouched file of a newer version fast-forwards the local head", () => {
		const parsed = parseContextFile(fileOf(next), "memory/style.md");
		if (!parsed.ok) throw new Error(parsed.reason);
		const { version, edited } = fileToVersion(parsed, { author: A, originNodeId: A.nodeId, at });
		expect(edited).toBe(false);
		expect(classify(local, version)).toBe("fast_forward");
	});

	it("an older file is stale and the identical file is a duplicate", () => {
		const old = parseContextFile(fileOf(local), "memory/style.md");
		if (!old.ok) throw new Error(old.reason);
		expect(classify(next, fileToVersion(old, { author: A, originNodeId: A.nodeId, at }).version)).toBe("stale");
		expect(classify(local, fileToVersion(old, { author: A, originNodeId: A.nodeId, at }).version)).toBe("duplicate");
	});

	it("a hand-edited file is a new version based on the one in its front matter", () => {
		const edited = fileOf(local).replace("tabs", "spaces");
		const parsed = parseContextFile(edited, "memory/style.md");
		if (!parsed.ok) throw new Error(parsed.reason);
		const r = fileToVersion(parsed, { author: A, originNodeId: A.nodeId, at });
		expect(r.edited).toBe(true);
		expect(r.version.version).toBe(local.version + 1);
		expect(r.version.base).toEqual({ version: local.version, sha256: local.sha256 });
		// Based on the local head: fast-forward. Based on an older version while the local head moved on: conflict.
		expect(classify(local, r.version)).toBe("fast_forward");
		expect(applyIncoming({ head: next, conflict: null }, r.version, { nodeId: "git", nodeName: "git" }, at).outcome).toBe("conflict");
	});
});

describe("index.json", () => {
	it("is sorted, one entry per line, and parses back", () => {
		const text = renderIndex([
			{ id: "ctx_bbbbbbbbbbbbbbbb", path: "plans/b.md", sha256: "2".repeat(64), version: 3 },
			{ id: "ctx_aaaaaaaaaaaaaaaa", path: "memory/a.md", sha256: "1".repeat(64), version: 1 },
		]);
		const lines = text.split("\n");
		expect(lines[0]).toBe("{");
		expect(lines[1]).toBe('  "contexts": [');
		expect(lines[2]).toContain('"path":"memory/a.md"');
		expect(lines[2]).toMatch(/^ {4}\{"id":"ctx_a\w+","path":"memory\/a\.md","sha256":"1+","version":1\},$/);
		expect(lines[3]).toContain('"path":"plans/b.md"');
		expect(text.endsWith('  ],\n  "schema": 1\n}\n')).toBe(true);
		expect(parseIndex(text)).toEqual([
			{ id: "ctx_aaaaaaaaaaaaaaaa", path: "memory/a.md", sha256: "1".repeat(64), version: 1 },
			{ id: "ctx_bbbbbbbbbbbbbbbb", path: "plans/b.md", sha256: "2".repeat(64), version: 3 },
		]);
		expect(renderIndex([])).toBe('{\n  "contexts": [],\n  "schema": 1\n}\n');
		expect(parseIndex("not json")).toBeNull();
	});
});
