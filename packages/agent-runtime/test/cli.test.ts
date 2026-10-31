import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOmpCli, extractErrorText, locateOmpBinary } from "../src/omp/index.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "clam-cli-"));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

function makeCli(extraEnv: NodeJS.ProcessEnv = {}, profile: string | null = null) {
	return createOmpCli({ binary: () => FAKE, profile, env: { FAKE_OMP_HOME: home, ...extraEnv } });
}

async function calls(): Promise<string[][]> {
	try {
		const text = await readFile(join(home, "calls.jsonl"), "utf8");
		return text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);
	} catch {
		return [];
	}
}

describe("locateOmpBinary", () => {
	it("accepts an executable override and rejects a missing or non-executable one", async () => {
		expect(await locateOmpBinary({ override: FAKE })).toBe(FAKE);
		expect(await locateOmpBinary({ override: join(home, "nope") })).toBeNull();
		const plain = join(home, "plain");
		await writeFile(plain, "x");
		await chmod(plain, 0o644);
		expect(await locateOmpBinary({ override: plain })).toBeNull();
	});

	it("scans PATH and well-known dirs, and returns null when absent", async () => {
		const bin = join(home, "bin");
		await mkdir(bin);
		await symlink(FAKE, join(bin, "omp"));
		expect(await locateOmpBinary({ env: { PATH: bin, HOME: join(home, "h") } })).toBe(join(bin, "omp"));

		const fakeHome = join(home, "h");
		await mkdir(join(fakeHome, ".bun", "bin"), { recursive: true });
		await symlink(FAKE, join(fakeHome, ".bun", "bin", "omp"));
		expect(await locateOmpBinary({ env: { PATH: "", HOME: fakeHome } })).toBe(join(fakeHome, ".bun", "bin", "omp"));

		const result = await locateOmpBinary({ env: { PATH: join(home, "empty"), HOME: join(home, "nohome") } });
		// A real omp may live in /usr/local/bin or /opt/homebrew/bin on the dev machine; only assert the type.
		expect(result === null || typeof result === "string").toBe(true);
	});
});

describe("detect", () => {
	it("reports the install", async () => {
		const install = await makeCli().detect();
		expect(install).toEqual({ installed: true, version: "omp/18.14.0", binaryPath: FAKE, configPath: home });
	});

	it("reports a missing binary without throwing", async () => {
		const cli = createOmpCli({ binary: () => null });
		const install = await cli.detect();
		expect(install).toMatchObject({ installed: false, version: null, binaryPath: null, configPath: null });
		expect(install.error).toMatch(/omp not found/);
	});

	it("reports an unusable binary", async () => {
		const bogus = join(home, "bogus");
		await writeFile(bogus, "#!/bin/sh\nexit 3\n");
		await chmod(bogus, 0o755);
		const install = await createOmpCli({ binary: () => bogus }).detect();
		expect(install.installed).toBe(false);
		expect(install.binaryPath).toBe(bogus);
		expect(install.error).toMatch(/not usable/);
	});

	it("prepends --profile to every invocation", async () => {
		const cli = makeCli({}, "clam-dev");
		await cli.detect();
		await cli.modelRoles();
		for (const argv of await calls()) expect(argv.slice(0, 2)).toEqual(["--profile", "clam-dev"]);
		expect((await calls()).length).toBe(3);
	});
});

describe("models", () => {
	it("maps rows, nulls unknown pricing, drops malformed and non-chat rows", async () => {
		const models = await makeCli().models();
		expect(models.map((m) => m.selector)).toEqual(["fake/alpha", "fake/unpriced"]);
		expect(models[0]).toMatchObject({
			provider: "fake",
			id: "alpha",
			name: "Alpha",
			contextWindow: 200000,
			reasoning: true,
			thinking: ["low", "high"],
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		});
		expect(models[1]).toMatchObject({ cost: null, maxTokens: null });
	});

	it("caches, dedupes concurrent calls and honours refresh/invalidate", async () => {
		const cli = makeCli();
		const [a, b] = await Promise.all([cli.models(), cli.models()]);
		expect(a).toBe(b);
		await cli.models();
		const count = async () => (await calls()).filter((c) => c[0] === "models").length;
		expect(await count()).toBe(1);
		await cli.models({ refresh: true });
		expect(await count()).toBe(2);
		cli.invalidate();
		await cli.models();
		expect(await count()).toBe(3);
	});
});

describe("model roles", () => {
	it("reads, sets, clears and resets", async () => {
		const cli = makeCli();
		expect(await cli.modelRoles()).toEqual({});
		expect(await cli.setModelRole("default", "fake/alpha")).toEqual({ default: "fake/alpha" });
		expect(await cli.setModelRole("smol", "fake/unpriced:low")).toEqual({ default: "fake/alpha", smol: "fake/unpriced:low" });
		expect(await cli.setModelRole("default", null)).toEqual({ smol: "fake/unpriced:low" });
		const list = await calls();
		const sets = list.filter((c) => c[1] === "set");
		expect(sets[0]).toEqual(["config", "set", "modelRoles", JSON.stringify({ default: "fake/alpha" })]);
		expect(await cli.setModelRole("smol", null)).toEqual({});
		expect((await calls()).some((c) => c[1] === "reset" && c[2] === "modelRoles")).toBe(true);
	});

	it("keeps unrelated roles and ignores non-string values on read", async () => {
		await writeFile(join(home, "config.json"), JSON.stringify({ modelRoles: { task: "a/b", weird: { x: 1 } } }));
		const cli = makeCli();
		expect(await cli.modelRoles()).toEqual({ task: "a/b" });
		await cli.setModelRole("plan", "c/d");
		const stored = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
		expect(stored.modelRoles).toEqual({ task: "a/b", weird: { x: 1 }, plan: "c/d" });
	});

	it("rejects injection attempts without spawning anything", async () => {
		const cli = makeCli();
		for (const role of ["", "a b", "x;rm", "../x", "-r", "a$(id)", "1abc"]) {
			await expect(cli.setModelRole(role, "a/b")).rejects.toMatchObject({ code: "invalid_argument" });
		}
		for (const selector of ["a/b; rm -rf /", "a/b c", "$(id)/x", "-x/y", "nosep", "a/b`id`", "a/b|c", "a/b\nc", "a/"]) {
			await expect(cli.setModelRole("default", selector)).rejects.toMatchObject({ code: "invalid_argument" });
		}
		expect(await calls()).toEqual([]);
	});

	it("refuses to rewrite a record containing an invalid existing entry", async () => {
		await writeFile(join(home, "config.json"), JSON.stringify({ modelRoles: { bad: "x y" } }));
		await expect(makeCli().setModelRole("default", "a/b")).rejects.toMatchObject({ code: "rejected" });
	});
});

describe("testModel", () => {
	it("returns ok with the answer and uses the minimal print invocation", async () => {
		const result = await makeCli().testModel("fake/alpha");
		expect(result).toMatchObject({ ok: true, selector: "fake/alpha", output: "OK" });
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		const argv = (await calls())[0] as string[];
		expect(argv).toEqual(expect.arrayContaining(["-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-title", "--thinking", "off"]));
		expect(argv.at(-1)).toBe("Reply with exactly: OK");
	});

	it("does not force --thinking when the selector pins a level", async () => {
		await makeCli().testModel("fake/alpha:high");
		expect(((await calls())[0] as string[]).includes("--thinking")).toBe(false);
	});

	it("surfaces the provider/auth error without stack frames or ANSI", async () => {
		const result = await makeCli().testModel("fake/bad-model");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/^No API key found for fake\./);
		expect(result.error).not.toMatch(/\bat #Bn|\u001b/);
	});

	it("kills the process on timeout", async () => {
		const started = Date.now();
		const result = await makeCli({ FAKE_OMP_SLOW_MS: "30000" }).testModel("fake/alpha", { timeoutMs: 300 });
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/did not answer/);
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it("rejects invalid selectors and a missing binary as ok:false", async () => {
		expect((await makeCli().testModel("a/b; id")).ok).toBe(false);
		expect((await createOmpCli({ binary: () => null }).testModel("a/b")).error).toMatch(/not found/);
		expect((await calls()).length).toBe(0);
	});
});

describe("extractErrorText", () => {
	it("keeps the message and drops stack frames and color codes", () => {
		const text = "1 | x\n^\n\u001b[31merror: boom\u001b[0m\n\nmore\n      at foo (file:1:1)\n";
		expect(extractErrorText(text)).toBe("boom\n\nmore");
	});
});
