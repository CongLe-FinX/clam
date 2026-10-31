import type { AgentRuntime, RuntimeSession, UsageDelta } from "@clam/agent-runtime";
import type { MeshUsage, SessionEvent, SessionStats } from "@clam/contracts";
import { agentSessions, agents, projects, providerUsage, workspaces } from "@clam/database";
import { afterEach, describe, expect, it } from "vitest";
import sessionRoutes from "../src/api/sessions.ts";
import meshUsageRoutes from "../src/api/usage-mesh.ts";
import { createTestHarness, idleRuntime, type TestHarness } from "./helpers.ts";

let harness: TestHarness | undefined;
afterEach(async () => {
	await harness?.cleanup();
	harness = undefined;
});

const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite });

/** Runtime whose sessions report scripted per-message usage and cumulative stats; tests fire `settled` themselves. */
function scriptedRuntime() {
	const runtime = idleRuntime();
	const listeners: Array<(sessionId: string, event: SessionEvent) => void> = [];
	const script = { deltas: [] as UsageDelta[], stats: null as (SessionStats & { sessionId: string | null }) | null, statsFail: false };
	const session = {
		sessionId: "ses1",
		takeUsage: () => script.deltas.splice(0),
		pendingUiRequests: () => [],
		getStats: async () => {
			if (script.statsFail || !script.stats) throw new Error("stats unavailable");
			return script.stats;
		},
		status: () => ({ sessionId: "ses1", state: "ready", pid: 1, startedAt: null, restarts: 0, lastError: null, lastActivityAt: null }),
	} as unknown as RuntimeSession;
	const scripted: AgentRuntime & { stopped: string[] } = {
		...runtime,
		get: (id) => (id === "ses1" ? session : undefined),
		onEvent: (listener) => {
			listeners.push(listener);
			return () => {};
		},
	};
	return { runtime: scripted, script, settle: () => listeners.forEach((l) => l("ses1", { type: "settled" })) };
}

async function setup() {
	const scripted = scriptedRuntime();
	harness = await createTestHarness({ plugins: [sessionRoutes, meshUsageRoutes], ctx: { runtime: scripted.runtime } });
	const { db, identity } = harness.ctx;
	db.insert(workspaces).values({ id: "w1", name: "w", ownerNodeId: identity.nodeId }).run();
	db.insert(projects).values({ id: "p1", workspaceId: "w1", name: "Proj", path: harness.dataDir }).run();
	db.insert(agents).values({ id: "a1", nodeId: identity.nodeId, name: "Agent", runtime: "omp" }).run();
	db.insert(agentSessions).values({ id: "ses1", agentId: "a1", projectId: "p1", title: "t", sessionDir: `${harness.dataDir}/sessions/ses1`, model: "fake/alpha" }).run();
	return { ...scripted, harness };
}

/** Fire `settled` and wait for the flush to finish: touch() and the post-flush stats upsert are two `sessions` events. */
async function flush(settle: () => void): Promise<void> {
	const upserts = () => harness?.published.filter((p) => p.topic === "sessions").length ?? 0;
	const before = upserts();
	settle();
	const deadline = Date.now() + 3000;
	while (upserts() < before + 2) {
		if (Date.now() > deadline) throw new Error("usage flush did not complete");
		await new Promise((r) => setTimeout(r, 10));
	}
}

function rows() {
	return harness?.ctx.db.select().from(providerUsage).all() ?? [];
}

describe("usage accounting", () => {
	it("records per-model usage from finished messages and reconciles the cumulative stats without double counting", async () => {
		const { script, settle } = await setup();
		script.deltas = [
			{ provider: "anthropic", model: "opus", tokens: tokens(100, 20, 0, 500), cost: 0.5 },
			{ provider: "openai", model: "gpt", tokens: tokens(10, 5), cost: 0.1 },
		];
		script.stats = { sessionId: "r1", userMessages: 1, assistantMessages: 2, toolCalls: 0, tokens: tokens(110, 25, 0, 500), cost: 0.6, contextUsage: null };
		await flush(settle);
		expect(rows().map((r) => [r.provider, r.model, r.inputTokens, r.cacheWriteTokens, r.cost, r.source])).toEqual([
			["anthropic", "opus", 100, 500, 0.5, "omp-recorded"],
			["openai", "gpt", 10, 0, 0.1, "omp-recorded"],
		]);

		// Second run: stats grew by exactly the new message; nothing extra is recorded.
		script.deltas = [{ provider: "anthropic", model: "opus", tokens: tokens(7, 3), cost: 0.05 }];
		script.stats = { sessionId: "r1", userMessages: 2, assistantMessages: 3, toolCalls: 0, tokens: tokens(117, 28, 0, 500), cost: 0.65, contextUsage: null };
		await flush(settle);
		expect(rows()).toHaveLength(3);
		const stored = harness?.ctx.db.select().from(agentSessions).get();
		expect(stored?.stats).toMatchObject({ assistantMessages: 3, cost: 0.65 });
		expect(stored?.stats).not.toHaveProperty("sessionId");
	});

	it("attributes what the cumulative stats include beyond finished messages to one residual row under the session model", async () => {
		const { script, settle } = await setup();
		script.deltas = [{ provider: "anthropic", model: "opus", tokens: tokens(100, 20), cost: 0.5 }];
		// Sub-agent usage / a run lost to a crash: stats are ahead of what the messages explain.
		script.stats = { sessionId: "r1", userMessages: 1, assistantMessages: 1, toolCalls: 2, tokens: tokens(140, 50, 10, 0), cost: 0.9, contextUsage: null };
		await flush(settle);
		const [first, residual] = rows();
		expect(first).toMatchObject({ provider: "anthropic", model: "opus", inputTokens: 100 });
		expect(residual).toMatchObject({ provider: "fake", model: "alpha", inputTokens: 40, outputTokens: 30, cacheReadTokens: 10, source: "omp-recorded" });
		expect(residual?.cost).toBeCloseTo(0.4, 9);
		// A flush with no growth adds nothing, even though stats are "ahead" of the finished messages of this run.
		script.deltas = [];
		await flush(settle);
		expect(rows()).toHaveLength(2);
	});

	it("never records negative residuals when stats fall behind recorded totals", async () => {
		const { script, settle } = await setup();
		script.deltas = [{ provider: "p", model: "m", tokens: tokens(100, 100), cost: 1 }];
		script.stats = { sessionId: null, userMessages: 1, assistantMessages: 1, toolCalls: 0, tokens: tokens(50, 50), cost: 0.5, contextUsage: null };
		await flush(settle);
		expect(rows()).toHaveLength(1);
		expect(rows().every((r) => r.inputTokens >= 0 && r.cost >= 0)).toBe(true);
	});

	it("still records per-message usage when get_session_stats fails", async () => {
		const { script, settle } = await setup();
		script.statsFail = true;
		script.deltas = [{ provider: "p", model: "m", tokens: tokens(3, 4), cost: 0.01 }];
		settle();
		const deadline = Date.now() + 3000;
		while (rows().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
		expect(rows()).toHaveLength(1);
		expect(harness?.ctx.db.select().from(agentSessions).get()?.stats).toBeNull();
	});

	it("rolls usage up by project and agent with the OMP-recorded source", async () => {
		const { script, settle, harness: h } = await setup();
		script.deltas = [{ provider: "p", model: "m", tokens: tokens(1000, 200, 30, 4), cost: 1.25 }];
		script.stats = { sessionId: "r", userMessages: 1, assistantMessages: 1, toolCalls: 0, tokens: tokens(1000, 200, 30, 4), cost: 1.25, contextUsage: null };
		await flush(settle);
		const res = await h.app.inject({ method: "GET", url: "/api/local/usage/mesh", headers: { host: "localhost" } });
		const mesh = res.json() as MeshUsage;
		expect(mesh.byProject).toEqual([{ key: "p1", label: "Proj", sessions: 1, tokens: tokens(1000, 200, 30, 4), cost: 1.25, source: "omp-recorded" }]);
		expect(mesh.byAgent).toEqual([{ key: "a1", label: "Agent", sessions: 1, tokens: tokens(1000, 200, 30, 4), cost: 1.25, source: "omp-recorded" }]);
		expect(mesh.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("reports an empty roll-up when nothing was recorded", async () => {
		const { harness: h } = await setup();
		const res = await h.app.inject({ method: "GET", url: "/api/local/usage/mesh", headers: { host: "localhost" } });
		expect(res.json()).toMatchObject({ byProject: [], byAgent: [] });
	});
});
