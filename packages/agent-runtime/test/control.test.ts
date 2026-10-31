import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoginFlow } from "@clam/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOmpControl, type OmpControl } from "../src/omp/index.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));

let home: string;
let controls: OmpControl[] = [];
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "clam-control-"));
});
afterEach(async () => {
	await Promise.all(controls.map((c) => c.shutdown()));
	controls = [];
	await rm(home, { recursive: true, force: true });
});

function make(options: Partial<Parameters<typeof createOmpControl>[0]> = {}, env: Record<string, string> = {}) {
	const log = join(home, "rpc.jsonl");
	const control = createOmpControl({
		binary: () => FAKE,
		cwd: home,
		env: { FAKE_OMP_HOME: home, FAKE_OMP_LOG: log, ...env },
		...options,
	});
	controls.push(control);
	const events: LoginFlow[] = [];
	control.onFlow((flow) => events.push(flow));
	return { control, events };
}

async function spawnCount(): Promise<number> {
	try {
		const text = await readFile(join(home, "rpc.jsonl"), "utf8");
		return text
			.trim()
			.split("\n")
			.filter((line) => line && (JSON.parse(line) as { kind: string }).kind === "spawn").length;
	} catch {
		return 0;
	}
}

async function waitFor<T>(probe: () => T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("queries", () => {
	it("lists providers, accounts and logs out", async () => {
		const { control, events } = make();
		const providers = await control.providers();
		expect(providers.map((p) => p.id)).toEqual(["fake-oauth", "fake-key", "fake-secret", "fake-fail"]);
		expect(providers.every((p) => p.available)).toBe(true);
		expect(providers.find((p) => p.id === "fake-oauth")?.authenticated).toBe(false);
		expect(await control.accounts("fake-oauth")).toEqual([]);

		const flow = control.startLogin("fake-oauth");
		const prompt = await waitFor(() => control.getFlow(flow.flowId)?.prompt, "prompt");
		control.submitLoginInput(flow.flowId, { requestId: prompt.requestId, value: "code" });
		await waitFor(() => control.getFlow(flow.flowId)?.state === "success", "success");
		expect(events.at(-1)?.state).toBe("success");

		expect((await control.providers()).find((p) => p.id === "fake-oauth")?.authenticated).toBe(true);
		const accounts = await control.accounts("fake-oauth");
		expect(accounts).toEqual([
			{ credentialId: 1, provider: "fake-oauth", label: "fake@example.com", detail: "fake account", type: "oauth", active: true },
		]);
		expect(await control.logout("fake-oauth", 1)).toEqual({ remainingSource: null });
		expect((await control.providers()).find((p) => p.id === "fake-oauth")?.authenticated).toBe(false);
		expect(await spawnCount()).toBe(1);
	});

	it("fails with not_installed when omp is missing", async () => {
		const { control } = make({ binary: () => null });
		await expect(control.providers()).rejects.toMatchObject({ code: "not_installed" });
		const flow = control.startLogin("fake-oauth");
		expect(flow.state).toBe("starting");
		await waitFor(() => control.getFlow(flow.flowId)?.state === "error", "error");
		expect(control.getFlow(flow.flowId)?.error).toMatch(/omp not found/);
	});

	it("rejects calls after shutdown", async () => {
		const { control } = make();
		await control.providers();
		await control.shutdown();
		await expect(control.providers()).rejects.toMatchObject({ code: "invalid_state" });
		expect(() => control.startLogin("fake-oauth")).toThrow();
	});
});

describe("login flow", () => {
	it("walks starting -> awaiting_browser -> awaiting_input -> awaiting_browser -> success", async () => {
		const { control, events } = make();
		const started = control.startLogin("fake-oauth");
		expect(started.state).toBe("starting");
		expect(started.flowId).toMatch(/^[0-9a-f-]{36}$/);
		expect(Number.isNaN(Date.parse(started.updatedAt))).toBe(false);

		const awaiting = await waitFor(() => control.getFlow(started.flowId)?.prompt && control.getFlow(started.flowId), "prompt");
		expect(awaiting.state).toBe("awaiting_input");
		expect(awaiting.url).toBe("https://fake.example/oauth/authorize?provider=fake-oauth&state=abc");
		expect(awaiting.instructions).toBe("Open the URL and authorize");
		expect(awaiting.prompt).toMatchObject({ message: "Paste the authorization code", placeholder: "code" });

		expect(() => control.submitLoginInput(started.flowId, { requestId: "bogus", value: "x" })).toThrow(/pending/);
		expect(() => control.submitLoginInput("nope", { requestId: "x", value: "x" })).toThrow();

		const afterSubmit = control.submitLoginInput(started.flowId, { requestId: (awaiting.prompt as { requestId: string }).requestId, value: "abc" });
		expect(afterSubmit.state).toBe("awaiting_browser");
		expect(afterSubmit.prompt).toBeUndefined();
		await waitFor(() => control.getFlow(started.flowId)?.state === "success", "success");
		expect(events.map((e) => e.state)).toEqual(["starting", "awaiting_browser", "awaiting_input", "awaiting_browser", "success"]);
		expect(new Set(events.map((e) => e.flowId)).size).toBe(1);
		// Terminal flows reject input and ignore cancel.
		expect(() => control.submitLoginInput(started.flowId, { requestId: "x", value: "y" })).toThrow();
		expect(control.cancelLogin(started.flowId).state).toBe("success");
	});

	it("surfaces a provider failure", async () => {
		const { control } = make();
		const flow = control.startLogin("fake-fail");
		const done = await waitFor(() => control.getFlow(flow.flowId)?.state === "error" && control.getFlow(flow.flowId), "error");
		expect(done.error).toBe("Login failed: provider rejected the authorization");
	});

	it("refuses secret prompts and never forwards them", async () => {
		const { control, events } = make();
		const flow = control.startLogin("fake-secret");
		const done = await waitFor(() => control.getFlow(flow.flowId)?.state === "error" && control.getFlow(flow.flowId), "error");
		expect(done.error).toMatch(/omp login fake-secret/);
		expect(events.some((e) => e.state === "awaiting_input" || e.prompt !== undefined)).toBe(false);
		// The control process is restarted transparently afterwards.
		await expect(control.providers()).resolves.toHaveLength(4);
	});

	it("cancels, leaves the login unfinished and restarts the process", async () => {
		const { control, events } = make();
		const flow = control.startLogin("fake-oauth");
		await waitFor(() => control.getFlow(flow.flowId)?.prompt, "prompt");
		const cancelled = control.cancelLogin(flow.flowId);
		expect(cancelled.state).toBe("cancelled");
		expect(cancelled.prompt).toBeUndefined();
		await sleep(300);
		expect(control.getFlow(flow.flowId)?.state).toBe("cancelled");
		expect(events.at(-1)?.state).toBe("cancelled");
		const providers = await control.providers();
		expect(providers.find((p) => p.id === "fake-oauth")?.authenticated).toBe(false);
		expect(await spawnCount()).toBe(2);
		expect(control.cancelLogin(flow.flowId).state).toBe("cancelled");
	});

	it("cancels a flow that is still starting", async () => {
		const { control } = make({}, { FAKE_OMP_READY_DELAY_MS: "300" });
		const flow = control.startLogin("fake-oauth");
		expect(control.cancelLogin(flow.flowId).state).toBe("cancelled");
		await sleep(700);
		expect(control.getFlow(flow.flowId)?.state).toBe("cancelled");
		await expect(control.providers()).resolves.toHaveLength(4);
	});

	it("starting a second flow cancels the first", async () => {
		const { control } = make();
		const first = control.startLogin("fake-oauth");
		await waitFor(() => control.getFlow(first.flowId)?.prompt, "first prompt");
		const second = control.startLogin("fake-key");
		expect(control.getFlow(first.flowId)?.state).toBe("cancelled");
		const awaiting = await waitFor(() => control.getFlow(second.flowId)?.prompt && control.getFlow(second.flowId), "second prompt");
		expect(awaiting.providerId).toBe("fake-key");
		expect(awaiting.url).toContain("provider=fake-key");
		expect(control.getFlow(first.flowId)?.state).toBe("cancelled");
	});

	it("fails the flow when the process crashes and recovers on next use", async () => {
		const wrapper = join(home, "wrapper.sh");
		await writeFile(
			wrapper,
			`#!/bin/sh\nif [ ! -f "$FAKE_OMP_HOME/crashed" ]; then touch "$FAKE_OMP_HOME/crashed"; FAKE_OMP_EXIT_AFTER_MS=1200 exec "${FAKE}" "$@"; fi\nexec "${FAKE}" "$@"\n`,
		);
		await chmod(wrapper, 0o755);
		const { control } = make({ binary: () => wrapper });
		const flow = control.startLogin("fake-oauth");
		const done = await waitFor(() => control.getFlow(flow.flowId)?.state === "error" && control.getFlow(flow.flowId), "crash error");
		expect(done.error).toBeTruthy();
		expect(done.prompt).toBeUndefined();
		await expect(control.providers()).resolves.toHaveLength(4);
	});

	it("evicts finished flows after the retention period", async () => {
		const { control } = make({ flowRetentionMs: 150 });
		const flow = control.startLogin("fake-oauth");
		await waitFor(() => control.getFlow(flow.flowId)?.prompt, "prompt");
		control.cancelLogin(flow.flowId);
		expect(control.getFlow(flow.flowId)?.state).toBe("cancelled");
		await waitFor(() => control.getFlow(flow.flowId) === undefined, "eviction");
	});

	it("swallows listener errors and supports unsubscribe", async () => {
		const { control } = make();
		control.onFlow(() => {
			throw new Error("listener boom");
		});
		const seen: string[] = [];
		const off = control.onFlow((f) => seen.push(f.state));
		const flow = control.startLogin("fake-fail");
		await waitFor(() => control.getFlow(flow.flowId)?.state === "error", "error");
		off();
		const count = seen.length;
		control.startLogin("fake-fail");
		await sleep(200);
		expect(seen.length).toBe(count);
		expect(seen).toContain("error");
	});
});

describe("process lifecycle", () => {
	it("stops when idle and starts lazily again", async () => {
		const { control } = make({ idleStopMs: 200 });
		await control.providers();
		expect(await spawnCount()).toBe(1);
		await sleep(700);
		await control.providers();
		expect(await spawnCount()).toBe(2);
	});

	it("does not stop while a flow is active", async () => {
		const { control } = make({ idleStopMs: 150 });
		const flow = control.startLogin("fake-oauth");
		await waitFor(() => control.getFlow(flow.flowId)?.prompt, "prompt");
		await sleep(600);
		expect(control.getFlow(flow.flowId)?.state).toBe("awaiting_input");
		expect(await spawnCount()).toBe(1);
	});

	it("starts the process with the expected arguments", async () => {
		const { control } = make({ profile: "clam-dev" });
		await control.providers();
		const first = JSON.parse((await readFile(join(home, "rpc.jsonl"), "utf8")).split("\n")[0] as string) as { argv: string[] };
		expect(first.argv).toEqual(["--profile", "clam-dev", "--mode", "rpc", "--no-ui", "--no-session", "--cwd", home]);
	});
});
