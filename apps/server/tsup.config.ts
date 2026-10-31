import { cpSync, rmSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
	entry: { main: "src/main.ts" },
	format: ["esm"],
	platform: "node",
	target: "node22",
	outDir: "dist",
	clean: true,
	sourcemap: true,
	splitting: false,
	// Workspace packages ship as TypeScript source: bundle them. Registry dependencies (fastify, drizzle-orm,
	// better-sqlite3 with its native addon, pino, ...) stay external and resolve from node_modules at runtime.
	noExternal: [/^@clam\//],
	async onSuccess() {
		// `openDatabase` looks for its committed SQL migrations next to the entry point.
		rmSync("dist/migrations", { recursive: true, force: true });
		cpSync("../../packages/database/migrations", "dist/migrations", { recursive: true });
	},
});
