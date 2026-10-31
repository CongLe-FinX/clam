import type { GithubAccount } from "@clam/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceFlowManager } from "../src/index.ts";
import { fakeFetch } from "./helpers.ts";

const account = { id: "a1", login: "octo" } as GithubAccount;
const START = { device_code: "DC", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 };
const poll = (json: unknown) => ({ json });

function setup(pollReplies: unknown[], over: { completeLogin?: () => Promise<GithubAccount> } = {}) {
	const events: { topic: string; event: any }[] = [];
	const ff = fakeFetch({
		"POST https://github.com/login/device/code": { json: START },
		"POST https://github.com/login/oauth/access_token": (n) => {
			const r = pollReplies[Math.min(n, pollReplies.length - 1)];
			return r instanceof Error ? r : poll(r);
		},
	});
	const manager = new DeviceFlowManager({
		fetch: ff.fn,
		completeLogin: over.completeLogin ?? (async () => account),
		publish: (topic, event) => events.push({ topic, event }),
		newId: () => "flow1",
		now: () => Date.now(),
	});
	return { manager, ff, events };
}
const pollCalls = (ff: ReturnType<typeof fakeFetch>) => ff.calls.filter((c) => c.url.endsWith("/access_token"));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("device flow state machine", () => {
	it("sends the public client id, repo/read:user/user:email scopes and no secret", async () => {
		const { manager, ff } = setup([{ error: "authorization_pending" }]);
		const start = await manager.start("client123");
		expect(start).toMatchObject({ flowId: "flow1", userCode: "ABCD-1234", intervalSec: 5 });
		const body = new URLSearchParams(ff.calls[0]!.body!);
		expect(body.get("client_id")).toBe("client123");
		expect(body.get("scope")).toBe("repo read:user user:email");
		expect(body.has("client_secret")).toBe(false);
		manager.dispose();
	});

	it("keeps polling on authorization_pending at the given interval, then succeeds and publishes once", async () => {
		const { manager, ff, events } = setup([{ error: "authorization_pending" }, { error: "authorization_pending" }, { access_token: "gho_x", scope: "repo,read:user" }]);
		await manager.start("c");
		await vi.advanceTimersByTimeAsync(4_999);
		expect(pollCalls(ff)).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(pollCalls(ff)).toHaveLength(1);
		expect(manager.status("flow1")?.state).toBe("pending");
		await vi.advanceTimersByTimeAsync(10_000);
		expect(manager.status("flow1")).toMatchObject({ state: "success", account });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ topic: "github-device:flow1", event: { type: "flow", status: { state: "success" } } });
		expect(new URLSearchParams(pollCalls(ff)[0]!.body!).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(pollCalls(ff)).toHaveLength(3); // no polling after a terminal state
	});

	it("slows down by 5s on slow_down (or adopts the larger interval GitHub returns)", async () => {
		const { manager, ff } = setup([{ error: "slow_down" }, { error: "slow_down", interval: 30 }, { error: "authorization_pending" }]);
		await manager.start("c");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(pollCalls(ff)).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(9_999); // next poll at +10s
		expect(pollCalls(ff)).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(pollCalls(ff)).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(29_999); // adopted interval 30s
		expect(pollCalls(ff)).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(pollCalls(ff)).toHaveLength(3);
		manager.dispose();
	});

	it.each([
		["expired_token", "expired"],
		["access_denied", "denied"],
	] as const)("%s ends the flow as %s", async (error, state) => {
		const { manager, events } = setup([{ error }]);
		await manager.start("c");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(manager.status("flow1")?.state).toBe(state);
		expect(events).toHaveLength(1);
	});

	it("reports unknown errors with GitHub's description", async () => {
		const { manager } = setup([{ error: "unsupported_grant_type", error_description: "bad grant" }]);
		await manager.start("c");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(manager.status("flow1")).toMatchObject({ state: "error", error: "bad grant" });
	});

	it("expires locally at the deadline even if GitHub is never reached", async () => {
		const { manager, events } = setup([{ error: "authorization_pending" }]);
		await manager.start("c");
		await vi.advanceTimersByTimeAsync(900_000 + 5_000);
		expect(manager.status("flow1")?.state).toBe("expired");
		expect(events.at(-1)?.event.status.state).toBe("expired");
	});

	it("survives transient network errors but gives up after repeated failures", async () => {
		const flaky = setup([new TypeError("fetch failed"), { error: "authorization_pending" }, { access_token: "t" }]);
		await flaky.manager.start("c");
		await vi.advanceTimersByTimeAsync(20_000);
		expect(flaky.manager.status("flow1")?.state).toBe("success");

		const down = setup([new TypeError("fetch failed")]);
		await down.manager.start("c");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(down.manager.status("flow1")?.state).toBe("error");
	});

	it("turns a failed account completion into an error state", async () => {
		const { manager } = setup([{ access_token: "t" }], { completeLogin: async () => Promise.reject(new Error("profile fetch failed")) });
		await manager.start("c");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(manager.status("flow1")).toMatchObject({ state: "error", error: "profile fetch failed" });
	});

	it("explains a disabled device flow when starting", async () => {
		const ff = fakeFetch({ "POST https://github.com/login/device/code": { status: 200, json: { error: "device_flow_disabled" } } });
		const manager = new DeviceFlowManager({ fetch: ff.fn, completeLogin: async () => account, publish: () => {}, newId: () => "f", now: () => Date.now() });
		await expect(manager.start("c")).rejects.toMatchObject({ code: "not_configured", message: expect.stringContaining("Device Flow") });
	});
});
