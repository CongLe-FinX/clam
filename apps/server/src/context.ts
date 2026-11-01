import type { AgentRuntime, OmpCli, OmpControl } from "@clam/agent-runtime";
import type { ClamDb } from "@clam/database";
import type { GitEngine } from "@clam/git-engine";
import type { GithubService } from "@clam/github-integration";
import type { NodeIdentity } from "@clam/node-identity";
import type { SecretStore } from "@clam/secret-store";
import type { FastifyBaseLogger } from "fastify";
import type { AccessService } from "./auth/service.ts";
import type { BrowserService } from "./browser/service.ts";
import type { ContextService } from "./context/service.ts";
import type { NetworkService } from "./network/types.ts";
import type { PreviewService } from "./preview/service.ts";
import type { AutostartManager } from "./services/autostart.ts";
import type { GitService } from "./services/git-service.ts";
import type { HostToolRegistry } from "./services/host-tool-registry.ts";
import type { SessionService } from "./services/session-service.ts";
import type { TerminalService } from "./terminal/service.ts";
import type { TurnOutputService } from "./services/turn-outputs.ts";
import type { TaskService } from "./tasks/service.ts";
import type { SharedService } from "./shared/service.ts";
import type { HandoffService } from "./handoff/service.ts";

export interface ServerConfig {
	dataDir: string;
	host: string;
	port: number;
	/** Loopback address of the `/api/v1` network listener (the tunnel's origin). */
	networkHost: string;
	/** Port of the network listener; the real port once it listens (`CLAM_NETWORK_PORT`, default UI port + 1). */
	networkPort: number;
	/** `CLAM_ALLOW_LOOPBACK_PEERS=1`: peers may live at `http://127.0.0.1|localhost|[::1]` (development and tests only). */
	allowLoopbackPeers: boolean;
	version: string;
	/** Directory of the built web app to serve statically; null in dev (Vite serves it). */
	webDistDir: string | null;
	/** Explicit omp executable (`CLAM_OMP_BIN`); null = auto-detect on PATH and well-known install dirs. */
	ompBinary: string | null;
	/** OMP profile passed as `--profile` to every omp invocation (`CLAM_OMP_PROFILE`); null = OMP's default profile. */
	ompProfile: string | null;
}

/** Topic-based fan-out to WebSocket subscribers. See `@clam/contracts` ws.ts for topics. */
export interface EventBus {
	publish(topic: string, event: unknown): void;
	subscribe(topic: string, listener: (event: unknown, seq: number) => void): () => void;
	/**
	 * Latest event of a *retained* topic (`node`, `login:*`, `github-device:*`: topics where only the
	 * current state matters), with its seq. The WebSocket hub replays it to late subscribers so a flow that
	 * advanced between "POST returned" and "client subscribed" is never missed.
	 */
	latest(topic: string): { event: unknown; seq: number } | undefined;
	/** True while at least one listener is subscribed to the topic. */
	hasSubscribers(topic: string): boolean;
	/**
	 * Reports demand for topics starting with `prefix`: `listener(topic, true)` when a topic gets its first subscriber
	 * (also immediately for topics that already have one), `listener(topic, false)` when it loses its last. Lets a
	 * producer (the git working-tree watcher) run only while someone is listening.
	 */
	watchDemand(prefix: string, listener: (topic: string, active: boolean) => void): () => void;
}

/** Path to the omp binary, resolved at boot; null when OMP is not installed. */
export interface OmpLocator {
	binaryPath(): string | null;
	refresh(): Promise<string | null>;
}

/**
 * Everything a route plugin needs. Route plugins are registered as
 * `app.register(plugin, { prefix: LOCAL_API_PREFIX, ctx })` and have the signature
 * `(app: FastifyInstance, opts: { ctx: ServerContext }) => Promise<void>`.
 */
export interface ServerContext {
	config: ServerConfig;
	db: ClamDb;
	secrets: SecretStore;
	bus: EventBus;
	log: FastifyBaseLogger;
	omp: OmpLocator;
	identity: NodeIdentity;
	/** Agent runtime supervisor (OMP). Route code only ever talks to the provider-agnostic interface. */
	runtime: AgentRuntime;
	/** `omp models/config` CLI helpers + binary detection. */
	ompCli: OmpCli;
	/** Control RPC process: provider login/logout. */
	ompControl: OmpControl;
	/** Real `git` CLI wrapper (clone/fetch/pull/push/commit/...); tokens reach it only through its askpass broker. */
	git: GitEngine;
	/** GitHub accounts + REST (repos, PRs). `tokenFor` is server-internal and must never reach an HTTP response or a log. */
	github: GithubService;
	/** Start-at-login (OS login entry) for this node. */
	autostart: AutostartManager;
	/** Agent network (M3): peers, pairing, tunnel, heartbeat, directory and the `/api/v1` listener. */
	network: NetworkService;
	/** Agent sessions (CRUD, prompts, runtime access); one instance shared by the routes and the task engine. */
	sessions: SessionService;
	/** Files each agent turn created or modified in its project folder (stored per turn, pushed as `turn_outputs`); started with the session service. */
	turnOutputs: TurnOutputService;
	/** Git operations on projects, serialized per project; one instance shared by the routes and the task engine. */
	gitService: GitService;
	/** Host tools of every OMP runtime, composed of per-feature sets (the task engine registers the `mesh_*` set). */
	hostTools: HostToolRegistry;
	/** Owner access to this node's UI through its domain: password, session cookie, login throttling (`auth/`). One instance serves both listeners. */
	access: AccessService;
	/** The machine's own terminals (real PTYs). Loopback UI always; through the domain only when switched on + step-up (`AccessService.assertTool`). Stopped with the server. */
	terminals: TerminalService;
	/** The machine's own browser: a headless Chromium on this machine streamed to the UI (`browser/`). Loopback UI always; through the domain only when switched on (`AccessService.assertTool`). Closed with the server. */
	browser: BrowserService;
	/** Preview: this machine's localhost apps in the owner's own browser via per-port subdomains of the named tunnel hostname (`preview/`). Needs `AccessService` (tickets/sessions) and the tunnel config. */
	preview: PreviewService;
	/** Task engine (M4): delegation, execution, discussion, outbox, mirror. */
	tasks: TaskService;
	/** Shared sessions (M5): driver/participants, mirror, shared thread, checkpoints, takeover. Starts and stops with the task engine. */
	shared: SharedService;
	/** Workspace/project context (M6): memory, plans, decisions; peer sync, `.clmesh/`, agent tools. Starts and stops with the task engine. */
	contexts: ContextService;
	/** Handoffs (M7): move an in-flight task to another node (manifest, restore, dependency setup, durable ack, fencing) and record shared-session hand-overs. Starts and stops with the task engine. */
	handoffs: HandoffService;
	startedAt: Date;
}

export interface RoutePluginOptions {
	ctx: ServerContext;
}
