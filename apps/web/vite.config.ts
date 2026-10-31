import { resolve } from "node:path";
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

export default defineConfig(({ mode }) => ({
	plugins: [
		react(),
		tailwindcss(),
		katexWoff2Only(),
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
