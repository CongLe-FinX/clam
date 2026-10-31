import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./context.ts";

const DEFAULT_PORT = 4317;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** apps/server (source: `src/`, bundle: `dist/` are both one level below it). */
const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = resolve(SERVER_DIR, "..", "..");

/** The built server entry point (`pnpm build`); what an OS login entry runs. */
export function serverEntryPath(): string {
	return join(SERVER_DIR, "dist", "main.js");
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
	return value;
}

function readVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(join(SERVER_DIR, "package.json"), "utf8")) as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function parsePort(raw: string | undefined): number {
	if (raw === undefined || raw === "") return DEFAULT_PORT;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`CLAM_PORT must be an integer between 0 and 65535, got "${raw}"`);
	return port;
}

/** `CLAM_NETWORK_PORT`; unset = UI port + 1 (ephemeral when the UI port is, since the number cannot be derived). */
function parseNetworkPort(raw: string | undefined, uiPort: number): number {
	if (raw === undefined || raw === "") {
		if (uiPort === 0) return 0;
		if (uiPort >= 65535) throw new Error("CLAM_NETWORK_PORT must be set explicitly when CLAM_PORT is 65535");
		return uiPort + 1;
	}
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`CLAM_NETWORK_PORT must be an integer between 0 and 65535, got "${raw}"`);
	if (port !== 0 && port === uiPort) throw new Error("CLAM_NETWORK_PORT must differ from CLAM_PORT: the network listener serves only /api/v1 and the UI listener never does");
	return port;
}

function resolveWebDist(raw: string | undefined): string | null {
	const dir = raw ? resolve(expandHome(raw)) : resolve(REPO_ROOT, "apps", "web", "dist");
	if (existsSync(join(dir, "index.html"))) return dir;
	if (raw) throw new Error(`CLAM_WEB_DIST "${dir}" does not contain an index.html`);
	return null;
}

/**
 * Server configuration from the environment.
 *   CLAM_HOST (loopback only) · CLAM_PORT (4317) · CLAM_DATA_DIR (~/.clam; `pnpm dev` uses <repo>/.data/core)
 *   CLAM_WEB_DIST (apps/web/dist when built) · CLAM_OMP_BIN · CLAM_OMP_PROFILE
 *   CLAM_NETWORK_HOST (loopback only, default 127.0.0.1) · CLAM_NETWORK_PORT (default CLAM_PORT + 1): the listener the tunnel points at — `/api/v1`, plus the owner web UI behind its login once remote UI is enabled (see docs/security.md §5b)
 *   CLAM_ALLOW_LOOPBACK_PEERS=1 allows `http://127.0.0.1|localhost|[::1]` peer URLs (development/tests; insecure) and lets the network listener's own loopback origin count as its public origin for the remote-UI CSRF check, so the login can be driven without a tunnel
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
	const host = (env.CLAM_HOST?.trim() || "127.0.0.1").replace(/^\[|\]$/g, "");
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error(`CL Agent Mesh M1 only binds to loopback (127.0.0.1, ::1 or localhost); refusing CLAM_HOST="${host}"`);
	}
	const networkHost = (env.CLAM_NETWORK_HOST?.trim() || "127.0.0.1").replace(/^\[|\]$/g, "");
	if (!LOOPBACK_HOSTS.has(networkHost)) {
		throw new Error(`The network listener only binds to loopback (127.0.0.1, ::1 or localhost) and is exposed through the tunnel; refusing CLAM_NETWORK_HOST="${networkHost}"`);
	}
	const port = parsePort(env.CLAM_PORT?.trim());
	const devDataDir = env.npm_lifecycle_event === "dev" ? join(REPO_ROOT, ".data", "core") : null;
	const rawDataDir = env.CLAM_DATA_DIR?.trim() || devDataDir || join(homedir(), ".clam");
	const dataDir = isAbsolute(expandHome(rawDataDir)) ? resolve(expandHome(rawDataDir)) : resolve(process.cwd(), expandHome(rawDataDir));
	return {
		dataDir,
		host,
		port,
		networkHost,
		networkPort: parseNetworkPort(env.CLAM_NETWORK_PORT?.trim(), port),
		allowLoopbackPeers: env.CLAM_ALLOW_LOOPBACK_PEERS?.trim() === "1",
		version: readVersion(),
		webDistDir: resolveWebDist(env.CLAM_WEB_DIST?.trim()),
		ompBinary: env.CLAM_OMP_BIN?.trim() || null,
		ompProfile: env.CLAM_OMP_PROFILE?.trim() || null,
	};
}
