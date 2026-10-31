import { defineConfig } from "vitest/config";

// These suites spawn real git and fake omp processes; under a loaded machine a spawn alone can exceed vitest's 5 s default.
export default defineConfig({
	test: { testTimeout: 30_000, hookTimeout: 30_000, include: ["test/**/*.test.ts"] },
});
