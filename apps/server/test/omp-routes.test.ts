import { AgentRuntimeError, type OmpCli, type OmpControl } from "@clam/agent-runtime";
import type { LoginFlow, ModelInfo, ModelRoles, OmpInstall } from "@clam/contracts";
import { afterEach, describe, expect, it } from "vitest";
import ompRoutes from "../src/api/omp.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

const INSTALLED: OmpInstall = { installed: true, version: "omp/18.14.0", binaryPath: "/bin/omp", configPath: "/cfg" };
const MODEL: ModelInfo = {
	provider: "p",
	id: "m",
	selector: "p/m",
	name: "M",
	contextWindow: 1000,
	maxTokens: null,
	reasoning: false,
	thinking: [],
	input: ["text"],
	cost: null,
};

function fakeCli() {
	const state = {
		install: INSTALLED as OmpInstall,
		roles: {} as ModelRoles,
		rolesError: null as Error | null,
		invalidations: 0,
		modelCalls: [] as Array<{ refresh?: boolean }>,
		tested: [] as string[],
	};
	const cli: OmpCli = {
		detect: async () => state.install,
		models: async (options) => {
			state.modelCalls.push({ ...(options?.refresh !== undefined ? { refresh: options.refresh } : {}) });
			return [MODEL];
		},
		modelRoles: async () => {
			if (state.rolesError) throw state.rolesError;
			return { ...state.roles };
		},
		setModelRole: async (role, selector) => {
			if (selector === null) delete state.roles[role];
			else state.roles[role] = selector;
			return { ...state.roles };
		},
		testModel: async (selector) => {
			state.tested.push(selector);
			return { ok: true, selector, latencyMs: 5, output: "OK" };
		},
		sessionPack: async () => {
			throw new Error("not used by this test");
		},
		sessionUnpack: async () => {
			throw new Error("not used by this test");
		},
		sessionMoved: async () => {
			throw new Error("not used by this test");
		},
		invalidate: () => {
			state.invalidations++;
		},
	};
	return { cli, state };
}

function fakeControl() {
	const listeners = new Set<(flow: LoginFlow) => void>();
	const flows = new Map<string, LoginFlow>();
	let counter = 0;
	const state = { logouts: [] as Array<[string, number]>, started: [] as string[], listenerCount: () => listeners.size };
	const emit = (flow: LoginFlow) => {
		flows.set(flow.flowId, flow);
		for (const l of listeners) l(flow);
	};
	const control: OmpControl = {
		providers: async () => [{ id: "fake-oauth", name: "Fake", available: true, authenticated: false }],
		accounts: async (providerId) => [{ credentialId: 1, provider: providerId, label: "a@b.c", type: "oauth" }],
		startLogin: (providerId) => {
			state.started.push(providerId);
			const flow: LoginFlow = { flowId: `flow-${++counter}`, providerId, state: "starting", updatedAt: new Date().toISOString() };
			emit(flow);
			return flow;
		},
		submitLoginInput: (flowId, input) => {
			const flow = flows.get(flowId);
			if (!flow?.prompt || flow.prompt.requestId !== input.requestId) {
				throw new AgentRuntimeError("invalid_state", "No pending prompt with that requestId");
			}
			const next: LoginFlow = { ...flow, state: "awaiting_browser", updatedAt: new Date().toISOString() };
			delete next.prompt;
			emit(next);
			return next;
		},
		cancelLogin: (flowId) => {
			const flow = flows.get(flowId) as LoginFlow;
			const next: LoginFlow = { ...flow, state: "cancelled", updatedAt: new Date().toISOString() };
			emit(next);
			return next;
		},
		getFlow: (flowId) => flows.get(flowId),
		onFlow: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		logout: async (providerId, credentialId) => {
			state.logouts.push([providerId, credentialId]);
			return { remainingSource: "env" };
		},
		shutdown: async () => {},
	};
	return { control, state, emit };
}

let h: TestHarness;
afterEach(async () => {
	await h.cleanup();
});

async function setup() {
	const cli = fakeCli();
	const control = fakeControl();
	h = await createTestHarness({ plugins: [ompRoutes], ctx: { ompCli: cli.cli, ompControl: control.control } });
	return { cli, control };
}

const api = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
	h.app.inject({ method, url: `/api/local${url}`, payload: payload as object | undefined });

describe("providers", () => {
	it("returns install, providers and the default model", async () => {
		const { cli } = await setup();
		cli.state.roles = { default: "p/m:high", smol: "p/s" };
		const res = await api("GET", "/omp/providers");
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({
			install: INSTALLED,
			providers: [{ id: "fake-oauth", name: "Fake", available: true, authenticated: false }],
			defaultModel: "p/m:high",
		});
	});

	it("tolerates a role read failure", async () => {
		const { cli } = await setup();
		cli.state.rolesError = new Error("boom");
		const res = await api("GET", "/omp/providers");
		expect(res.statusCode).toBe(200);
		expect(res.json().defaultModel).toBeNull();
		expect(res.json().providers).toHaveLength(1);
	});

	it("returns an empty overview when omp is not installed", async () => {
		const { cli } = await setup();
		cli.state.install = { installed: false, version: null, binaryPath: null, configPath: null, error: "omp not found" };
		const res = await api("GET", "/omp/providers");
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ install: cli.state.install, providers: [], defaultModel: null });
	});

	it("lists provider accounts", async () => {
		await setup();
		const res = await api("GET", "/omp/providers/fake-oauth/accounts");
		expect(res.json()).toEqual([{ credentialId: 1, provider: "fake-oauth", label: "a@b.c", type: "oauth" }]);
	});
});

describe("login", () => {
	it("starts, answers, cancels and publishes flow events", async () => {
		const { control } = await setup();
		const started = await api("POST", "/omp/login", { providerId: "fake-oauth" });
		expect(started.statusCode).toBe(200);
		const flow = started.json() as LoginFlow;
		expect(flow).toMatchObject({ flowId: "flow-1", providerId: "fake-oauth", state: "starting" });
		expect(h.published).toEqual([{ topic: "login:flow-1", event: { type: "flow", flow }, seq: 1 }]);

		// Wrong request id -> 409; unknown flow -> 404.
		control.emit({ ...flow, state: "awaiting_input", prompt: { requestId: "req-1", message: "Code?" } });
		const wrong = await api("POST", "/omp/login/flow-1/input", { requestId: "nope", value: "x" });
		expect(wrong.statusCode).toBe(409);
		expect((await api("POST", "/omp/login/missing/input", { requestId: "req-1", value: "x" })).statusCode).toBe(404);

		const answered = await api("POST", "/omp/login/flow-1/input", { requestId: "req-1", value: "code" });
		expect(answered.statusCode).toBe(200);
		expect(answered.json().state).toBe("awaiting_browser");

		const cancelled = await api("POST", "/omp/login/flow-1/cancel");
		expect(cancelled.json().state).toBe("cancelled");
		expect((await api("POST", "/omp/login/missing/cancel")).statusCode).toBe(404);

		const states = h.published.filter((p) => p.topic === "login:flow-1").map((p) => (p.event as { flow: LoginFlow }).flow.state);
		expect(states).toEqual(["starting", "awaiting_input", "awaiting_browser", "cancelled"]);
	});

	it("invalidates model caches after a successful login", async () => {
		const { cli, control } = await setup();
		const flow = (await api("POST", "/omp/login", { providerId: "fake-oauth" })).json() as LoginFlow;
		expect(cli.state.invalidations).toBe(0);
		control.emit({ ...flow, state: "success" });
		expect(cli.state.invalidations).toBe(1);
	});

	it("validates the body and refuses when omp is not installed", async () => {
		const { cli, control } = await setup();
		expect((await api("POST", "/omp/login", {})).statusCode).toBe(400);
		expect((await api("POST", "/omp/login", { providerId: "" })).statusCode).toBe(400);
		expect((await api("POST", "/omp/login/flow-1/input", { value: "x" })).statusCode).toBe(400);
		cli.state.install = { installed: false, version: null, binaryPath: null, configPath: null, error: "omp not found" };
		const res = await api("POST", "/omp/login", { providerId: "fake-oauth" });
		expect(res.statusCode).toBe(503);
		expect(res.json().error.code).toBe("unavailable");
		expect(control.state.started).toEqual([]);
	});

	it("unsubscribes from flow events when the app closes", async () => {
		const { control } = await setup();
		expect(control.state.listenerCount()).toBe(1);
		await h.app.close();
		expect(control.state.listenerCount()).toBe(0);
	});
});

describe("logout", () => {
	it("logs out and invalidates caches", async () => {
		const { cli, control } = await setup();
		const res = await api("POST", "/omp/logout", { providerId: "fake-oauth", credentialId: 7 });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ remainingSource: "env" });
		expect(control.state.logouts).toEqual([["fake-oauth", 7]]);
		expect(cli.state.invalidations).toBe(1);
		expect((await api("POST", "/omp/logout", { providerId: "fake-oauth", credentialId: 1.5 })).statusCode).toBe(400);
		expect((await api("POST", "/omp/logout", { providerId: "fake-oauth" })).statusCode).toBe(400);
	});
});

describe("models", () => {
	it("lists models and passes refresh", async () => {
		const { cli } = await setup();
		expect((await api("GET", "/omp/models")).json()).toEqual([MODEL]);
		await api("GET", "/omp/models?refresh=1");
		expect(cli.state.modelCalls).toEqual([{ refresh: false }, { refresh: true }]);
		expect((await api("GET", "/omp/models?refresh=maybe")).statusCode).toBe(400);
	});

	it("reads, sets and clears roles", async () => {
		const { cli } = await setup();
		expect((await api("GET", "/omp/model-roles")).json()).toEqual({});
		const set = await api("PUT", "/omp/model-roles", { role: "default", selector: "p/m:high" });
		expect(set.statusCode).toBe(200);
		expect(set.json()).toEqual({ default: "p/m:high" });
		const cleared = await api("PUT", "/omp/model-roles", { role: "default", selector: null });
		expect(cleared.json()).toEqual({});
		expect(cli.state.roles).toEqual({});
	});

	it("rejects malformed role updates with 400", async () => {
		const { cli } = await setup();
		for (const body of [
			{},
			{ role: "" },
			{ role: "a b", selector: "p/m" },
			{ role: "x;rm", selector: "p/m" },
			{ role: "default", selector: "p/m; rm -rf /" },
			{ role: "default", selector: "no-slash" },
			{ role: "default", selector: 5 },
		]) {
			const res = await api("PUT", "/omp/model-roles", body);
			expect(res.statusCode, JSON.stringify(body)).toBe(400);
			expect(res.json().error.code).toBe("invalid_request");
		}
		expect(cli.state.roles).toEqual({});
	});

	it("tests a model", async () => {
		const { cli } = await setup();
		const res = await api("POST", "/omp/models/test", { selector: "p/m" });
		expect(res.json()).toEqual({ ok: true, selector: "p/m", latencyMs: 5, output: "OK" });
		expect(cli.state.tested).toEqual(["p/m"]);
		expect((await api("POST", "/omp/models/test", {})).statusCode).toBe(400);
		expect((await api("POST", "/omp/models/test", { selector: "a/b c" })).statusCode).toBe(400);
		expect(cli.state.tested).toEqual(["p/m"]);
	});
});

describe("runtime errors", () => {
	it("maps AgentRuntimeError from the control process", async () => {
		const { control } = await setup();
		control.control.providers = async () => {
			throw new AgentRuntimeError("start_failed", "cannot start");
		};
		const res = await api("GET", "/omp/providers");
		expect(res.statusCode).toBe(502);
		expect(res.json().error.code).toBe("runtime_start_failed");
	});
});
