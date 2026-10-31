import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRuntimes, detectEnvironment, environmentNotes, parseVersion, type ProbeFn, satisfiesRange, setupFingerprint } from "../src/index.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "clam-env-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});
const put = (name: string, content = "") => {
	mkdirSync(join(dir, name, ".."), { recursive: true });
	writeFileSync(join(dir, name), content);
};

describe("detectEnvironment", () => {
	it("empty folder → empty valid environment", async () => {
		const env = await detectEnvironment(dir);
		expect(env.packageManager).toBeNull();
		expect(env.runtimes).toEqual([]);
		expect(env.requiredEnvVars).toEqual([]);
		expect(env.setupCommands).toEqual([]);
		expect(env.checkCommand).toBeNull();
	});

	it.each([
		["pnpm-lock.yaml", "pnpm", "pnpm install --frozen-lockfile"],
		["yarn.lock", "yarn", "yarn install --frozen-lockfile"],
		["package-lock.json", "npm", "npm ci"],
		["bun.lock", "bun", "bun install --frozen-lockfile"],
		["bun.lockb", "bun", "bun install --frozen-lockfile"],
	])("node lockfile %s", async (lock, name, command) => {
		put("package.json", "{}");
		put(lock, "x");
		const env = await detectEnvironment(dir);
		expect(env.packageManager).toEqual({ name, lockfile: lock, installCommand: command });
	});

	it("package.json without lockfile uses packageManager field / npm install", async () => {
		put("package.json", JSON.stringify({ packageManager: "pnpm@9.1.0" }));
		const env = await detectEnvironment(dir);
		expect(env.packageManager).toEqual({ name: "pnpm", lockfile: null, installCommand: "pnpm install" });
		expect(env.runtimes).toContainEqual({ name: "pnpm", versionRange: "^9.1.0" });
	});

	it("node runtime from engines, then .nvmrc, then .node-version", async () => {
		put("package.json", JSON.stringify({ engines: { node: ">=22.12" } }));
		put(".nvmrc", "v18\n");
		expect((await detectEnvironment(dir)).runtimes).toContainEqual({ name: "node", versionRange: ">=22.12" });
		rmSync(join(dir, "package.json"));
		put("package.json", "{}");
		expect((await detectEnvironment(dir)).runtimes).toContainEqual({ name: "node", versionRange: "18" });
		rmSync(join(dir, ".nvmrc"));
		put(".node-version", "20.11.1\n");
		expect((await detectEnvironment(dir)).runtimes).toContainEqual({ name: "node", versionRange: "20.11.1" });
		put(".node-version", "lts/*\n");
		expect((await detectEnvironment(dir)).runtimes.find((r) => r.name === "node")).toBeUndefined();
	});

	it("python: requirements.txt, uv.lock, poetry.lock + versions", async () => {
		put("requirements.txt", "flask\n");
		put(".python-version", "3.11.4\n");
		let env = await detectEnvironment(dir);
		expect(env.packageManager).toEqual({ name: "pip", lockfile: "requirements.txt", installCommand: "python3 -m pip install -r requirements.txt" });
		expect(env.runtimes).toContainEqual({ name: "python", versionRange: "3.11.4" });
		expect(environmentNotes(env).join(" ")).toMatch(/virtualenv/);

		put("pyproject.toml", '[project]\nrequires-python = ">=3.12"\n');
		put("uv.lock", "x");
		rmSync(join(dir, ".python-version"));
		env = await detectEnvironment(dir);
		expect(env.packageManager).toEqual({ name: "uv", lockfile: "uv.lock", installCommand: "uv sync" });
		expect(env.runtimes).toContainEqual({ name: "python", versionRange: ">=3.12" });

		rmSync(join(dir, "uv.lock"));
		put("poetry.lock", "x");
		env = await detectEnvironment(dir);
		expect(env.packageManager).toEqual({ name: "poetry", lockfile: "poetry.lock", installCommand: "poetry install" });
	});

	it("go.mod, Cargo.toml, Gemfile.lock", async () => {
		put("go.mod", "module x\n\ngo 1.22\n");
		put("go.sum", "x");
		let env = await detectEnvironment(dir);
		expect(env.packageManager).toEqual({ name: "go", lockfile: "go.sum", installCommand: "go mod download" });
		expect(env.runtimes).toContainEqual({ name: "go", versionRange: ">=1.22" });
		rmSync(join(dir, "go.mod"));

		put("Cargo.toml", "[package]\n");
		put("rust-toolchain.toml", '[toolchain]\nchannel = "1.75.0"\n');
		env = await detectEnvironment(dir);
		expect(env.packageManager).toEqual({ name: "cargo", lockfile: null, installCommand: "cargo fetch" });
		expect(env.runtimes).toContainEqual({ name: "rust", versionRange: ">=1.75.0" });
		rmSync(join(dir, "Cargo.toml"));

		put("Gemfile.lock", "x");
		put(".ruby-version", "3.3.0");
		env = await detectEnvironment(dir);
		expect(env.packageManager).toEqual({ name: "bundler", lockfile: "Gemfile.lock", installCommand: "bundle install" });
		expect(env.runtimes).toContainEqual({ name: "ruby", versionRange: "3.3.0" });
	});

	it("multi-ecosystem: first is primary, others become setup commands; user commands appended", async () => {
		put("package.json", "{}");
		put("pnpm-lock.yaml", "x");
		put("requirements.txt", "x");
		const env = await detectEnvironment(dir, { setupCommands: ["make gen"], checkCommand: "pnpm typecheck" });
		expect(env.packageManager?.name).toBe("pnpm");
		expect(env.setupCommands).toEqual(["python3 -m pip install -r requirements.txt", "make gen"]);
		expect(env.checkCommand).toBe("pnpm typecheck");
	});

	it("required env vars: names only, never values", async () => {
		put(".env.example", "# comment\nAPI_KEY=super-secret-value-123\nexport DB_URL=postgres://u:p@h/d\nEMPTY=\nnot a var\n");
		const env = await detectEnvironment(dir);
		expect(env.requiredEnvVars).toEqual(["API_KEY", "DB_URL", "EMPTY"]);
		expect(JSON.stringify(env)).not.toContain("super-secret");
		expect(JSON.stringify(env)).not.toContain("postgres://");
	});

	describe("nested project roots", () => {
		it("a package.json in a subfolder of a root without any manifest is found, with its own folder", async () => {
			put("web/package.json", JSON.stringify({ engines: { node: ">=20" } }));
			const env = await detectEnvironment(dir);
			expect(env.packageManager).toBeNull();
			expect(env.projects).toEqual([{ path: "web", packageManager: { name: "npm", lockfile: null, installCommand: "npm install" } }]);
			expect(env.runtimes).toContainEqual({ name: "node", versionRange: ">=20" });
		});

		it("the root keeps its package manager; a nested project with its own lockfile is a separate install in its own folder", async () => {
			put("package.json", "{}");
			put("pnpm-lock.yaml", "x");
			put("apps/web/package.json", "{}");
			put("apps/web/yarn.lock", "x");
			put("services/api/requirements.txt", "flask\n");
			const env = await detectEnvironment(dir);
			expect(env.packageManager).toEqual({ name: "pnpm", lockfile: "pnpm-lock.yaml", installCommand: "pnpm install --frozen-lockfile" });
			expect(env.setupCommands).toEqual([]);
			expect(env.projects).toEqual([
				{ path: "apps/web", packageManager: { name: "yarn", lockfile: "yarn.lock", installCommand: "yarn install --frozen-lockfile" } },
				{ path: "services/api", packageManager: { name: "pip", lockfile: "requirements.txt", installCommand: "python3 -m pip install -r requirements.txt" } },
			]);
		});

		it("workspace members (a manifest without a lockfile under a root project of the same kind) are not separate installs", async () => {
			put("package.json", "{}");
			put("pnpm-lock.yaml", "x");
			put("packages/a/package.json", "{}");
			put("packages/b/package.json", "{}");
			put("packages/b/nested/package.json", "{}");
			expect((await detectEnvironment(dir)).projects).toBeUndefined();
		});

		it("looks at most 3 folders deep", async () => {
			put("a/b/c/package.json", "{}");
			put("a/b/c/d/package.json", "{}");
			const env = await detectEnvironment(dir);
			expect(env.projects?.map((p) => p.path)).toEqual(["a/b/c"]);
		});

		it("skips node_modules, .git and other dot-folders, vendor and build output", async () => {
			for (const skipped of ["node_modules/pkg", ".git/hooks", ".cache/x", "vendor/lib", "dist/app", "build/app", "target/debug", "__pycache__/m"]) put(`${skipped}/package.json`, "{}");
			put("tools/package.json", "{}");
			expect((await detectEnvironment(dir)).projects?.map((p) => p.path)).toEqual(["tools"]);
		});

		it("is capped: 20 projects, the shallowest first, in a stable order", async () => {
			for (let i = 0; i < 25; i++) put(`p${String(i).padStart(2, "0")}/package.json`, "{}");
			put("a/b/package.json", "{}");
			const env = await detectEnvironment(dir);
			expect(env.projects).toHaveLength(20);
			expect(env.projects?.map((p) => p.path).slice(0, 3)).toEqual(["p00", "p01", "p02"]);
			expect(env.projects?.some((p) => p.path === "a/b")).toBe(false);
		});

		it("a root-only folder has no `projects` key at all (manifests of before stay byte-identical)", async () => {
			put("package.json", "{}");
			expect(Object.keys(await detectEnvironment(dir))).not.toContain("projects");
		});

		it("the setup fingerprint follows a nested lockfile", async () => {
			put("web/package.json", "{}");
			put("web/package-lock.json", "one");
			const env = await detectEnvironment(dir);
			const before = await setupFingerprint(dir, env);
			expect(await setupFingerprint(dir, env)).toBe(before);
			put("web/package-lock.json", "two");
			expect(await setupFingerprint(dir, env)).not.toBe(before);
		});
	});
});

describe("semver-ish ranges", () => {
	const ok = (v: string, r: string) => satisfiesRange(parseVersion(v) ?? [0, 0, 0], r);
	it("handles common forms", () => {
		expect(ok("22.12.0", ">=22.12")).toBe(true);
		expect(ok("22.11.9", ">=22.12")).toBe(false);
		expect(ok("20.5.1", "^20")).toBe(true);
		expect(ok("21.0.0", "^20")).toBe(false);
		expect(ok("0.2.9", "^0.2.3")).toBe(true);
		expect(ok("0.3.0", "^0.2.3")).toBe(false);
		expect(ok("3.11.9", "~3.11")).toBe(true);
		expect(ok("3.12.0", "~3.11")).toBe(false);
		expect(ok("22.4.1", "22")).toBe(true);
		expect(ok("23.0.0", "22")).toBe(false);
		expect(ok("1.2.9", "1.x")).toBe(true);
		expect(ok("19.0.0", ">=18 <21")).toBe(true);
		expect(ok("21.0.0", ">=18 <21")).toBe(false);
		expect(ok("20.0.0", "18 || 20")).toBe(true);
		expect(ok("19.0.0", "18 || 20")).toBe(false);
		expect(ok("1.5.0", "1.2 - 1.8")).toBe(true);
		expect(ok("1.9.0", "1.2 - 1.8")).toBe(false);
		expect(ok("5.0.0", "*")).toBe(true);
		expect(ok("1.0.0", ">= 1.0.0")).toBe(true);
		expect(ok("1.0.1", "not-a-range")).toBe(true);
	});
	it("parses tool output", () => {
		expect(parseVersion("v22.12.0")).toEqual([22, 12, 0]);
		expect(parseVersion("Python 3.11.4")).toEqual([3, 11, 4]);
		expect(parseVersion("go version go1.22.3 darwin/arm64")).toEqual([1, 22, 3]);
		expect(parseVersion("none")).toBeNull();
	});
});

describe("checkRuntimes", () => {
	const env = (runtimes: { name: string; versionRange: string }[], pm: string | null = null) => ({
		os: null,
		arch: null,
		runtimes,
		packageManager: pm ? { name: pm, lockfile: null, installCommand: `${pm} install` } : null,
		requiredEnvVars: [],
		setupCommands: [],
		checkCommand: null,
	});
	const fake =
		(tools: Record<string, string>): ProbeFn =>
		async (cmd) =>
			tools[cmd] ?? null;

	it("reports ok / mismatch / missing", async () => {
		const report = await checkRuntimes(
			env([{ name: "node", versionRange: ">=22.12" }, { name: "python", versionRange: ">=3.12" }, { name: "go", versionRange: ">=1.22" }], "pnpm"),
			fake({ node: "v20.1.0\n", python3: "Python 3.12.1", pnpm: "9.1.0" }),
		);
		const by = Object.fromEntries(report.checks.map((c) => [c.name, c]));
		expect(by.node).toMatchObject({ status: "mismatch", found: "20.1.0" });
		expect(by.python).toMatchObject({ status: "ok", found: "3.12.1" });
		expect(by.go).toMatchObject({ status: "missing", found: null });
		expect(by.pnpm).toMatchObject({ status: "ok" });
		expect(report.ok).toBe(false);
	});

	it("passes when everything satisfies, and marks unreadable versions unknown", async () => {
		const good = await checkRuntimes(env([{ name: "node", versionRange: "^20" }]), fake({ node: "v20.9.0" }));
		expect(good.ok).toBe(true);
		const unknown = await checkRuntimes(env([{ name: "node", versionRange: "^20" }]), fake({ node: "weird" }));
		expect(unknown.checks[0]?.status).toBe("unknown");
		expect(unknown.ok).toBe(true);
	});

	it("flags a missing package-manager binary even without runtimes", async () => {
		const report = await checkRuntimes(env([], "uv"), fake({}));
		expect(report.checks).toEqual([expect.objectContaining({ name: "uv", status: "missing" })]);
		expect(report.ok).toBe(false);
	});

	it("probes the real local node (default probe)", async () => {
		const report = await checkRuntimes(env([{ name: "node", versionRange: ">=1" }]));
		expect(report.checks[0]?.status).toBe("ok");
		const bad = await checkRuntimes(env([{ name: "node", versionRange: ">=9999" }]));
		expect(bad.checks[0]?.status).toBe("mismatch");
	});
});

describe("setupFingerprint", () => {
	it("changes with lockfile content, command and setup commands; stable otherwise", async () => {
		put("package.json", "{}");
		put("pnpm-lock.yaml", "lock-v1");
		const env = await detectEnvironment(dir);
		const f1 = await setupFingerprint(dir, env);
		expect(await setupFingerprint(dir, env)).toBe(f1);
		put("pnpm-lock.yaml", "lock-v2");
		const f2 = await setupFingerprint(dir, env);
		expect(f2).not.toBe(f1);
		expect(await setupFingerprint(dir, { ...env, setupCommands: ["make"] })).not.toBe(f2);
		expect(await setupFingerprint(dir, { ...env, packageManager: env.packageManager && { ...env.packageManager, installCommand: "pnpm i" } })).not.toBe(f2);
	});

	it("falls back to manifests without a lockfile", async () => {
		put("package.json", '{"dependencies":{"a":"1"}}');
		const env = await detectEnvironment(dir);
		const f1 = await setupFingerprint(dir, env);
		put("package.json", '{"dependencies":{"a":"2"}}');
		expect(await setupFingerprint(dir, env)).not.toBe(f1);
	});
});
