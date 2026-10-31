import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GitAuth, type GitEngine, scrub } from "../src/index.ts";
import { type GitHttpServer, startGitHttpServer } from "./http-server.ts";
import { captureWrapper, commitAll, configUser, newEngine, read, sh, tmpRoot, write } from "./helpers.ts";

const execFileAsync = promisify(execFile);
const TOKEN = "ghp_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb3d";
const READONLY = "ghp_ReadOnlyZz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0";
const WRONG = "ghp_WrongWrongWrongWrongWrongWrongWrong123";

function walkFiles(dir: string, visit: (path: string) => void): void {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) walkFiles(p, visit);
		else if (st.isFile()) visit(p);
	}
}

describe("authenticated HTTP transport via askpass", () => {
	const auth = (token: string, username?: string): GitAuth => ({ token: async () => token, username });
	let root: string;
	let engine: GitEngine;
	let server: GitHttpServer;
	let capture: ReturnType<typeof captureWrapper>;
	let repoUrl: string;
	let seed: string;
	let runtimeDir: string;

	beforeAll(async () => {
		root = tmpRoot();
		const srv = join(root, "srv");
		mkdirSync(srv);
		sh(root, "init", "-q", "--bare", "-b", "main", join(srv, "proj.git"));
		seed = join(root, "seed");
		sh(root, "clone", "-q", join(srv, "proj.git"), seed);
		configUser(seed, "Seeder", "seed@example.com");
		write(seed, "hello.txt", "hello\n");
		commitAll(seed, "seed");
		sh(seed, "push", "-q", "-u", "origin", "main");
		server = await startGitHttpServer({ root: srv, tokens: { [TOKEN]: { write: true }, [READONLY]: { write: false } } });
		repoUrl = `${server.url}/proj.git`;
		capture = captureWrapper(root);
		runtimeDir = join(root, "run");
		engine = await newEngine(root, capture.bin);
	});
	afterAll(() => server.close());

	it("clone, fetch, pull and push succeed with a token handed to askpass only", async () => {
		const dest = join(root, "clone1");
		const phases: string[] = [];
		await engine.clone(repoUrl, dest, { auth: auth(TOKEN), onProgress: (p) => phases.push(p.phase) });
		expect(read(dest, "hello.txt")).toBe("hello\n");
		expect(phases.length).toBeGreaterThan(0);
		configUser(dest, "Clone One", "one@example.com");

		write(seed, "hello.txt", "hello v2\n");
		commitAll(seed, "v2");
		sh(seed, "push", "-q");
		await engine.fetch(dest, { auth: auth(TOKEN) });
		expect(await engine.status(dest)).toMatchObject({ behind: 1, ahead: 0 });
		expect(await engine.pull(dest, { auth: auth(TOKEN) })).toMatchObject({ result: "fast-forward" });
		expect(sh(dest, "rev-parse", "HEAD")).toBe(sh(seed, "rev-parse", "HEAD"));

		write(dest, "pushed.txt", "from clone\n");
		commitAll(dest, "pushed from clone");
		expect(await engine.push(dest, { auth: auth(TOKEN), setUpstream: true })).toMatchObject({ result: "pushed" });
		expect(sh(join(root, "srv", "proj.git"), "rev-parse", "main")).toBe(sh(dest, "rev-parse", "HEAD"));

		// The server saw the default username and an authorised request.
		expect(server.requests.some((r) => r.user === "x-access-token" && r.status === 200)).toBe(true);
		// Real pull (fast-forward) over HTTP too: machine "B" is dest, A pushes again.
		write(seed, "again.txt", "again\n");
		commitAll(seed, "again");
		sh(seed, "pull", "-q", "--no-rebase");
		sh(seed, "push", "-q");
		expect(await engine.pull(dest, { auth: auth(TOKEN) })).toMatchObject({ result: "fast-forward" });
		expect(read(dest, "again.txt")).toBe("again\n");
	});

	it("honours a custom username", async () => {
		const dest = join(root, "clone-user");
		await engine.clone(repoUrl, dest, { auth: auth(TOKEN, "octocat") });
		expect(server.requests.some((r) => r.user === "octocat" && r.status === 200)).toBe(true);
	});

	it("wrong or missing token → auth_failed (clone, fetch) / reason auth (push); clone destination cleaned", async () => {
		const dest = join(root, "clone-bad");
		await expect(engine.clone(repoUrl, dest, { auth: auth(WRONG) })).rejects.toMatchObject({ code: "auth_failed" });
		expect(existsSync(dest)).toBe(false);
		await expect(engine.clone(repoUrl, dest, {})).rejects.toMatchObject({ code: "auth_failed" });

		const good = join(root, "clone-good");
		await engine.clone(repoUrl, good, { auth: auth(TOKEN) });
		configUser(good);
		await expect(engine.fetch(good, { auth: auth(WRONG) })).rejects.toMatchObject({ code: "auth_failed" });
		write(good, "z.txt", "z\n");
		commitAll(good, "z");
		const r = await engine.push(good, { auth: auth(WRONG), setUpstream: true });
		expect(r).toMatchObject({ result: "rejected", reason: "auth" });
		expect(r.message).not.toContain(WRONG);
	});

	it("read-only token: clone works, push is rejected with reason permission and the server's text", async () => {
		const dest = join(root, "clone-ro");
		await engine.clone(repoUrl, dest, { auth: auth(READONLY) });
		configUser(dest);
		write(dest, "ro.txt", "ro\n");
		commitAll(dest, "ro");
		const r = await engine.push(dest, { auth: auth(READONLY), setUpstream: true });
		expect(r).toMatchObject({ result: "rejected", reason: "permission" });
		expect(r.message).toContain("403");
	});

	it("the token never appears in remote URLs, .git/config, argv, env or any file on disk", async () => {
		const clones = readdirSync(root).filter((n) => n.startsWith("clone"));
		expect(clones.length).toBeGreaterThan(0);
		for (const name of clones) {
			const dir = join(root, name);
			if (!existsSync(join(dir, ".git"))) continue;
			expect(sh(dir, "remote", "get-url", "origin").trim()).toBe(repoUrl);
			expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toMatch(/ghp_|token|password|@127\.0\.0\.1/i);
			expect(sh(dir, "config", "--list", "--show-origin")).not.toContain("credential.helper=store");
		}
		const log = capture.raw();
		expect(log).toContain("ARGV");
		for (const secret of [TOKEN, READONLY, WRONG]) expect(log).not.toContain(secret);
		// Network commands disable credential helpers and prompts, and carry only a nonce.
		const net = capture.invocations().filter((i) => i.argv.some((a) => ["clone", "fetch", "push"].includes(a)) && i.argv.includes("credential.helper="));
		expect(net.length).toBeGreaterThanOrEqual(6);
		expect(log).toMatch(/ENV GIT_TERMINAL_PROMPT=0/);
		expect(log).toMatch(/ENV GIT_ASKPASS=.*\/run\/askpass/);
		expect(log).toMatch(/ENV LC_ALL=C/);
		expect(log).toMatch(/ENV CLAM_ASKPASS_NONCE=[A-Za-z0-9_-]{20,}/);
		// Every file under the whole test root (repos, runtime dir, wrapper log) is token-free.
		let scanned = 0;
		walkFiles(root, (p) => {
			const buf = readFileSync(p);
			scanned++;
			for (const secret of [TOKEN, READONLY, WRONG]) expect(buf.includes(secret), p).toBe(false);
		});
		expect(scanned).toBeGreaterThan(50);
		// The runtime dir is private.
		expect(statSync(runtimeDir).mode & 0o777).toBe(0o700);
	});

	it("nonces are single-use per prompt and die with the command", async () => {
		const probeRoot = tmpRoot();
		const log = join(probeRoot, "probe.log");
		const bin = join(probeRoot, "git-probe.sh");
		// Network commands (the only ones that carry a nonce) are replaced by probes of the askpass helper; everything else is real git.
		writeFileSync(
			bin,
			`#!/bin/sh
if [ -n "$CLAM_ASKPASS_NONCE" ]; then
  "$GIT_ASKPASS" "Password for 'http://x': " >/dev/null 2>&1; echo "password1=$?" >> '${log}'
  "$GIT_ASKPASS" "Password for 'http://x': " >/dev/null 2>&1; echo "password2=$?" >> '${log}'
  "$GIT_ASKPASS" "Username for 'http://x': " >/dev/null 2>&1; echo "username1=$?" >> '${log}'
  "$GIT_ASKPASS" "Username for 'http://x': " >/dev/null 2>&1; echo "username2=$?" >> '${log}'
  "$GIT_ASKPASS" "Passphrase for key: " >/dev/null 2>&1; echo "other=$?" >> '${log}'
  echo "nonce=$CLAM_ASKPASS_NONCE sock=$CLAM_ASKPASS_SOCKET" >> '${log}'
  exit 0
fi
exec git "$@"
`,
		);
		chmodSync(bin, 0o755);
		const probeEngine = await newEngine(probeRoot, bin);
		const repo = join(probeRoot, "repo");
		mkdirSync(repo);
		sh(repo, "init", "-q", "-b", "main");
		sh(repo, "remote", "add", "origin", repoUrl);
		let tokenCalls = 0;
		await probeEngine.fetch(repo, { auth: { token: async () => (tokenCalls++, TOKEN) } });
		const lines = readFileSync(log, "utf8").trim().split("\n");
		expect(lines.slice(0, 5)).toEqual(["password1=0", "password2=1", "username1=0", "username2=1", "other=1"]);
		expect(tokenCalls).toBe(1);
		// After the command finished the nonce is gone: the helper is refused even for a fresh prompt kind.
		const m = /nonce=(\S+) sock=(\S+)/.exec(lines[5] ?? "");
		expect(m).not.toBeNull();
		const helper = join(probeRoot, "run", "askpass.mjs");
		// Async on purpose: the broker lives in this process, a synchronous spawn would block it.
		const run = (env: Record<string, string>) => execFileAsync(process.execPath, [helper, "Password for 'x': "], { env: { PATH: process.env.PATH ?? "", ...env } });
		await expect(run({ CLAM_ASKPASS_NONCE: m?.[1] ?? "", CLAM_ASKPASS_SOCKET: m?.[2] ?? "" })).rejects.toMatchObject({ code: 1 });
		await expect(run({ CLAM_ASKPASS_NONCE: "forged", CLAM_ASKPASS_SOCKET: m?.[2] ?? "" })).rejects.toMatchObject({ code: 1 });
		await expect(run({})).rejects.toMatchObject({ code: 1 });
	});

	it("dispose removes the socket; later network commands fail instead of hanging", async () => {
		const dRoot = tmpRoot();
		const e = await newEngine(dRoot);
		const before = readdirSync(join(dRoot, "run")).filter((n) => n.endsWith(".sock"));
		expect(before).toHaveLength(1);
		await e.dispose();
		expect(readdirSync(join(dRoot, "run")).filter((n) => n.endsWith(".sock"))).toHaveLength(0);
	});
});

describe("scrub", () => {
	it("removes URL userinfo and token shapes", () => {
		expect(scrub("fatal: unable to access 'https://user:pw@github.com/a/b.git/': 403")).toBe("fatal: unable to access 'https://github.com/a/b.git/': 403");
		expect(scrub("https://ghp_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb3d@github.com/x")).toBe("https://github.com/x");
		expect(scrub(`token ${TOKEN} leaked`)).toBe("token *** leaked");
		expect(scrub("github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789 end")).toBe("*** end");
		expect(scrub("Authorization: Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0")).toBe("Authorization: Basic ***");
		expect(scrub("custom-secret-value here", ["custom-secret-value"])).toBe("*** here");
		expect(scrub("plain text, ssh://git@github.com/x.git")).toBe("plain text, ssh://github.com/x.git");
	});
});
