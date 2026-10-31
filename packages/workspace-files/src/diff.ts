/** Unified diff (Myers, with common prefix/suffix trimming and hard caps). */

const CONTEXT = 3;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_EDIT_DISTANCE = 2000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/** Heuristic binary detection: a NUL byte in the first 8000 bytes (same as git). */
export function isBinary(data: Uint8Array): boolean {
	const n = Math.min(data.length, 8000);
	for (let i = 0; i < n; i++) if (data[i] === 0) return true;
	return false;
}

interface Split {
	/** Comparison keys; the last line carries a marker when the text lacks a trailing newline. */
	keys: string[];
	lines: string[];
	noEol: boolean;
}

function split(text: string): Split {
	if (text === "") return { keys: [], lines: [], noEol: false };
	const lines = text.split("\n");
	let noEol = true;
	if (lines[lines.length - 1] === "") {
		lines.pop();
		noEol = false;
	}
	const keys = [...lines];
	if (noEol) keys[keys.length - 1] = `${keys[keys.length - 1] as string}\u0000<no-eol>`;
	return { keys, lines, noEol };
}

type Op = { kind: " " | "-" | "+"; a: number; b: number };

/** Edit script between a[lo..] and b[lo..] bounded slices; returns null when the distance exceeds the cap. */
function myers(a: string[], b: string[]): Array<"=" | "-" | "+"> | null {
	const n = a.length;
	const m = b.length;
	const max = Math.min(n + m, MAX_EDIT_DISTANCE);
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	let found = -1;
	for (let d = 0; d <= max && found === -1; d++) {
		const snapshot = new Int32Array(2 * d + 3);
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) {
				x = v[offset + k + 1] as number;
			} else {
				x = (v[offset + k - 1] as number) + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = d;
				break;
			}
		}
		for (let k = -d; k <= d; k++) snapshot[k + d + 1] = v[offset + k] as number;
		trace.push(snapshot);
	}
	if (found === -1) return null;
	// Backtrack.
	const script: Array<"=" | "-" | "+"> = [];
	let x = n;
	let y = m;
	for (let d = found; d > 0; d--) {
		const prev = trace[d - 1] as Int32Array;
		const k = x - y;
		const at = (kk: number) => prev[kk + (d - 1) + 1] as number;
		let prevK: number;
		if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1;
		else prevK = k - 1;
		const prevX = at(prevK);
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			script.push("=");
			x--;
			y--;
		}
		if (x === prevX) script.push("+");
		else script.push("-");
		x = prevX;
		y = prevY;
	}
	while (x > 0 && y > 0) {
		script.push("=");
		x--;
		y--;
	}
	script.reverse();
	return script;
}

function buildOps(a: Split, b: Split): Op[] {
	let prefix = 0;
	while (prefix < a.keys.length && prefix < b.keys.length && a.keys[prefix] === b.keys[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < a.keys.length - prefix &&
		suffix < b.keys.length - prefix &&
		a.keys[a.keys.length - 1 - suffix] === b.keys[b.keys.length - 1 - suffix]
	) {
		suffix++;
	}
	const midA = a.keys.slice(prefix, a.keys.length - suffix);
	const midB = b.keys.slice(prefix, b.keys.length - suffix);
	const ops: Op[] = [];
	let ai = 0;
	let bi = 0;
	for (; ai < prefix; ai++, bi++) ops.push({ kind: " ", a: ai, b: bi });
	const script = myers(midA, midB) ?? [...midA.map(() => "-" as const), ...midB.map(() => "+" as const)];
	for (const step of script) {
		if (step === "=") ops.push({ kind: " ", a: ai++, b: bi++ });
		else if (step === "-") ops.push({ kind: "-", a: ai++, b: bi });
		else ops.push({ kind: "+", a: ai, b: bi++ });
	}
	for (let i = 0; i < suffix; i++) ops.push({ kind: " ", a: ai++, b: bi++ });
	return ops;
}

function range(start: number, count: number): string {
	// Unified-diff convention: an empty range reports the line *before* it.
	if (count === 0) return `${start},0`;
	if (count === 1) return `${start + 1}`;
	return `${start + 1},${count}`;
}

/** Unified diff of two text files; "" when identical. Output is capped (64 KiB) and large inputs are summarized. */
export function textDiff(oldText: string, newText: string, path: string): string {
	if (oldText === newText) return "";
	const head = `--- a/${path}\n+++ b/${path}\n`;
	if (oldText.includes("\0") || newText.includes("\0")) return `Binary files a/${path} and b/${path} differ\n`;
	if (oldText.length + newText.length > MAX_INPUT_BYTES) {
		return `${head}@@ diff omitted: file too large (${oldText.length} -> ${newText.length} chars) @@\n`;
	}
	const a = split(oldText);
	const b = split(newText);
	const ops = buildOps(a, b);
	const changes: number[] = [];
	ops.forEach((op, i) => {
		if (op.kind !== " ") changes.push(i);
	});
	let out = head;
	let i = 0;
	let truncated = false;
	while (i < changes.length && !truncated) {
		const start = Math.max(0, (changes[i] as number) - CONTEXT);
		let end = Math.min(ops.length, (changes[i] as number) + CONTEXT + 1);
		// Merge following changes whose context overlaps.
		let j = i + 1;
		while (j < changes.length && (changes[j] as number) - CONTEXT <= end) {
			end = Math.min(ops.length, (changes[j] as number) + CONTEXT + 1);
			j++;
		}
		i = j;
		const slice = ops.slice(start, end);
		const aStart = (slice[0] as Op).a;
		const bStart = (slice[0] as Op).b;
		const aCount = slice.filter((o) => o.kind !== "+").length;
		const bCount = slice.filter((o) => o.kind !== "-").length;
		let hunk = `@@ -${range(aStart, aCount)} +${range(bStart, bCount)} @@\n`;
		for (const op of slice) {
			const line = op.kind === "+" ? (b.lines[op.b] as string) : (a.lines[op.a] as string);
			hunk += `${op.kind}${line}\n`;
			const isLastOld = op.kind !== "+" && op.a === a.lines.length - 1 && a.noEol;
			const isLastNew = op.kind === "+" && op.b === b.lines.length - 1 && b.noEol;
			const isLastCommon = op.kind === " " && op.b === b.lines.length - 1 && b.noEol;
			if (isLastOld || isLastNew || isLastCommon) hunk += "\\ No newline at end of file\n";
		}
		if (out.length + hunk.length > MAX_OUTPUT_BYTES) {
			out += "@@ diff truncated @@\n";
			truncated = true;
		} else {
			out += hunk;
		}
	}
	return out;
}
