import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createOmpCli, createOmpControl, createOmpRuntime } from "@clam/agent-runtime/omp";
import { openDatabase } from "@clam/database";
import { createGitEngine } from "@clam/git-engine";
import { createGithubService } from "@clam/github-integration";
import { loadOrCreateIdentity } from "@clam/node-identity";
import { createSecretStore } from "@clam/secret-store";
import pino from "pino";
import { assembleContext } from "./assemble.ts";
import { buildApp } from "./app.ts";
import { createEventBus } from "./bus.ts";
import { loadConfig, serverEntryPath } from "./config.ts";
import type { ServerContext } from "./context.ts";
import { createOmpLocator } from "./omp-locator.ts";
import { createAutostartManager } from "./services/autostart.ts";
import { ensureDefaultAgent, ensureNodeRow } from "./services/bootstrap.ts";
import { readNodeSettings, toSupervisorSettings } from "./services/settings.ts";

const SHUTDOWN_DEADLINE_MS = 20_000;

/**
 * A restart starts the new process while the old one is still shutting down: it frees the UI port first and the network port
 * only after its tasks, tunnel and runtimes stop. Wait out a busy port for as long as that shutdown may take instead of exiting.
 */
async function whilePortBusy<T>(attempt: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + SHUTDOWN_DEADLINE_MS;
	for (;;) {
		try {
			return await attempt();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || Date.now() >= deadline) throw error;
			await sleep(250);
		}
	}
}

function createLogger() {
	const level = process.env.CLAM_LOG_LEVEL ?? "info";
	const pretty = process.env.CLAM_LOG_PRETTY ? process.env.CLAM_LOG_PRETTY === "1" : process.env.npm_lifecycle_event === "dev";
	return pino({
		level,
		redact: { paths: ["*.token", "*.secret", "*.password", "req.headers.authorization"], censor: "[redacted]" },
		...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } } } : {}),
	});
}

/** Settings from this process's environment that a login-started server must see too (host, port, data dir and omp are handled by the manager). */
function carriedEnv(webDistDir: string | null): Record<string, string> {
	const carried: Record<string, string> = {};
	for (const name of ["CLAM_OMP_PROFILE", "CLAM_LOG_LEVEL", "CLAM_SECRET_BACKEND", "CLAM_NETWORK_HOST", "CLAM_NETWORK_PORT", "CLAM_ALLOW_LOOPBACK_PEERS", "CLAM_CLOUDFLARED_BIN"]) {
		const value = process.env[name]?.trim();
		if (value) carried[name] = value;
	}
	// Resolved already: a relative CLAM_WEB_DIST would mean something else at login.
	if (process.env.CLAM_WEB_DIST?.trim() && webDistDir) carried.CLAM_WEB_DIST = webDistDir;
	return carried;
}

async function main(): Promise<void> {
	const config = loadConfig();
	mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
	const log = createLogger();

	const db = openDatabase({ file: join(config.dataDir, "clam.db") });
	const identity = loadOrCreateIdentity({ dataDir: config.dataDir });
	// OS stores are machine-wide: namespace by node so several nodes on one machine never read each other's secrets.
	const secrets = await createSecretStore({ dataDir: config.dataDir, service: `cl-agent-mesh.${identity.nodeId}` });
	const omp = await createOmpLocator(config.ompBinary);
	const settings = readNodeSettings(db);

	ensureNodeRow(db, identity, settings.nodeName);
	if (ensureDefaultAgent(db, identity.nodeId)) log.info("registered the default OMP agent");

	const bus = createEventBus();
	const binary = () => omp.binaryPath();
	const runtime = createOmpRuntime({ binary, profile: config.ompProfile, settings: toSupervisorSettings(settings), log });
	const ompCli = createOmpCli({ binary, profile: config.ompProfile, log });
	const ompControl = createOmpControl({ binary, profile: config.ompProfile, cwd: config.dataDir, log });

	const autostart = createAutostartManager({ config, entry: serverEntryPath(), ompBinary: binary, extraEnv: carriedEnv(config.webDistDir) });
	// Private (0700) directory for the git askpass helper and its socket: the only place a token ever travels, in memory.
	const runtimeDir = join(config.dataDir, "run");
	mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	chmodSync(runtimeDir, 0o700);
	const git = await createGitEngine({ runtimeDir, log });
	log.info({ git: await git.version() }, "git engine ready");
	const github = createGithubService({ db, secrets, publish: (topic, event) => bus.publish(topic, event) });

	const base = { config, db, secrets, bus, log, omp, identity, runtime, ompCli, ompControl, git, github, autostart, startedAt: new Date() };
	const ctx: ServerContext = assembleContext(base, { cloudflaredBinary: process.env.CLAM_CLOUDFLARED_BIN?.trim() || undefined });
	const { network } = ctx;
	const app = await buildApp(ctx);

	let shuttingDown = false;
	const shutdown = async (reason: string, exitCode: number): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info({ reason }, "shutting down");
		const deadline = setTimeout(() => {
			log.error("graceful shutdown timed out; forcing exit");
			process.exit(1);
		}, SHUTDOWN_DEADLINE_MS);
		deadline.unref();
		try {
			ctx.terminals.stop();
			await ctx.browser.stop();
			await app.close();
			await ctx.tasks.stop();
			await network.close();
			github.dispose();
			await git.dispose();
			await runtime.shutdown();
			await ompControl.shutdown();
			db.$client.close();
		} catch (error) {
			log.error({ err: error }, "error during shutdown");
			exitCode = 1;
		}
		log.flush?.();
		process.exit(exitCode);
	};
	process.on("SIGINT", () => void shutdown("SIGINT", 0));
	process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
	process.on("SIGHUP", () => void shutdown("SIGHUP", 0));
	process.on("unhandledRejection", (reason) => log.error({ err: reason }, "unhandled promise rejection"));
	process.on("uncaughtException", (error) => {
		log.fatal({ err: error }, "uncaught exception");
		void shutdown("uncaughtException", 1);
	});

	try {
		await app.listen({ host: config.host, port: config.port });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
			log.fatal(`Port ${config.port} on ${config.host} is already in use. Set CLAM_PORT to use another one.`);
			await shutdown("EADDRINUSE", 1);
			return;
		}
		throw error;
	}
	config.port = (app.server.address() as { port: number }).port; // the real port when CLAM_PORT=0
	try {
		await whilePortBusy(() => network.listen());
	} catch (error) {
		log.fatal(error instanceof Error ? error.message : String(error));
		await shutdown("network listener failed", 1);
		return;
	}
	await ctx.tasks.start();
	const url = `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}`;
	log.info(
		{ url, networkUrl: `http://${config.networkHost.includes(":") ? `[${config.networkHost}]` : config.networkHost}:${config.networkPort}`, dataDir: config.dataDir, node: identity.nodeId, omp: omp.binaryPath(), ompProfile: config.ompProfile, web: config.webDistDir ?? "not built (use the Vite dev server)" },
		`CL Agent Mesh ${config.version} listening on ${url}`,
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
