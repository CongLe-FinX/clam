import { describe, expect, it } from "vitest";
import {
	buildResumePrompt,
	COMPLETED_GRACE_MS,
	computeDeadlines,
	extendDeadline,
	hasPassed,
	OFFER_EXPIRY_MS,
	RESTORE_DEADLINE_MS,
	restoreDeadlineFrom,
	sealManifest,
	STEP_TIMEOUT_MS,
} from "../src/index.ts";
import { manifestInput } from "./helpers.ts";

describe("timeouts (§7)", () => {
	it("defaults", () => {
		expect(OFFER_EXPIRY_MS).toBe(30 * 60_000);
		expect(RESTORE_DEADLINE_MS).toBe(30 * 60_000);
		expect(STEP_TIMEOUT_MS).toBe(10 * 60_000);
		expect(COMPLETED_GRACE_MS).toBe(24 * 3_600_000);
	});

	it("computeDeadlines", () => {
		const d = computeDeadlines("2026-01-01T10:00:00.000Z");
		expect(d).toMatchObject({
			createdAt: "2026-01-01T10:00:00.000Z",
			expiresAt: "2026-01-01T10:30:00.000Z",
			deadlineAt: "2026-01-01T11:00:00.000Z",
			stepTimeoutMs: 600_000,
		});
		const custom = computeDeadlines(0, { offerExpiryMs: 1000, restoreDeadlineMs: 2000, stepTimeoutMs: 5 });
		expect(custom).toMatchObject({ expiresAt: "1970-01-01T00:00:01.000Z", deadlineAt: "1970-01-01T00:00:03.000Z", stepTimeoutMs: 5 });
	});

	it("restore deadline from acceptance, extension and hasPassed", () => {
		expect(restoreDeadlineFrom("2026-01-01T10:05:00.000Z")).toBe("2026-01-01T10:35:00.000Z");
		expect(extendDeadline("2026-01-01T10:35:00.000Z", 15, "2026-01-01T10:00:00.000Z")).toBe("2026-01-01T10:50:00.000Z");
		expect(extendDeadline("2026-01-01T10:35:00.000Z", 15, "2026-01-01T12:00:00.000Z")).toBe("2026-01-01T12:15:00.000Z");
		expect(hasPassed(10, 10)).toBe(true);
		expect(hasPassed(9, 10)).toBe(false);
		expect(hasPassed(9, null)).toBe(false);
		expect(hasPassed(9, "garbage")).toBe(false);
	});
});

describe("buildResumePrompt", () => {
	const sealed = sealManifest(manifestInput());
	if (!sealed.ok) throw new Error("fixture");
	const prompt = buildResumePrompt(sealed.manifest, {
		localPaths: { workDir: "/work/report", transcriptPath: "/work/old.tar" },
		setupReport: {
			ran: [{ command: "pnpm install --frozen-lockfile", exitCode: 0 }, { command: "make gen", exitCode: 2 }],
			skipped: [{ command: "pnpm check", reason: "denied by the user" }],
			runtimeIssues: ["node 20.1.0 does not satisfy >=22"],
			validation: "3 required files present",
		},
	});

	it("says this is a NEW session continuing work handed over from the source node", () => {
		expect(prompt).toContain("NEW session");
		expect(prompt).toContain('node "beta"');
		expect(prompt).toContain('node "alpha"');
		expect(prompt).toContain("epoch 0 → 1");
	});

	it("includes task, plan, remaining TODOs and the summary", () => {
		expect(prompt).toContain("Write the quarterly report");
		expect(prompt).toContain("report.md exists");
		expect(prompt).toContain("1. outline");
		expect(prompt).toContain("- [ ] proofread");
		expect(prompt).toContain("- [x] outline");
		expect(prompt).toContain("- [~] draft");
		expect(prompt).toContain("We outlined the report and started drafting.");
	});

	it("says where the files are and what setup ran or was skipped", () => {
		expect(prompt).toContain("/work/report");
		expect(prompt).toContain("not a git repository");
		expect(prompt).toContain("/work/old.tar");
		expect(prompt).toContain("Ran `pnpm install --frozen-lockfile`: succeeded");
		expect(prompt).toContain("Ran `make gen`: exited with 2");
		expect(prompt).toContain("Skipped `pnpm check`: denied by the user");
		expect(prompt).toContain("node 20.1.0 does not satisfy >=22");
		expect(prompt).toContain("API_BASE_URL");
	});

	it("handles git and empty variants", () => {
		const git = sealManifest(
			manifestInput({
				vcs: "git",
				files: null,
				git: { repoUrl: "https://github.com/a/b.git", branch: "clam/alpha/t", commit: "0123456789abcdef0123456789abcdef01234567", baseBranch: "main", pushed: true },
				task: { ...manifestInput().task, remaining: [], todos: [] },
			}),
		);
		if (!git.ok) throw new Error("fixture");
		const p = buildResumePrompt(git.manifest, { localPaths: { workDir: "/w" }, setupReport: { ran: [], skipped: [] } });
		expect(p).toContain("branch clam/alpha/t at commit 0123456789abcdef0123456789abcdef01234567");
		expect(p).toContain("No setup commands were needed");
		expect(p).toContain("none recorded");
	});
});
