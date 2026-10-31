import { describe, expect, it } from "vitest";
import { isBinary, textDiff } from "../src/index.ts";

describe("textDiff", () => {
	it("returns empty for identical text", () => {
		expect(textDiff("a\nb\n", "a\nb\n", "f.txt")).toBe("");
	});

	it("produces a unified diff with headers, context and hunk ranges", () => {
		const oldText = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
		const newText = oldText.replace("line 6\n", "line six\n");
		expect(textDiff(oldText, newText, "src/f.txt")).toBe(
			[
				"--- a/src/f.txt",
				"+++ b/src/f.txt",
				"@@ -3,7 +3,7 @@",
				" line 3",
				" line 4",
				" line 5",
				"-line 6",
				"+line six",
				" line 7",
				" line 8",
				" line 9",
				"",
			].join("\n"),
		);
	});

	it("handles insertions into / deletions from empty files and splits distant hunks", () => {
		expect(textDiff("", "a\nb\n", "n.txt")).toBe("--- a/n.txt\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n");
		expect(textDiff("a\nb\n", "", "n.txt")).toBe("--- a/n.txt\n+++ b/n.txt\n@@ -1,2 +0,0 @@\n-a\n-b\n");
		const base = Array.from({ length: 40 }, (_, i) => `l${i}`);
		const changed = [...base];
		changed[2] = "X";
		changed[37] = "Y";
		const diff = textDiff(base.join("\n") + "\n", changed.join("\n") + "\n", "f");
		expect(diff.match(/^@@/gm)).toHaveLength(2);
	});

	it("marks missing trailing newlines", () => {
		const diff = textDiff("a\nb", "a\nb\n", "f");
		expect(diff).toContain("-b\n\\ No newline at end of file\n+b\n");
	});

	it("applying the diff semantics hold on a randomized edit (roundtrip via simple patcher)", () => {
		let seed = 42;
		const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
		for (let round = 0; round < 25; round++) {
			const a = Array.from({ length: 30 + Math.floor(rnd() * 30) }, (_, i) => `row ${i % 7} ${Math.floor(rnd() * 5)}`);
			const b = a.filter(() => rnd() > 0.15);
			for (let k = 0; k < 6; k++) b.splice(Math.floor(rnd() * b.length), 0, `ins ${k} ${Math.floor(rnd() * 3)}`);
			const diff = textDiff(a.join("\n") + "\n", b.join("\n") + "\n", "f");
			expect(patch(a, diff)).toEqual(b);
		}
	});

	it("caps output and degrades gracefully on huge or totally different inputs", () => {
		const a = Array.from({ length: 5000 }, (_, i) => `a${i}`).join("\n") + "\n";
		const b = Array.from({ length: 5000 }, (_, i) => `b${i}`).join("\n") + "\n";
		const diff = textDiff(a, b, "big");
		expect(diff.length).toBeLessThan(70_000);
		expect(diff).toContain("@@ diff truncated @@");
		const huge = "x\n".repeat(1_500_000);
		expect(textDiff(huge, huge + "y\n", "huge")).toContain("diff omitted");
	});

	it("reports binary files without a body", () => {
		expect(textDiff("a\0b", "a\0c", "x.bin")).toBe("Binary files a/x.bin and b/x.bin differ\n");
		expect(isBinary(Buffer.from([1, 2, 0, 3]))).toBe(true);
		expect(isBinary(Buffer.from("plain text"))).toBe(false);
	});
});

/** Apply a unified diff (produced above) to `lines`. */
function patch(lines: string[], diff: string): string[] {
	const out: string[] = [];
	let pos = 0;
	const rows = diff.split("\n");
	for (let i = 2; i < rows.length; i++) {
		const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(rows[i] as string);
		if (!m) continue;
		const start = Number(m[2] === "0" ? m[1] : Number(m[1]) - 1);
		while (pos < start) out.push(lines[pos++] as string);
		for (i++; i < rows.length && !(rows[i] as string).startsWith("@@"); i++) {
			const row = rows[i] as string;
			if (row.startsWith("+")) out.push(row.slice(1));
			else if (row.startsWith("-")) pos++;
			else if (row.startsWith(" ")) out.push(lines[pos++] as string);
		}
		i--;
	}
	while (pos < lines.length) out.push(lines[pos++] as string);
	return out;
}
