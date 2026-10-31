/**
 * Paths never bundled: VCS data, dependencies, build output, caches, secrets and CLAM/OMP runtime folders.
 * Gitignore-style syntax. A project's own .gitignore cannot re-include anything listed here.
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
	".git/",
	"node_modules/",
	".venv/",
	"venv/",
	"__pycache__/",
	"dist/",
	"build/",
	".next/",
	".turbo/",
	".cache/",
	"coverage/",
	".DS_Store",
	"*.log",
	".env",
	".env.*",
	"!.env.example",
	// CLAM runtime folders (.clam/, .clam-apply-*, .clam-data/ ...) and OMP session folders.
	".clam*/",
	".omp/",
];
