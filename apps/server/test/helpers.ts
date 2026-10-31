import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@clam/agent-runtime";
import { LOCAL_API_PREFIX } from "@clam/contracts";
import { node, openDatabase } from "@clam/database";
import { createGitEngine } from "@clam/git-engine";
import { createGithubService } from "@clam/github-integration";
import { loadOrCreateIdentity } from "@clam/node-identity";
import fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { createEventBus } from "../src/bus.ts";
import type { ServerContext } from "../src/context.ts";
import { installErrorHandler } from "../src/http/error-handler.ts";
import { installHostGuard } from "../src/http/host-guard.ts";
import { createNetwork } from "../src/network/index.ts";
import { createAutostartManager } from "../src/services/autostart.ts";
import { GitService } from "../src/services/git-service.ts";
import { HostToolRegistry } from "../src/services/host-tool-registry.ts";
import { SessionService } from "../src/services/session-service.ts";
import { TaskService } from "../src/tasks/service.ts";

export interface TestHarness {
	app: FastifyInstance;
	ctx: ServerContext;
	dataDir: string;
	/** Events published on the bus, in order. */
	published: Array<{ topic: string; event: unknown; seq: number }>;
	cleanup(): Promise<void>;
}

/** Runtime double that has no sessions; enough for routes that only need to stop runtimes. Tests may overwrite members. */
export function idleRuntime(): AgentRuntime & { stopped: string[] } {
	const stopped: string[] = [];
	return {
		kind: "omp",
		stopped,
		open: async () => {
			throw new Error("idleRuntime.open must not be called in this test");
		},
		get: () => undefined,
		list: () => [],
		stop: async (id) => {
			stopped.push(id);
		},
		restart: async () => {
			throw new Error("idleRuntime.restart must not be called in this test");
		},
		onEvent: () => () => {},
		onStatus: () => () => {},
		setHostToolProvider: () => {},
		refreshHostTools: async () => {},
		withReleased: async () => {
			throw new Error("idleRuntime.withReleased must not be called in this test");
		},
		updateOptions: () => {},
		shutdown: async () => {},
	};
}

function unusable(name: string): never {
	throw new Error(`${name} is not available in this test harness; override it via createTestHarness({ ctx })`);
}

/**
 * Build a real Fastify app (host guard + error handler) with a real temp SQLite database and node
 * identity, registering the given route plugins under `/api/local`. Everything not needed by route
 * code under test is replaced by a loud-failing placeholder so accidental use is obvious.
 */
export async function createTestHarness(options: {
	plugins: FastifyPluginAsync<{ ctx: ServerContext }>[];
	ctx?: Partial<ServerContext>;
}): Promise<TestHarness> {
	const dataDir = mkdtempSync(join(tmpdir(), "clam-server-test-"));
	const db = openDatabase({ file: join(dataDir, "clam.db") });
	const identity = loadOrCreateIdentity({ dataDir });
	db.insert(node).values({ id: identity.nodeId, name: "test-node", publicKey: identity.publicKey, fingerprint: identity.fingerprint }).run();

	const app = fastify({ logger: false });
	installHostGuard(app);
	installErrorHandler(app);

	const bus = createEventBus();
	const published: TestHarness["published"] = [];
	const innerPublish = bus.publish.bind(bus);
	let seq = 0;
	bus.publish = (topic, event) => {
		published.push({ topic, event, seq: ++seq });
		innerPublish(topic, event);
	};

	// Real git engine (a short runtime dir keeps the askpass socket path under the OS limit) and real GitHub service
	// without network: tests that need the GitHub API inject `ctx.github`.
	const runtimeDir = mkdtempSync(join(tmpdir(), "clam-run-"));
	const git = options.ctx?.git ?? (await createGitEngine({ runtimeDir }));
	const secrets = {
		backend: "encrypted-file" as const,
		location: join(dataDir, "secrets"),
		get: async () => null,
		set: async () => {},
		delete: async () => {},
	};
	const github =
		options.ctx?.github ??
		createGithubService({
			db,
			secrets,
			publish: (topic, event) => bus.publish(topic, event),
			fetch: (async () => {
				throw new Error("network access is disabled in the test harness");
			}) as typeof fetch,
		});
	const ctx: ServerContext = {
		config: { dataDir, host: "127.0.0.1", port: 0, networkHost: "127.0.0.1", networkPort: 0, allowLoopbackPeers: false, version: "0.0.0-test", webDistDir: null, ompBinary: null, ompProfile: null },
		db,
		secrets,
		git,
		github,
		bus,
		log: app.log,
		omp: { binaryPath: () => null, refresh: async () => null },
		identity,
		runtime: idleRuntime(),
		get ompCli() {
			return unusable("ompCli");
		},
		get ompControl() {
			return unusable("ompControl");
		},
		autostart: createAutostartManager({
			config: { dataDir, host: "127.0.0.1", port: 0, ompBinary: null },
			entry: join(dataDir, "missing-dist", "main.js"),
			ompBinary: () => null,
			home: join(dataDir, "home"),
			// Never run launchctl/systemctl/schtasks from tests.
			run: async () => ({ code: 0, stdout: "", stderr: "" }),
		}),
		startedAt: new Date(),
		...options.ctx,
	} as ServerContext;
	ctx.network ??= createNetwork(ctx);
	ctx.sessions ??= new SessionService(ctx);
	ctx.gitService ??= new GitService(ctx);
	ctx.hostTools ??= new HostToolRegistry();
	ctx.tasks ??= new TaskService(ctx);
	ctx.network.attachTasks(ctx.tasks);

	for (const plugin of options.plugins) await app.register(plugin, { prefix: LOCAL_API_PREFIX, ctx });
	await app.ready();

	return {
		app,
		ctx,
		dataDir,
		published,
		async cleanup() {
			await app.close();
			github.dispose();
			if (!options.ctx?.git) await git.dispose();
			db.$client.close();
			rmSync(runtimeDir, { recursive: true, force: true });
			// Background refreshes (usage cache) may still be writing into the directory for a moment.
			rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		},
	};
}
