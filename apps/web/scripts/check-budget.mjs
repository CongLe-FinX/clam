// Enforces the initial-load JS budget: every script/modulepreload referenced by dist/index.html, gzipped.
import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const BUDGET_KB = Number(process.env.SHELL_BUDGET_KB ?? 180);
const html = readFileSync(join(dist, "index.html"), "utf8");
const refs = new Set();
for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)) refs.add(m[1]);

let js = 0;
let css = 0;
console.log("Initial load assets (gzip):");
for (const ref of refs) {
	const file = join(dist, ref);
	if (!existsSync(file)) continue;
	const buf = readFileSync(file);
	const gz = gzipSync(buf, { level: 9 }).length;
	console.log(`  ${ref.padEnd(44)} ${(gz / 1024).toFixed(1).padStart(7)} KB`);
	if (ref.endsWith(".js")) js += gz;
	else css += gz;
}
console.log(`Initial JS: ${(js / 1024).toFixed(1)} KB gzip (budget ${BUDGET_KB} KB) · CSS: ${(css / 1024).toFixed(1)} KB gzip`);
if (js / 1024 > BUDGET_KB) {
	console.error("Initial JS budget exceeded");
	process.exit(1);
}
