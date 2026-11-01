import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig, type PluginOption } from "vite";

const apiTarget = process.env.CLAM_API_URL ?? "http://127.0.0.1:4317";
const webPort = Number(process.env.WEB_PORT ?? 5317);

const proxy = {
	"/api": { target: apiTarget, changeOrigin: false },
	"/ws": { target: apiTarget.replace(/^http/, "ws"), ws: true, changeOrigin: false },
};

/** KaTeX's stylesheet lists woff2, woff and ttf for every face; browsers that run this app all take woff2, so ship only that. */
const katexWoff2Only = (): PluginOption => ({
	name: "clam:katex-woff2-only",
	enforce: "pre",
	transform(code, id) {
		if (!/katex[\\/]dist[\\/]katex\.min\.css/.test(id)) return null;
		return code.replace(/,url\([^)]*?\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "");
	},
});

/**
 * i18n catalog loading without top-level await (TLA in lazy chunks makes Rollup fragment the entry chunk). Every dynamic
 * `import("<src module>")` is wrapped in `withNamespaces(import(...), [namespaces])`, where the namespaces are the feature
 * folders of every module statically reachable from the target that imports `@/i18n`. The lazy chunk and the Vietnamese
 * catalogs download in parallel and the chunk's promise resolves only when both are in, so there is never a flash of English.
 * `src/main.tsx` gets the same treatment for the initial graph (token `__INITIAL_NAMESPACES__`). English: resolved no-op.
 */
const SRC = resolve(import.meta.dirname, "src");
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^"'`;]*?\sfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
const FEATURE = /\/src\/features\/([^/]+)\//;
const resolveSpec = (from: string, spec: string): string | null => {
	const base = spec.startsWith("@/") ? resolve(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
	if (!base) return null;
	for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (existsSync(c) && statSync(c).isFile()) return c;
	return null;
};
function namespacesReachable(entry: string, seen = new Set<string>(), out = new Set<string>()): Set<string> {
	if (seen.has(entry) || !/\.tsx?$/.test(entry)) return out;
	seen.add(entry);
	const code = readFileSync(entry, "utf8");
	const ns = FEATURE.exec(entry)?.[1];
	if (ns && /from\s+["']@\/i18n["']/.test(code)) out.add(ns);
	for (const m of code.matchAll(STATIC_IMPORT)) {
		const dep = resolveSpec(entry, (m[1] ?? m[2])!);
		if (dep) namespacesReachable(dep, seen, out);
	}
	return out;
}
const i18nNamespaces = (): PluginOption => ({
	name: "clam:i18n-namespace",
	enforce: "pre",
	transform(code, id) {
		const file = id.split("?")[0]!.replaceAll("\\", "/");
		if (!file.startsWith(`${SRC}/`) || !/\.tsx?$/.test(file) || file.startsWith(`${SRC}/i18n/`)) return null;
		let changed = false;
		let out = code.replace(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g, (all, _q: string, spec: string) => {
			const target = resolveSpec(file, spec);
			if (!target) return all;
			const ns = [...namespacesReachable(target)];
			if (!ns.length) return all;
			changed = true;
			return `__withNs(${all}, ${JSON.stringify(ns)})`;
		});
		if (file === `${SRC}/main.tsx`) out = out.replace('"__INITIAL_NAMESPACES__"', JSON.stringify(JSON.stringify([...namespacesReachable(file)])));
		if (!changed && out === code) return null;
		return { code: changed ? `import { withNamespaces as __withNs } from "@/i18n/core"; ${out}` : out, map: null };
	},
});

export default defineConfig(({ mode }) => ({
	plugins: [
		react(),
		tailwindcss(),
		katexWoff2Only(),
		i18nNamespaces(),
		process.env.ANALYZE
			? (visualizer({
					filename: process.env.ANALYZE === "json" ? "dist/stats.json" : "dist/stats.html",
					gzipSize: true,
					template: process.env.ANALYZE === "json" ? "raw-data" : "treemap",
				}) as PluginOption)
			: null,
	],
	resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
	server: { host: "127.0.0.1", port: webPort, strictPort: true, proxy },
	preview: { host: "127.0.0.1", port: webPort, strictPort: true, proxy },
	build: {
		target: "es2023",
		sourcemap: false,
		cssCodeSplit: true,
		chunkSizeWarningLimit: 600,
		rollupOptions: {
			// @clam/contracts is type-only/route-table in the shell; drop its zod schemas unless a lazy chunk needs them.
			treeshake: { moduleSideEffects: (id: string) => !/packages\/contracts\/src\//.test(id) },
			output: {
				manualChunks(id: string) {
					if (!id.includes("node_modules")) return undefined;
					if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
					// Router + query are the shell; virtual/table-style packages ride with the lazy pages that use them.
					if (/\/node_modules\/@tanstack\/(react-router|router-core|history|react-query|query-core|react-store|store)\//.test(id)) return "tanstack";
					return undefined;
				},
			},
		},
	},
	define: { __DEV__: JSON.stringify(mode !== "production") },
}));
