import { describe, expect, it } from "vitest";
import {
	IDEMPOTENCY_TTL_MS,
	OUTBOX_BACKOFF,
	OUTBOX_MAX_ATTEMPTS,
	compareUrl,
	decideAfterFailure,
	evaluateIdempotency,
	normalizeRepoUrl,
	outboxBackoffMs,
	repoKey,
	requestHash,
	slugify,
	strictestApprovalMode,
	taskBranchName,
	type ApprovalMode,
} from "../src/index.ts";

describe("normalizeRepoUrl", () => {
	const ok = { owner: "Octo", name: "Repo.js", key: "octo/repo.js", url: "https://github.com/Octo/Repo.js" };
	it.each([
		"https://github.com/Octo/Repo.js",
		"https://github.com/Octo/Repo.js.git",
		"https://github.com/Octo/Repo.js/",
		"https://github.com/Octo/Repo.js?tab=readme#top",
		"https://GitHub.com/Octo/Repo.js",
		"git@github.com:Octo/Repo.js.git",
		"git@github.com:Octo/Repo.js",
		"ssh://git@github.com/Octo/Repo.js.git",
		"github.com/Octo/Repo.js",
		"  github.com/Octo/Repo.js.git  ",
		"https://user:secret@github.com/Octo/Repo.js.git",
		"https://x-access-token:ghp_abc@github.com/Octo/Repo.js",
	])("accepts %s", (i) => {
		const r = normalizeRepoUrl(i);
		expect(r).toEqual(ok);
		expect(JSON.stringify(r)).not.toMatch(/secret|ghp_/);
	});
	it.each([
		"http://github.com/o/r",
		"https://gitlab.com/o/r",
		"git@gitlab.com:o/r.git",
		"https://github.com/o",
		"https://github.com/o/r/extra",
		"https://github.com/o/r r",
		"https://github.com/../r",
		"https://github.com/o/..",
		"https://github.com.evil.com/o/r",
		"https://github.com:8443/o/r",
		"ftp://github.com/o/r",
		"",
		"garbage",
		"o/r",
		"https://github.com/o%20x/r",
	])("rejects %j", (i) => expect(normalizeRepoUrl(i)).toBeNull());
	it("repoKey and compareUrl", () => {
		expect(repoKey("O", "R")).toBe("o/r");
		const r = { owner: "o", name: "r" };
		expect(compareUrl(r, "main", "clam/n/x-1")).toBe("https://github.com/o/r/compare/main...clam/n/x-1");
		expect(compareUrl(r, null, "clam/n/x-1")).toBe("https://github.com/o/r/tree/clam/n/x-1");
		expect(compareUrl(r, "rel/1.0", "feat/a b#c")).toBe("https://github.com/o/r/compare/rel/1.0...feat/a%20b%23c");
	});
});

describe("branch", () => {
	it("slugify", () => {
		expect(slugify("Hello, World!")).toBe("hello-world");
		expect(slugify("Crème Brûlée")).toBe("creme-brulee");
		expect(slugify("🔥🔥")).toBe("task");
		expect(slugify("")).toBe("task");
		expect(slugify("---")).toBe("task");
		const long = slugify("a".repeat(30) + " " + "b".repeat(30));
		expect(long.length).toBeLessThanOrEqual(40);
		expect(long.endsWith("-")).toBe(false);
		expect(slugify("abc def ghi", 7)).toBe("abc-def");
	});
	it("taskBranchName", () => {
		const i = { nodeName: "My Laptop", title: "Fix the bug!", taskId: "01HZX-ABCdef12" };
		expect(taskBranchName(i)).toBe("clam/my-laptop/fix-the-bug-def12".replace("def12", "cdef12"));
		expect(taskBranchName(i)).toBe(taskBranchName({ ...i }));
		for (const t of ["🔥", "", "x".repeat(500), "a..b", "foo.lock", "end.", "..", "a/b\\c~^:?*[", "-lead"]) {
			const b = taskBranchName({ nodeName: t, title: t, taskId: "x" });
			expect(b).toMatch(/^clam\/[a-z0-9-]+\/[a-z0-9-]+-[a-z0-9]+$/);
			expect(b).not.toContain("..");
			expect(b.endsWith(".")).toBe(false);
			expect(b.endsWith(".lock")).toBe(false);
		}
		expect(taskBranchName({ nodeName: "n", title: "t", taskId: "!!!" })).toBe("clam/n/t-task");
	});
});

describe("approval", () => {
	const modes: ApprovalMode[] = ["always-ask", "always-ask-cached", "write", "yolo"];
	it("4x4 matrix: stricter wins", () => {
		for (let n = 0; n < 4; n++)
			for (let r = 0; r < 4; r++) expect(strictestApprovalMode(modes[n]!, modes[r]!)).toBe(modes[Math.min(n, r)]);
	});
	it("missing request keeps node mode", () => {
		for (const m of modes) {
			expect(strictestApprovalMode(m)).toBe(m);
			expect(strictestApprovalMode(m, null)).toBe(m);
		}
	});
});

describe("outbox", () => {
	it("constants", () => {
		expect(OUTBOX_MAX_ATTEMPTS).toBe(10);
		expect(OUTBOX_BACKOFF).toEqual({ baseMs: 1000, capMs: 60000 });
	});
	it("backoff bounds with injected random", () => {
		expect(outboxBackoffMs(1, () => 0)).toBe(0);
		expect(outboxBackoffMs(1, () => 0.999999)).toBeLessThanOrEqual(1000);
		expect(outboxBackoffMs(3, () => 0.5)).toBe(2000);
		expect(outboxBackoffMs(7, () => 0.999999)).toBeLessThanOrEqual(60000);
		expect(outboxBackoffMs(7, () => 0.5)).toBe(30000);
		expect(outboxBackoffMs(30, () => 0.999999)).toBeLessThanOrEqual(60000);
		expect(outboxBackoffMs(2, () => 0, 5000)).toBe(5000);
		expect(outboxBackoffMs(2, () => 0.5, 100)).toBe(1000);
	});
	it("decisions", () => {
		expect(decideAfterFailure({ attempts: 1, retryable: false })).toEqual({ state: "dead" });
		expect(decideAfterFailure({ attempts: 1, retryable: true, random: () => 0.5 })).toEqual({ state: "pending", delayMs: 500 });
		expect(decideAfterFailure({ attempts: 9, retryable: true, random: () => 0.5 })).toEqual({ state: "pending", delayMs: 30000 });
		expect(decideAfterFailure({ attempts: 10, retryable: true })).toEqual({ state: "dead" });
		expect(decideAfterFailure({ attempts: 11, retryable: true })).toEqual({ state: "dead" });
		expect(decideAfterFailure({ attempts: 2, retryable: true, retryAfterMs: 9000, random: () => 0 })).toEqual({ state: "pending", delayMs: 9000 });
	});
});

describe("idempotency", () => {
	it("hash stable and sensitive", () => {
		const h = requestHash("POST", "/a/b", '{"x":1}');
		expect(h).toMatch(/^[0-9a-f]{64}$/);
		expect(requestHash("POST", "/a/b", new TextEncoder().encode('{"x":1}'))).toBe(h);
		expect(requestHash("post", "/a/b", '{"x":1}')).toBe(h);
		expect(requestHash("POST", "/a/c", '{"x":1}')).not.toBe(h);
		expect(requestHash("PUT", "/a/b", '{"x":1}')).not.toBe(h);
		expect(requestHash("POST", "/a/b", '{"x":2}')).not.toBe(h);
		expect(requestHash("POST", "/a/b", "")).toMatch(/^[0-9a-f]{64}$/);
	});
	it("evaluate", () => {
		expect(evaluateIdempotency(undefined, "h")).toBe("miss");
		expect(evaluateIdempotency({ requestHash: "h" }, "h")).toBe("replay");
		expect(evaluateIdempotency({ requestHash: "g" }, "h")).toBe("conflict");
		expect(IDEMPOTENCY_TTL_MS).toBe(86_400_000);
	});
});
