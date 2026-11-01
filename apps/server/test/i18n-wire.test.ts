import { type I18nText, i18nMsg, plainMsg, renderI18n } from "@clam/contracts";
import { wire } from "@clam/agent-network";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { expectI18nMatches, expectSystemLinesLocalised } from "./i18n-helpers.ts";
import { eventually, signedRequest } from "./net-helpers.ts";
import { detailOn, isolateGitConfig, startSharedPair, waitForShared, type GitConfigIsolation, type SharedPair } from "./shared-fixtures.ts";

/**
 * `I18nText` rides next to the English text: it replicates with group messages between two real nodes, survives a restart's
 * worth of storage (rows), and a message from an older node (no `i18n`) is still accepted and shown as plain English.
 */

describe("renderI18n / i18nMsg", () => {
	it("renders params, plurals and nested params like the English text it twins", () => {
		expect(renderI18n("{name} joined", { name: "Bob" })).toBe("Bob joined");
		expect(renderI18n("{count, plural, one {# file} other {# files}} saved", { count: 1 })).toBe("1 file saved");
		expect(renderI18n("{count, plural, one {# file} other {# files}} saved", { count: 3 })).toBe("3 files saved");
		expect(renderI18n("{count, plural, =0 {nothing} one {# file} other {# files}}", { count: 0 })).toBe("nothing");
		expect(renderI18n("Hello {missing}")).toBe("Hello {missing}");
		expect(renderI18n("No params")).toBe("No params");
	});
	it("i18nMsg returns the rendered text and the structured twin; plainMsg has none", () => {
		const m = i18nMsg("{from} → {to}: {reason}", { from: "running", to: "failed", reason: "boom {x}" });
		expect(m.text).toBe("running → failed: boom {x}");
		expect(m.i18n).toEqual({ key: "{from} → {to}: {reason}", params: { from: "running", to: "failed", reason: "boom {x}" } });
		expect(i18nMsg("No params").i18n).toEqual({ key: "No params" });
		expect(plainMsg("raw").i18n).toBeUndefined();
	});
});

let gitConfig: GitConfigIsolation;
beforeAll(() => {
	gitConfig = isolateGitConfig();
});
afterAll(() => gitConfig.restore());

let pair: SharedPair;
afterEach(async () => {
	await pair?.cleanup();
});

describe("group system lines replicate with their i18n twin", () => {
	it("a line noted on A reaches B with the same key and params; the generated join/created lines carry one on both nodes", async () => {
		pair = await startSharedPair();
		const { shared } = await pair.shareAndJoin({ firstPrompt: "start" });
		await waitForShared(pair.a, shared.id, (s) => s.lastCheckpoint?.deliveredTo.includes(pair.bId) === true, "the first snapshot reached B");
		const say = i18nMsg("{name} reviewed {count, plural, one {# file} other {# files}}.", { name: "Bee", count: 2 });
		pair.a.ctx.shared.discussion.note(shared.id, say);
		await eventually(async () => (await detailOn(pair.b, shared.id)).messages.some((m) => m.text === say.text), "the line to reach B");
		for (const node of [pair.a, pair.b]) {
			const messages = (await detailOn(node, shared.id)).messages;
			const line = messages.find((m) => m.text === say.text)!;
			expect(line.i18n).toEqual(say.i18n);
			expect(expectSystemLinesLocalised(messages)).toBeGreaterThan(1);
		}
	});

	it("a message from an older node without `i18n` is accepted and stays plain English; a malformed `i18n` is dropped, not fatal", async () => {
		pair = await startSharedPair();
		const { shared } = await pair.shareAndJoin({ firstPrompt: "start" });
		let seq = 900;
		const push = async (id: string, extra: Record<string, unknown>) => {
			seq += 1;
			const res = await signedRequest(pair.b, pair.a.netUrl, {
				method: "POST",
				path: `/shared/${shared.id}/messages`,
				body: {
					messageId: id,
					epoch: 1,
					kind: "system",
					body: "Old node says hello",
					author: { kind: "system" },
					to: { mode: "agents", agents: [] },
					origin: { nodeId: pair.bId, nodeName: "node-b", seq },
					hlc: `${String(Date.now()).padStart(15, "0")}-00000`,
					createdAt: new Date().toISOString(),
					...extra,
				},
			});
			expect(res.status, JSON.stringify(res.body)).toBe(202);
		};
		await push("shm_i18n_old", {});
		await push("shm_i18n_bad", { body: "Bad twin", i18n: { key: 42, params: "nope" } });
		const messages = (await detailOn(pair.a, shared.id)).messages;
		const old = messages.find((m) => m.id === "shm_i18n_old")!;
		expect(old.text).toBe("Old node says hello");
		expect(old.i18n).toBeUndefined();
		expect(messages.find((m) => m.id === "shm_i18n_bad")?.i18n).toBeUndefined();
		// A well-formed twin on the wire is stored and served.
		const twin: I18nText = { key: "{name} says hello", params: { name: "Old" } };
		await push("shm_i18n_new", { body: "Old says hello", i18n: twin });
		const fresh = (await detailOn(pair.a, shared.id)).messages.find((m) => m.id === "shm_i18n_new")!;
		expectI18nMatches(fresh, "Old says hello");
	});
});

describe("task record `reasonI18n` on the wire", () => {
	const record = { taskId: "tsk_01", status: "blocked", epoch: 1, reason: "Waiting for an answer from node-a", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastEventSeq: 3 };

	it("an older executor's record (no twin) parses; a well-formed twin is kept; a malformed one is dropped, not fatal", () => {
		expect(wire.TaskRecord.parse(record).reasonI18n).toBeUndefined();
		const twin: I18nText = { key: "Waiting for an answer from {node}", params: { node: "node-a" } };
		expect(wire.TaskRecord.parse({ ...record, reasonI18n: twin }).reasonI18n).toEqual(twin);
		expect(wire.TaskRecord.parse({ ...record, reasonI18n: { key: 42, params: "nope" } }).reasonI18n).toBeUndefined();
	});
});
