/** Small line-level diff (LCS) for comparing two versions of a text document. Inputs are capped by the caller's document size. */
export type DiffOp = { kind: "same" | "add" | "del"; text: string };

const MAX_CELLS = 4_000_000;

export function lineDiff(a: string, b: string): DiffOp[] {
	const x = a === "" ? [] : a.split("\n");
	const y = b === "" ? [] : b.split("\n");
	let start = 0;
	while (start < x.length && start < y.length && x[start] === y[start]) start++;
	let endX = x.length;
	let endY = y.length;
	while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
		endX--;
		endY--;
	}
	const head = x.slice(0, start).map((text): DiffOp => ({ kind: "same", text }));
	const tail = x.slice(endX).map((text): DiffOp => ({ kind: "same", text }));
	const mx = x.slice(start, endX);
	const my = y.slice(start, endY);
	let mid: DiffOp[];
	if (mx.length * my.length > MAX_CELLS) {
		mid = [...mx.map((text): DiffOp => ({ kind: "del", text })), ...my.map((text): DiffOp => ({ kind: "add", text }))];
	} else {
		const w = my.length + 1;
		const dp = new Uint32Array((mx.length + 1) * w);
		for (let i = mx.length - 1; i >= 0; i--) {
			for (let j = my.length - 1; j >= 0; j--) {
				dp[i * w + j] = mx[i] === my[j] ? (dp[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(dp[(i + 1) * w + j] ?? 0, dp[i * w + j + 1] ?? 0);
			}
		}
		mid = [];
		let i = 0;
		let j = 0;
		while (i < mx.length && j < my.length) {
			if (mx[i] === my[j]) {
				mid.push({ kind: "same", text: mx[i] ?? "" });
				i++;
				j++;
			} else if ((dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + j + 1] ?? 0)) mid.push({ kind: "del", text: mx[i++] ?? "" });
			else mid.push({ kind: "add", text: my[j++] ?? "" });
		}
		while (i < mx.length) mid.push({ kind: "del", text: mx[i++] ?? "" });
		while (j < my.length) mid.push({ kind: "add", text: my[j++] ?? "" });
	}
	return [...head, ...mid, ...tail];
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const o of ops) {
		if (o.kind === "add") added++;
		else if (o.kind === "del") removed++;
	}
	return { added, removed };
}
