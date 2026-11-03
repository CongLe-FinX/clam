import type {
	LoginFlow,
	LoginProvider,
	ModelInfo,
	ModelRoles,
	ModelTestResult,
	OmpInstall,
	ProviderAccount,
} from "@clam/contracts";

/**
 * OMP surfaces that are not tied to a CLAM session: binary detection, `omp models/config` CLI
 * helpers, and the long-lived control RPC process used for login/logout. These are the *only*
 * supported ways CL Agent Mesh touches OMP configuration and credentials (never OMP's internal
 * databases or credential store). Implementations: `createOmpCli` (cli.ts), `createOmpControl` (control.ts).
 */

export interface OmpCli {
	/** Binary path + `omp --version` + `omp config path`. Never throws: `installed:false` + `error` instead. */
	detect(): Promise<OmpInstall>;
	/** `omp models --json`, cached; concurrent callers share one in-flight call. `refresh` bypasses the cache. */
	models(options?: { refresh?: boolean }): Promise<ModelInfo[]>;
	/** `omp config get modelRoles --json`. */
	modelRoles(): Promise<ModelRoles>;
	/** Set (or clear with `null`) one role via the supported `omp config set` syntax, then return the updated roles. */
	setModelRole(role: string, selector: string | null): Promise<ModelRoles>;
	/** Minimal, non-persisted print-mode call to `selector`; never throws (failure is `ok:false`). */
	testModel(selector: string, options?: { timeoutMs?: number }): Promise<ModelTestResult>;
	/** Drop cached results (call after login/logout/config changes). */
	invalidate(): void;
	/**
	 * `omp session pack <sessionFile> <outPath>`: snapshot a session (journal, artifacts, blobs) into a tar archive.
	 * `sessionFile` must exist (`invalid_argument` otherwise). Rejects with `session_locked` while another live omp
	 * process owns the session (stop its runtime first, e.g. via `AgentRuntime.withReleased`), `invalid_archive` for
	 * archive/session problems, `timeout` (default 120 s), `start_failed`, or `rejected` with omp's error text.
	 * Paths must be non-empty and must not start with `-` (omp has no `--` separator): `invalid_argument`.
	 */
	sessionPack(sessionFile: string, outPath: string, options?: { timeoutMs?: number }): Promise<{ archivePath: string }>;
	/**
	 * `omp session unpack <archivePath> --cwd <cwd>`: create a new local session from an archive in OMP's default
	 * session directory for `cwd`. `sessionFile` is the absolute `.jsonl` path omp printed (anything else is a
	 * `protocol` error); `mode` is parsed best-effort from omp's stderr note. A missing/garbled archive is
	 * `invalid_archive`. Default timeout 120 s. Move the file into a CLAM session dir with `placeSessionFile`.
	 */
	sessionUnpack(
		archivePath: string,
		cwd: string,
		options?: { timeoutMs?: number },
	): Promise<{ sessionFile: string; mode: "created" | "replaced" | "forked" | "unknown" }>;
	/**
	 * `omp session moved <sessionFile> --to <to>`: mark the local copy of a session as stale (departed to `to`).
	 * `session_locked` while a live omp process writes the session; `invalid_argument` if the file is missing or a
	 * value is empty / starts with `-`. Default timeout 30 s.
	 */
	sessionMoved(sessionFile: string, to: string, options?: { timeoutMs?: number }): Promise<void>;
	/**
	 * `omp update --check`: the installed version and the newest one on omp's update channel. `latest` is null when omp printed neither
	 * an offer nor "up to date". Rejects (`rejected`) when the check itself failed (offline, registry down) and `timeout` after 60 s.
	 */
	checkUpdate(): Promise<{ current: string | null; latest: string | null; available: boolean }>;
	/**
	 * `omp update`: install the newest version (omp picks the install method: bun, npm, Homebrew, binary, …). Resolves with the version
	 * omp reports it updated to (null when it was already up to date) and its output; rejects with omp's error text. Default timeout 5 min.
	 * Running omp processes keep the version they started with.
	 */
	update(options?: { timeoutMs?: number }): Promise<{ version: string | null; output: string }>;
}

export interface OmpControl {
	/** RPC `get_login_providers`. */
	providers(): Promise<LoginProvider[]>;
	/** RPC `get_logout_accounts`. */
	accounts(providerId: string): Promise<ProviderAccount[]>;
	/**
	 * Start an OAuth/API login through OMP's own flow (RPC `login`). Returns immediately with the flow
	 * in state `starting`; it advances through `awaiting_browser` / `awaiting_input` to a terminal
	 * state, each change delivered to `onFlow` listeners. Prompts marked `secret: true` are never
	 * handled: the flow ends in `error` directing the user to `omp login` in a terminal.
	 */
	startLogin(providerId: string): LoginFlow;
	/** Answer the flow's pending prompt. Rejects (AgentRuntimeError `invalid_state`) if `requestId` is not pending. */
	submitLoginInput(flowId: string, input: { requestId: string; value: string }): LoginFlow;
	/** Cancel a flow that is not terminal. Idempotent for terminal flows. */
	cancelLogin(flowId: string): LoginFlow;
	getFlow(flowId: string): LoginFlow | undefined;
	onFlow(listener: (flow: LoginFlow) => void): () => void;
	/** RPC `logout`. */
	logout(providerId: string, credentialId: number): Promise<{ remainingSource: string | null }>;
	/** Stop the control process unless a login flow is running, so the next call starts the current binary (after `omp update`). */
	release(): Promise<void>;
	/** Stop the control process (called at server shutdown). */
	shutdown(): Promise<void>;
}
