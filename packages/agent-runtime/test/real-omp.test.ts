import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type OmpSupervisor, createOmpCli, createOmpRuntime, locateOmpBinary, placeSessionFile } from "../src/omp/index.ts";
import type { RuntimeSession, RuntimeSessionSpec } from "../src/types.ts";

/**
 * Real shared-session round trip against the installed `omp` (costs a few cents on haiku).
 * Opt in with `CLAM_REAL_OMP=1`; the binary comes from `CLAM_OMP_BIN` or PATH.
 */
const enabled = process.env.CLAM_REAL_OMP === "1";
const MODEL = "anthropic/claude-haiku-4-5";

describe.skipIf(!enabled)("real omp shared-session round trip", () => {
	// CLAM keeps real paths (git clones, `realpath`'d projects). On macOS that is `/private/var/...` while omp writes and
	// compares session header cwds as `/var/...`; `sessionUnpack` must hand omp its own spelling or the resume is refused.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clam-real-omp-")));
	const supervisors: OmpSupervisor[] = [];
	let unpackBucket: string | null = null;

	afterAll(async () => {
		await Promise.all(supervisors.map((s) => s.shutdown()));
		rmSync(root, { recursive: true, force: true });
		// `omp session unpack` writes into OMP's own session store and every omp process creates an (empty) bucket for its
		// cwd there. `placeSessionFile` moved the journal out; remove the buckets this test caused, but only when nothing
		// but lock leftovers remain in them and only below `.../agent/sessions`.
		if (unpackBucket && dirname(unpackBucket).endsWith(join("agent", "sessions"))) {
			const buckets = [unpackBucket, join(dirname(unpackBucket), basename(unpackBucket).replace(/projB$/, "projA"))];
			for (const bucket of buckets) {
				if (!existsSync(bucket)) continue;
				const entries = readdirSync(bucket);
				if (!entries.every((name) => name.endsWith(".lock.os"))) continue;
				for (const name of entries) rmSync(join(bucket, name), { force: true });
				rmdirSync(bucket);
			}
		}
	});

	async function assistantText(session: RuntimeSession, afterCount: number): Promise<string> {
		const deadline = Date.now() + 90_000;
		for (;;) {
			const page = await session.messages({ limit: 200 });
			const fresh = page.messages.slice(afterCount);
			const reply = fresh.find((m) => m.role === "assistant" && session.status().state === "ready");
			if (reply) {
				return reply.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			}
			if (Date.now() > deadline) throw new Error("no assistant reply within 90 s");
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	async function ask(session: RuntimeSession, message: string): Promise<string> {
		const before = (await session.messages({ limit: 200 })).messages.length;
		await session.prompt({ message, clientId: `c-${before}` });
		return assistantText(session, before);
	}

	it("keeps a conversation across pack -> unpack -> place -> resume", { timeout: 240_000 }, async () => {
		const binary = await locateOmpBinary(process.env.CLAM_OMP_BIN ? { override: process.env.CLAM_OMP_BIN } : {});
		expect(binary, "omp binary not found (set CLAM_OMP_BIN)").toBeTruthy();
		const cli = createOmpCli({ binary: () => binary });
		const supervisor = createOmpRuntime({
			binary: () => binary,
			settings: { maxConcurrentRuntimes: 4, idleTimeoutMs: 600_000, approvalMode: "yolo" },
			startTimeoutMs: 60_000,
			requestTimeoutMs: 60_000,
			reapIntervalMs: 60_000,
		});
		supervisors.push(supervisor);

		const cwdA = join(root, "projA");
		const cwdB = join(root, "projB");
		mkdirSync(cwdA);
		mkdirSync(cwdB);
		const specFor = (id: string, cwd: string): RuntimeSessionSpec => ({
			sessionId: id,
			cwd,
			sessionDir: join(root, "sessions", id),
			model: MODEL,
			maxCostUsd: 0.05,
		});

		// Driver: one tiny prompt.
		const driver = await supervisor.open(specFor("driver", cwdA));
		const noted = await ask(driver, "Remember this code word: PELICAN-42. Reply with just: noted");
		console.log(`driver answer: ${JSON.stringify(noted)}`);
		const journal = driver.binding().runtimeSessionFile as string;
		expect(journal).toMatch(/\.jsonl$/);

		// Snapshot: the runtime is stopped for the duration so omp's lease is free.
		await expect(cli.sessionPack(journal, join(root, "pre.tar"))).rejects.toMatchObject({ code: "session_locked" });
		const { archivePath } = await supervisor.withReleased("driver", () => cli.sessionPack(journal, join(root, "driver.tar")));
		console.log(`packed: ${archivePath}`);

		// Takeover: unpack for another cwd, move into a fresh CLAM session dir.
		const unpacked = await cli.sessionUnpack(archivePath, cwdB);
		unpackBucket = dirname(unpacked.sessionFile);
		console.log(`unpacked (${unpacked.mode}): ${unpacked.sessionFile}`);
		const placed = await placeSessionFile(unpacked.sessionFile, join(root, "sessions", "taker"));
		expect(placed.startsWith(join(root, "sessions", "taker"))).toBe(true);

		// The snapshot cycle restarted the driver in the background. On a single node it would hold the same omp session id
		// as the takeover copy, so stop it first (on a real takeover the copy lives on another node). The model is restored
		// from the journal, as in production takeovers.
		await supervisor.stop("driver");
		// Mark the original copy as moved. Done before the taker runs: on a single node both copies share one omp session
		// id, and omp refuses `moved` while any live process writes that id (a real takeover runs on another node).
		await expect(cli.sessionMoved(journal, "taker-node")).resolves.toBeUndefined();
		const { model: _journalModel, ...takerSpec } = specFor("taker", cwdB);
		const taker = await supervisor.open(takerSpec);
		expect(taker.binding().runtimeSessionFile).toBe(placed);
		const recalled = await ask(taker, "What was my previous message? Quote the code word only.");
		console.log(`taker answer: ${JSON.stringify(recalled)}`);
		expect(recalled).toContain("PELICAN-42");
	});
});
