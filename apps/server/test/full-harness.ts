import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOmpCli, createOmpControl, createOmpRuntime } from "@clam/agent-runtime/omp";
import { openDatabase } from "@clam/database";
import { createGitEngine } from "@clam/git-engine";
import { createGithubService } from "@clam/github-integration";
import { loadOrCreateIdentity } from "@clam/node-identity";
import type { SecretStore } from "@clam/secret-store";
import pino from "pino";
import { buildApp } from "../src/app.ts";
import { createEventBus } from "../src/bus.ts";
import type { ServerConfig, ServerContext } from "../src/context.ts";
import type { NetworkBase } from "../src/network/types.ts";
import type { TaskTimings } from "../src/tasks/hub.ts";
import type { SharedOptions } from "../src/shared/hub.ts";
import type { ContextTimings } from "../src/context/service.ts";
import type { HandoffTimings } from "../src/handoff/hub.ts";
import type { FaultOptions } from "../src/handoff/fault.ts";
import { assembleContext } from "../src/assemble.ts";
import type { TerminalOptions } from "../src/terminal/service.ts";
import type { PreviewServiceOptions } from "../src/preview/service.ts";
import type { NetworkOptions, NetworkService } from "../src/network/index.ts";
import { createAutostartManager } from "../src/services/autostart.ts";
import { ensureDefaultAgent, ensureNodeRow } from "../src/services/bootstrap.ts";
import { readNodeSettings, toSupervisorSettings, writeNodeSettings } from "../src/services/settings.ts";

export const FAKE_OMP = fileURLToPath(new URL("../../../packages/agent-runtime/test/fixtures/fake-omp.mjs", import.meta.url));

export interface FullHarness {
	ctx: ServerContext;
	app: Awaited<ReturnType<typeof buildApp>>;
	/** `http://127.0.0.1:<port>` of the listening app. */
	url: string;
	port: number;
	dataDir: string;
	/** A directory usable as a project path. */
	projectDir: string;
	/** Commands/spawns the fake omp processes recorded (JSON lines of FAKE_OMP_LOG). */
	fakeLog: string;
	net: NetworkService;
	/** `http://127.0.0.1:<port>` of the `/api/v1` listener (0 when the harness was started without a network listener). */
	netUrl: string;
	netPort: number;
	/** `keepData` leaves the data directory (identity, database) so a "restarted" node can reuse it. */
	cleanup(options?: { keepData?: boolean }): Promise<void>;
}

/** Secret store in memory, shareable between two harness instances of one node to model a restart. */
export function createMemorySecrets(): SecretStore {
	const values = new Map<string, string>();
	return {
		backend: "encrypted-file",
		location: "memory",
		get: async (key) => values.get(key) ?? null,
		set: async (key, value) => void values.set(key, value),
		delete: async (key) => void values.delete(key),
	};
}

/**
 * The real server (Fastify app, WebSocket hub, SQLite, runtime supervisor, OMP CLI/control) wired to the
 * fake omp executable and listening on an ephemeral loopback port. Nothing is mocked inside the server.
 */
export async function createFullHarness(
	options: {
		webDistDir?: string | null;
		supervisor?: Parameters<typeof createOmpRuntime>[0]["restart"];
		env?: Record<string, string>;
		/** Per-request timeout of the OMP transport (default 30 s). */
		requestTimeoutMs?: number;
		/** Reuse an existing data directory (a restart of the same node). */
		dataDir?: string;
		/** Serve `/api/v1` on a loopback port (loopback peers allowed). Absent: the network service exists but does not listen. */
		network?: { port?: number; options?: NetworkOptions; nodeName?: string };
		/** Secret store (default: a fresh in-memory one). */
		secrets?: SecretStore;
		/** Start the task engine (outbox, mirror, executor, mesh host tools). Default: only when `network` is set. */
		tasks?: boolean;
		/** Task engine timers (default: fast ones, so polling and retries are observable in milliseconds). */
		taskTimings?: Partial<TaskTimings>;
		/** Handoff engine timers (HandoffServiceOptions.timings). */
		handoffTimings?: Partial<HandoffTimings>;
		/** Handoff fault injection (HandoffServiceOptions.fault). */
		handoffFault?: FaultOptions;
		/** Shared-session timers (default: fast ones). */
		sharedTimings?: Partial<SharedOptions>;
		/** Context sync timers (default: a fast reconcile so catch-up is observable in milliseconds). */
		contextTimings?: Partial<ContextTimings>;
		/** Terminal service limits/timers (TerminalOptions). */
		terminal?: TerminalOptions;
		/** Preview service seams (the reachability check's HTTP client). */
		preview?: PreviewServiceOptions;
	} = {},
): Promise<FullHarness> {
	const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "clam-full-"));
	const projectDir = join(dataDir, "project");
	mkdirSync(projectDir, { recursive: true });
	const fakeLog = join(dataDir, "fake-omp.log");
	const fakeHome = join(dataDir, "fake-home");
	mkdirSync(fakeHome, { recursive: true });
	const log = pino({ level: "silent" });

	const config: ServerConfig = {
		dataDir,
		host: "127.0.0.1",
		port: 0,
		version: "0.0.0-test",
		webDistDir: options.webDistDir ?? null,
		ompBinary: FAKE_OMP,
		ompProfile: null,
		networkHost: "127.0.0.1",
		networkPort: options.network?.port ?? 0,
		allowLoopbackPeers: options.network !== undefined,
	};
	const db = openDatabase({ file: join(dataDir, "clam.db") });
	const identity = loadOrCreateIdentity({ dataDir });
	if (options.network?.nodeName) writeNodeSettings(db, { nodeName: options.network.nodeName });
	const settings = readNodeSettings(db);
	ensureNodeRow(db, identity, settings.nodeName);
	ensureDefaultAgent(db, identity.nodeId);

	const env = { FAKE_OMP_LOG: fakeLog, FAKE_OMP_HOME: fakeHome, FAKE_OMP_EVENT_DELAY_MS: "1", ...options.env };
	const binary = () => FAKE_OMP;
	const runtime = createOmpRuntime({
		binary,
		settings: toSupervisorSettings(settings),
		env,
		stateRefreshMs: 10,
		requestTimeoutMs: options.requestTimeoutMs,
		closeGraceMs: 1000,
		restart: options.supervisor ?? { baseDelayMs: 20, maxDelayMs: 100, maxAttempts: 3 },
		reapIntervalMs: 50,
	});
	const bus = createEventBus();
	const secrets = options.secrets ?? createMemorySecrets();
	const runtimeDir = mkdtempSync(join(tmpdir(), "clam-run-"));
	const git = await createGitEngine({ runtimeDir });
	const github = createGithubService({ db, secrets, publish: (topic, event) => bus.publish(topic, event) });
	const base: NetworkBase = {
		config,
		db,
		secrets,
		git,
		github,
		bus,
		log,
		omp: { binaryPath: () => FAKE_OMP, refresh: async () => FAKE_OMP },
		identity,
		runtime,
		ompCli: createOmpCli({ binary, env: { ...process.env, ...env } }),
		ompControl: createOmpControl({ binary, cwd: dataDir, env }),
		autostart: createAutostartManager({
			config,
			entry: join(dataDir, "missing-dist", "main.js"),
			ompBinary: binary,
			home: join(dataDir, "home"),
			// Never run launchctl/systemctl/schtasks from tests.
			run: async () => ({ code: 0, stdout: "", stderr: "" }),
		}),
		startedAt: new Date(),
	};
	const ctx: ServerContext = assembleContext(base, {
		network: options.network?.options,
		tasks: { timings: { mirrorIntervalMs: 150, outboxTickMs: 80, injectRetryMs: 100, injectRetries: 5, ...options.taskTimings } },
		contexts: { timings: { reconcileMs: 400, ...options.contextTimings } },
		shared: { timings: { mirrorFlushMs: 40, checkpointDebounceMs: 150, retryMs: 150, reconcileMs: 1_000, idleTimeoutMs: 20_000, transferTimeoutMs: 20_000, transferAcceptTimeoutMs: 20_000, transferStopTimeoutMs: 10_000, transferPollMs: 50, downloadIdleMs: 5_000, ...options.sharedTimings } },
		terminal: options.terminal,
		preview: options.preview,
		handoffs: { ...(options.handoffTimings && { timings: options.handoffTimings }), ...(options.handoffFault && { fault: options.handoffFault }) },
	});
	const net = ctx.network;
	const app = await buildApp(ctx);
	await app.listen({ host: "127.0.0.1", port: 0 });
	const port = (app.server.address() as { port: number }).port;
	config.port = port;
	if (options.network) await net.listen();
	const tasksRunning = options.tasks ?? options.network !== undefined;
	if (tasksRunning) await ctx.tasks.start();

	return {
		ctx,
		app,
		url: `http://127.0.0.1:${port}`,
		port,
		dataDir,
		projectDir,
		fakeLog,
		net,
		netUrl: `http://127.0.0.1:${config.networkPort}`,
		netPort: config.networkPort,
		async cleanup(cleanupOptions = {}) {
			ctx.terminals.stop();
			await ctx.browser.stop();
			await app.close();
			if (tasksRunning) await ctx.tasks.stop();
			await net.close();
			github.dispose();
			await git.dispose();
			rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
			await runtime.shutdown();
			await ctx.ompControl.shutdown();
			db.$client.close();
			// Background refreshes (usage cache) may still be writing into the directory for a moment.
			if (!cleanupOptions.keepData) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		},
	};
}

/** JSON helper over `fetch` against the local API. */
export function api(harness: Pick<FullHarness, "url">) {
	const call = async <T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
		const res = await fetch(`${harness.url}/api/local${path}`, {
			method,
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
	};
	return {
		get: <T = unknown>(path: string) => call<T>("GET", path),
		post: <T = unknown>(path: string, body?: unknown) => call<T>("POST", path, body ?? {}),
		patch: <T = unknown>(path: string, body: unknown) => call<T>("PATCH", path, body),
		put: <T = unknown>(path: string, body: unknown) => call<T>("PUT", path, body),
		del: <T = unknown>(path: string) => call<T>("DELETE", path),
	};
}

export interface WsClient {
	frames: Array<Record<string, any>>;
	send(message: unknown): void;
	waitFor(predicate: (frame: Record<string, any>) => boolean, what: string, timeoutMs?: number): Promise<Record<string, any>>;
	close(): void;
}

/** Minimal client over Node's global WebSocket. */
export function connectWs(harness: Pick<FullHarness, "port">): Promise<WsClient> {
	const { promise, resolve, reject } = Promise.withResolvers<WsClient>();
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
	const frames: Array<Record<string, any>> = [];
	const waiters = new Set<() => void>();
	ws.onmessage = (message) => {
		frames.push(JSON.parse(String(message.data)));
		for (const wake of [...waiters]) wake();
	};
	ws.onerror = () => reject(new Error("websocket error"));
	ws.onopen = () =>
		resolve({
			frames,
			send: (message) => ws.send(JSON.stringify(message)),
			async waitFor(predicate, what, timeoutMs = 8000) {
				const deadline = Date.now() + timeoutMs;
				for (;;) {
					const found = frames.find(predicate);
					if (found) return found;
					if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; got ${JSON.stringify(frames.map((f) => f.type + (f.event?.type ? `:${f.event.type}` : "")))}`);
					const { promise: tick, resolve: wake } = Promise.withResolvers<void>();
					waiters.add(wake);
					setTimeout(wake, 50);
					await tick;
					waiters.delete(wake);
				}
			},
			close: () => ws.close(),
		});
	return promise;
}
