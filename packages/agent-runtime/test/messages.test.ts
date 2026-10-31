import { describe, expect, it } from "vitest";
import type { RuntimeStatus } from "@clam/contracts";
import { resultText, toLiveState, toSessionStats, toTokenTotals, toUiMessage } from "../src/omp/index.ts";

const runtime: RuntimeStatus = { sessionId: "s", state: "ready", pid: 1, startedAt: null, restarts: 0, lastError: null, lastActivityAt: null };

describe("messages", () => {
	it("toTokenTotals prefers totalTokens, falls back to the sum, tolerates junk", () => {
		expect(toTokenTotals({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 99 }).total).toBe(99);
		expect(toTokenTotals({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }).total).toBe(10);
		expect(toTokenTotals({ input: 1, total: 7 }).total).toBe(7);
		expect(toTokenTotals(null)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
	});

	it("toSessionStats maps get_session_stats data", () => {
		const s = toSessionStats({
			sessionId: "abc",
			userMessages: 1,
			assistantMessages: 2,
			toolCalls: 3,
			tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 3, cacheWrite: 4, total: 10 },
			cost: 0.25,
			contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
		});
		expect(s).toEqual({
			sessionId: "abc",
			userMessages: 1,
			assistantMessages: 2,
			toolCalls: 3,
			tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
			cost: 0.25,
			contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
		});
		expect(toSessionStats(undefined).sessionId).toBeNull();
		expect(toSessionStats({ contextUsage: { tokens: null } }).contextUsage).toBeNull();
	});

	it("toLiveState maps get_state data", () => {
		const live = toLiveState({
			sessionId: "s",
			runtime,
			availableThinkingLevels: ["off", "low"],
			state: {
				model: { provider: "anthropic", id: "opus", name: "Opus", contextWindow: 1 },
				thinkingLevel: "low",
				isStreaming: false,
				isSettled: true,
				contextUsage: { tokens: 5, contextWindow: 50, percent: 10 },
				queuedMessages: { steering: ["a"], followUp: [], liveSteered: 0 },
				todoPhases: [{ name: "P", tasks: [{ content: "t", status: "pending" }] }],
				tokensPerSecond: 4.5,
			},
		});
		expect(live).toMatchObject({
			sessionId: "s",
			model: { provider: "anthropic", id: "opus", name: "Opus" },
			thinkingLevel: "low",
			availableThinkingLevels: ["off", "low"],
			isStreaming: false,
			isSettled: true,
			queued: { steering: ["a"], followUp: [] },
			todoPhases: [{ name: "P", tasks: [{ content: "t", status: "pending" }] }],
			tokensPerSecond: 4.5,
		});
		const empty = toLiveState({ sessionId: "s", runtime, availableThinkingLevels: [], state: null });
		expect(empty.model).toBeNull();
		expect(empty.isSettled).toBe(true);
		expect(empty.tokensPerSecond).toBeNull();
	});

	it("resultText joins text blocks, falls back to JSON and caps size", () => {
		expect(resultText({ content: [{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }] })).toBe("a\nb");
		expect(resultText({ foo: 1 })).toBe('{"foo":1}');
		expect(resultText("plain")).toBe("plain");
		expect(resultText(undefined)).toBe("");
		const big = resultText({ content: [{ type: "text", text: "y".repeat(100_000) }] });
		expect(big.length).toBeLessThan(66_000);
		expect(big).toContain("truncated");
	});

	it("toUiMessage handles user string content, clientId and junk", () => {
		expect(toUiMessage({ role: "user", content: "hi", timestamp: 3 }, "m1", { clientId: "c" })).toEqual({
			id: "m1",
			role: "user",
			timestamp: 3,
			content: [{ type: "text", text: "hi" }],
			clientId: "c",
		});
		expect(toUiMessage("x", "m1")).toBeNull();
		expect(toUiMessage({ role: "nope" }, "m1")).toBeNull();
	});

	it("toUiMessage keeps toolResult images", () => {
		const m = toUiMessage(
			{ role: "toolResult", toolCallId: "t", toolName: "read", isError: true, timestamp: 1, content: [{ type: "text", text: "e" }, { type: "image", data: "AA", mimeType: "image/png" }] },
			"m2",
		);
		expect(m).toMatchObject({ role: "toolResult", toolCallId: "t", toolName: "read", isError: true });
		expect(m?.content).toEqual([
			{ type: "text", text: "e" },
			{ type: "image", mimeType: "image/png", data: "AA" },
		]);
	});
});
