import { describe, expect, it } from "vitest";
import { PREFACE_END, buildPreface, firstLine, withPreface, type PrefaceItem } from "../src/index.ts";

const item = (type: PrefaceItem["type"], title: string, body: string, updatedAt: string): PrefaceItem => ({ type, title, body, updatedAt });

describe("firstLine", () => {
	it("skips headings marks, bullets and rules", () => {
		expect(firstLine("\n# Style\n\n- Tabs, no semicolons\nmore")).toBe("Style");
		expect(firstLine("---\n\n* bullet text")).toBe("bullet text");
		expect(firstLine("")).toBe("");
		expect(firstLine("x".repeat(300), 20)).toHaveLength(20);
	});
});

describe("buildPreface", () => {
	it("is null without items", () => {
		expect(buildPreface("P", [])).toBeNull();
	});

	it("lists memory first, then newest first, with title and first line", () => {
		const text = buildPreface("Billing \"core\"", [
			item("note", "Old note", "ancient", "2026-01-01"),
			item("decision", "Use SQLite", "Because it is embedded.\nMore.", "2026-02-01"),
			item("memory", "Coding style", "Tabs, no semicolons.", "2026-01-15"),
			item("decision", "Newer decision", "Fresh", "2026-03-01"),
		]) as string;
		const lines = text.split("\n");
		expect(lines[0]).toBe("[CL Agent Mesh] project memory · \"Billing 'core'\" · 4 items");
		expect(lines.slice(2, 6)).toEqual([
			"- [memory] Coding style — Tabs, no semicolons.",
			"- [decision] Newer decision — Fresh",
			"- [decision] Use SQLite — Because it is embedded.",
			"- [note] Old note — ancient",
		]);
		expect(lines.at(-1)).toBe(PREFACE_END);
	});

	it("stays within the cap and says how many items were left out", () => {
		const items = Array.from({ length: 80 }, (_, i) => item("note", `Note number ${i}`, `Some descriptive first line for note ${i}, long enough to matter`, `2026-01-${String((i % 28) + 1).padStart(2, "0")}`));
		const text = buildPreface("P", items) as string;
		expect(text.length).toBeLessThanOrEqual(2000);
		expect(text).toMatch(/\(\+\d+ more: use mesh_memory to search them\)\n\[end of project memory\]$/);
		const hidden = Number(text.match(/\(\+(\d+) more/)?.[1]);
		expect(text.split("\n").filter((l) => l.startsWith("- [")).length + hidden).toBe(80);
	});

	it("shortens a single huge item instead of dropping it", () => {
		const text = buildPreface("P", [item("memory", "T".repeat(190), "b".repeat(5000), "2026-01-01")], 600) as string;
		expect(text.length).toBeLessThanOrEqual(660);
		expect(text).toContain("- [memory] TTT");
	});

	it("prepends to the prompt", () => {
		const text = buildPreface("P", [item("memory", "A", "b", "2026-01-01")]) as string;
		expect(withPreface(text, "What is the style?")).toBe(`${text}\n\nWhat is the style?`);
	});
});
