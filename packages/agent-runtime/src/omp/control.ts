import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { LoginFlow, LoginProvider, ProviderAccount } from "@clam/contracts";
import { z } from "zod";
import { AgentRuntimeError, type RuntimeLogger } from "../types.ts";
import type { OmpControl } from "./api.ts";
import type { OmpFrame, OmpResponseFrame } from "./frames.ts";
import { OmpTransport, type TransportExit } from "./transport.ts";

export interface OmpControlOptions {
	binary: () => string | null;
	profile?: string | null;
	/** Working directory of the control process. Default: the user's home directory. */
	cwd?: string;
	log?: RuntimeLogger;
	/** Stop the control process after this long without activity or active flows. Default 300000. */
	idleStopMs?: number;
	/** How long finished flows stay queryable. Default 600000. */
	flowRetentionMs?: number;
	/** Extra environment for the control process (tests). */
	env?: Record<string, string | undefined>;
}

const DEFAULT_IDLE_STOP_MS = 300_000;
const DEFAULT_FLOW_RETENTION_MS = 600_000;
const QUERY_TIMEOUT_MS = 30_000;
/** `login` completes when the user finishes; it must not hit a request timeout. */
const LOGIN_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SECRET_PROMPT_MESSAGE = (providerId: string): string =>
	`${providerId} asks for a secret (API key / token), which CL Agent Mesh never handles. Run \`omp login ${providerId}\` in a terminal instead.`;

const ProvidersData = z.object({
	providers: z.array(
		z.object({ id: z.string(), name: z.string(), available: z.boolean().default(true), authenticated: z.boolean().default(false) }),
	),
});
const AccountsData = z.object({
	accounts: z.array(
		z.object({
			credentialId: z.number().int(),
			provider: z.string(),
			label: z.string(),
			detail: z.string().optional(),
			type: z.string(),
			active: z.boolean().optional(),
		}),
	),
});
const LogoutData = z.object({ remainingSource: z.string().nullish() });

interface FlowRecord {
	flow: LoginFlow;
	transport: OmpTransport | null;
	requestSent: boolean;
	evictTimer?: NodeJS.Timeout;
}

function isTerminal(state: LoginFlow["state"]): boolean {
	return state === "success" || state === "error" || state === "cancelled";
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createOmpControl(options: OmpControlOptions): OmpControl {
	const log = options.log;
	const idleStopMs = options.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
	const retentionMs = options.flowRetentionMs ?? DEFAULT_FLOW_RETENTION_MS;
	const profile = options.profile?.trim() || null;

	let transport: OmpTransport | null = null;
	let starting: Promise<OmpTransport> | null = null;
	let idleTimer: NodeJS.Timeout | undefined;
	let closed = false;
	const flows = new Map<string, FlowRecord>();
	const listeners = new Set<(flow: LoginFlow) => void>();

	function activeRecords(): FlowRecord[] {
		return [...flows.values()].filter((record) => !isTerminal(record.flow.state));
	}

	function notify(record: FlowRecord): void {
		const snapshot = { ...record.flow, ...(record.flow.prompt ? { prompt: { ...record.flow.prompt } } : {}) };
		for (const listener of [...listeners]) {
			try {
				listener(snapshot);
			} catch (error) {
				log?.warn({ err: String(error) }, "omp login flow listener failed");
			}
		}
	}

	function update(record: FlowRecord, patch: Partial<LoginFlow>, clear: Array<keyof LoginFlow> = []): void {
		if (isTerminal(record.flow.state)) return;
		const next: LoginFlow = { ...record.flow, ...patch, updatedAt: new Date().toISOString() };
		for (const key of clear) delete next[key];
		record.flow = next;
		if (isTerminal(next.state)) {
			record.evictTimer = setTimeout(() => flows.delete(next.flowId), retentionMs);
			record.evictTimer.unref();
		}
		notify(record);
		armIdleTimer();
	}

	function fail(record: FlowRecord, message: string): void {
		update(record, { state: "error", error: message }, ["prompt"]);
	}

	function armIdleTimer(): void {
		clearTimeout(idleTimer);
		idleTimer = undefined;
		if (!transport || closed) return;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			if (activeRecords().length > 0) {
				armIdleTimer();
				return;
			}
			const current = transport;
			transport = null;
			if (current) {
				log?.debug({}, "omp control idle; stopping");
				void current.close().catch(() => undefined);
			}
		}, idleStopMs);
		idleTimer.unref();
	}

	function handleFrame(source: OmpTransport, frame: OmpFrame | OmpResponseFrame): void {
		if (frame.type !== "extension_ui_request") return;
		const request = frame as OmpFrame;
		const record = activeRecords().find((r) => r.transport === source);
		const requestId = str(request.id);
		if (!record || !requestId) return;
		switch (request.method) {
			case "open_url": {
				const url = str(request.url);
				if (!url) return;
				const instructions = str(request.instructions);
				update(record, { state: "awaiting_browser", url, ...(instructions ? { instructions } : {}) }, ["prompt"]);
				return;
			}
			case "input": {
				if (request.secret === true) {
					respondCancelled(source, requestId);
					fail(record, SECRET_PROMPT_MESSAGE(record.flow.providerId));
					abandonProcess(source);
					return;
				}
				const placeholder = str(request.placeholder);
				update(record, {
					state: "awaiting_input",
					prompt: { requestId, message: str(request.title) ?? str(request.message) ?? "Input required", ...(placeholder ? { placeholder } : {}) },
				});
				return;
			}
			case "select":
			case "confirm":
			case "editor":
			case "ask":
				// Not part of any login flow we support; never leave OMP waiting on a dialog nobody sees.
				respondCancelled(source, requestId);
				return;
			default:
				return;
		}
	}

	function respondCancelled(source: OmpTransport, requestId: string): void {
		try {
			source.send({ type: "extension_ui_response", id: requestId, cancelled: true });
		} catch (error) {
			log?.debug({ err: String(error) }, "omp control: could not answer prompt");
		}
	}

	/** Kill the process (a login cannot be aborted over RPC) so nothing completes in the background. */
	function abandonProcess(source: OmpTransport): void {
		if (transport === source) transport = null;
		armIdleTimer();
		source.kill();
	}

	function handleExit(source: OmpTransport, exit: TransportExit): void {
		if (transport === source) transport = null;
		armIdleTimer();
		if (exit.expected) return;
		const detail = exit.stderrTail.trim().split("\n").slice(-3).join(" ").slice(0, 300);
		for (const record of activeRecords()) {
			if (record.transport === source) {
				fail(record, `The OMP control process exited unexpectedly${detail ? `: ${detail}` : ""}`);
			}
		}
	}

	async function ensureTransport(): Promise<OmpTransport> {
		if (closed) throw new AgentRuntimeError("invalid_state", "OMP control is shut down");
		if (transport && transport.state === "ready") {
			armIdleTimer();
			return transport;
		}
		if (starting) return starting;
		const binary = options.binary();
		if (!binary) throw new AgentRuntimeError("not_installed", "omp not found: install oh-my-pi or set its path in settings");
		const created = new OmpTransport({
			command: binary,
			args: [...(profile ? ["--profile", profile] : []), "--mode", "rpc", "--no-ui", "--no-session", "--cwd", options.cwd ?? homedir()],
			cwd: options.cwd ?? homedir(),
			...(options.env ? { env: options.env } : {}),
			...(log ? { log } : {}),
		});
		created.onFrame((frame) => handleFrame(created, frame));
		created.onExit((exit) => handleExit(created, exit));
		const pending = (async () => {
			try {
				await created.start();
			} catch (error) {
				created.kill();
				if (error instanceof AgentRuntimeError) throw error;
				throw new AgentRuntimeError("start_failed", `Could not start omp: ${String(error)}`);
			}
			if (closed) {
				created.kill();
				throw new AgentRuntimeError("invalid_state", "OMP control is shut down");
			}
			transport = created;
			armIdleTimer();
			return created;
		})();
		starting = pending;
		try {
			return await pending;
		} finally {
			if (starting === pending) starting = null;
		}
	}

	async function query<T>(type: string, payload: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
		const t = await ensureTransport();
		try {
			const data = await t.request(type, payload, { timeoutMs: QUERY_TIMEOUT_MS });
			const parsed = schema.safeParse(data);
			if (!parsed.success) {
				throw new AgentRuntimeError("protocol", `Unexpected \`${type}\` response from omp`, { issues: parsed.error.issues });
			}
			return parsed.data;
		} finally {
			armIdleTimer();
		}
	}

	async function runLogin(record: FlowRecord): Promise<void> {
		try {
			const t = await ensureTransport();
			if (isTerminal(record.flow.state)) return; // cancelled while starting
			record.transport = t;
			record.requestSent = true;
			await t.request("login", { providerId: record.flow.providerId }, { timeoutMs: LOGIN_REQUEST_TIMEOUT_MS });
			update(record, { state: "success" }, ["prompt", "error"]);
		} catch (error) {
			fail(record, error instanceof Error ? error.message : String(error));
		}
	}

	function cancelRecord(record: FlowRecord): void {
		if (isTerminal(record.flow.state)) return;
		const source = record.transport;
		const pendingPrompt = record.flow.prompt;
		update(record, { state: "cancelled" }, ["prompt"]);
		if (source && record.requestSent) {
			if (pendingPrompt) respondCancelled(source, pendingPrompt.requestId);
			// The RPC has no abort for `login`; restarting the process guarantees it cannot finish in the background.
			abandonProcess(source);
		}
	}

	return {
		async providers(): Promise<LoginProvider[]> {
			const data = await query("get_login_providers", {}, ProvidersData);
			return data.providers;
		},

		async accounts(providerId): Promise<ProviderAccount[]> {
			const data = await query("get_logout_accounts", { providerId }, AccountsData);
			return data.accounts.map((a) => ({
				credentialId: a.credentialId,
				provider: a.provider,
				label: a.label,
				type: a.type,
				...(a.detail !== undefined ? { detail: a.detail } : {}),
				...(a.active !== undefined ? { active: a.active } : {}),
			}));
		},

		startLogin(providerId): LoginFlow {
			if (closed) throw new AgentRuntimeError("invalid_state", "OMP control is shut down");
			// Frames carry no provider id, so at most one login runs at a time: a new flow supersedes any active one.
			for (const other of activeRecords()) cancelRecord(other);
			const record: FlowRecord = {
				flow: { flowId: randomUUID(), providerId, state: "starting", updatedAt: new Date().toISOString() },
				transport: null,
				requestSent: false,
			};
			flows.set(record.flow.flowId, record);
			const initial = { ...record.flow };
			void runLogin(record);
			notify(record);
			return initial;
		},

		submitLoginInput(flowId, input): LoginFlow {
			const record = flows.get(flowId);
			if (!record) throw new AgentRuntimeError("invalid_state", `Unknown login flow ${flowId}`);
			const pending = record.flow.prompt;
			if (isTerminal(record.flow.state) || !pending || pending.requestId !== input.requestId || !record.transport) {
				throw new AgentRuntimeError("invalid_state", "No pending prompt with that requestId", { requestId: input.requestId });
			}
			record.transport.send({ type: "extension_ui_response", id: input.requestId, value: input.value });
			update(record, { state: record.flow.url ? "awaiting_browser" : "starting" }, ["prompt"]);
			return { ...record.flow };
		},

		cancelLogin(flowId): LoginFlow {
			const record = flows.get(flowId);
			if (!record) throw new AgentRuntimeError("invalid_state", `Unknown login flow ${flowId}`);
			cancelRecord(record);
			return { ...record.flow };
		},

		getFlow(flowId): LoginFlow | undefined {
			const record = flows.get(flowId);
			return record ? { ...record.flow } : undefined;
		},

		onFlow(listener): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		async logout(providerId, credentialId): Promise<{ remainingSource: string | null }> {
			const data = await query("logout", { providerId, credentialId }, LogoutData);
			return { remainingSource: data.remainingSource ?? null };
		},

		async shutdown(): Promise<void> {
			closed = true;
			clearTimeout(idleTimer);
			idleTimer = undefined;
			for (const record of flows.values()) {
				cancelRecord(record);
				clearTimeout(record.evictTimer);
			}
			flows.clear();
			const pending = starting;
			const current = transport;
			transport = null;
			if (current) await current.close().catch(() => undefined);
			if (pending) await pending.catch(() => undefined);
		},
	};
}
