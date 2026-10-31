import { AgentRuntimeError, type HostToolCall, type HostToolProvider, type HostToolResult, type RuntimeLogger } from "../types.ts";
import { isRecord } from "./frames.ts";

/**
 * Host-tool side of the OMP RPC protocol (`set_host_tools`, `host_tool_call` / `host_tool_cancel` in,
 * `host_tool_update` / `host_tool_result` out). Pure of process management: the session runtime feeds it the
 * frames of one process and gives it a way to write back.
 */

/** Longest result/update text sent to OMP. Inbound RPC lines are capped at 1 MiB, JSON escaping can multiply the size by 6. */
export const MAX_HOST_TOOL_TEXT_CHARS = 100_000;

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Wire shape of one entry of `set_host_tools`. */
export interface WireHostToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	loadMode?: "essential" | "discoverable";
}

/**
 * Checks what OMP would otherwise reject piecemeal (and what the model providers would reject on the first request):
 * names are unique and well formed, descriptions are present, parameters is a JSON Schema object. Clashes with
 * built-in tools are only known to OMP; its response error is surfaced instead.
 */
export function validateHostToolDefinitions(definitions: unknown): WireHostToolDefinition[] {
	if (!Array.isArray(definitions)) {
		throw new AgentRuntimeError("invalid_argument", "Host tool definitions must be an array");
	}
	const seen = new Set<string>();
	const wire: WireHostToolDefinition[] = [];
	definitions.forEach((entry: unknown, index) => {
		if (!isRecord(entry)) throw new AgentRuntimeError("invalid_argument", `Host tool at index ${index} must be an object`);
		const name = typeof entry.name === "string" ? entry.name : "";
		if (!TOOL_NAME_PATTERN.test(name)) {
			throw new AgentRuntimeError("invalid_argument", `Host tool at index ${index} has an invalid name ${JSON.stringify(entry.name)}: use 1-64 letters, digits, "_" or "-"`);
		}
		if (seen.has(name)) throw new AgentRuntimeError("invalid_argument", `Host tool name "${name}" is defined more than once`);
		seen.add(name);
		const description = typeof entry.description === "string" ? entry.description.trim() : "";
		if (!description) throw new AgentRuntimeError("invalid_argument", `Host tool "${name}" needs a non-empty description`);
		if (!isRecord(entry.parameters)) throw new AgentRuntimeError("invalid_argument", `Host tool "${name}" needs a JSON Schema object as parameters`);
		const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : name;
		const loadMode = entry.loadMode;
		if (loadMode !== undefined && loadMode !== "essential" && loadMode !== "discoverable") {
			throw new AgentRuntimeError("invalid_argument", `Host tool "${name}" has an invalid loadMode`);
		}
		wire.push({ name, label, description, parameters: entry.parameters, ...(loadMode ? { loadMode } : {}) });
	});
	return wire;
}

export interface HostToolDispatcherOptions {
	sessionId: string;
	/** Resolved per call so a provider swap applies to calls already on their way. */
	provider: () => HostToolProvider | null;
	/** Writes one frame to the process; throws when it is no longer writable. */
	send: (frame: Record<string, unknown>) => void;
	log: RuntimeLogger;
}

interface PendingCall {
	toolName: string;
	controller: AbortController;
}

function clip(text: string): string {
	return text.length > MAX_HOST_TOOL_TEXT_CHARS ? `${text.slice(0, MAX_HOST_TOOL_TEXT_CHARS)}\n…[${text.length - MAX_HOST_TOOL_TEXT_CHARS} characters cut]` : text;
}

function errorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.trim() ? message : "Host tool failed";
}

/**
 * The calls of ONE OMP process. Every `host_tool_call` is answered exactly once unless the process cannot hear it
 * any more: cancelled calls are dropped silently (OMP already settled them), calls in flight at exit/stop are aborted.
 */
export class HostToolDispatcher {
	readonly #options: HostToolDispatcherOptions;
	readonly #pending = new Map<string, PendingCall>();
	#registered = new Set<string>();

	constructor(options: HostToolDispatcherOptions) {
		this.#options = options;
	}

	/** Calls currently executing. */
	get inFlight(): number {
		return this.#pending.size;
	}

	/** Names OMP acknowledged in its latest `set_host_tools` response; anything else is an unknown tool. */
	setRegistered(names: Iterable<string>): void {
		this.#registered = new Set(names);
	}

	registeredNames(): string[] {
		return [...this.#registered];
	}

	handleFrame(frame: { type: string } & Record<string, unknown>): boolean {
		if (frame.type === "host_tool_call") {
			this.#handleCall(frame);
			return true;
		}
		if (frame.type === "host_tool_cancel") {
			this.#handleCancel(frame);
			return true;
		}
		return false;
	}

	/** The process is gone or going: nothing can be answered any more. */
	abortAll(reason: string): void {
		const calls = [...this.#pending.values()];
		this.#pending.clear();
		for (const call of calls) call.controller.abort(new AgentRuntimeError("process_exited", reason));
	}

	#handleCall(frame: Record<string, unknown>): void {
		const id = frame.id;
		if (typeof id !== "string" || id.length === 0) {
			this.#options.log.warn({ sessionId: this.#options.sessionId }, "host_tool_call without an id cannot be answered; dropped");
			return;
		}
		if (this.#pending.has(id)) {
			this.#options.log.warn({ sessionId: this.#options.sessionId, id }, "duplicate host_tool_call id ignored");
			return;
		}
		const toolName = frame.toolName;
		if (typeof toolName !== "string" || typeof frame.toolCallId !== "string") {
			this.#reply(id, "Malformed host tool call: toolName and toolCallId are required", true);
			return;
		}
		const provider = this.#options.provider();
		if (!provider) {
			this.#reply(id, `Host tool "${toolName}" is unavailable: no host tool provider is configured`, true);
			return;
		}
		if (!this.#registered.has(toolName)) {
			this.#reply(id, `Host tool "${toolName}" is not registered`, true);
			return;
		}

		// Registered synchronously: a cancel that follows this frame on the wire must find the call.
		const controller = new AbortController();
		const pending: PendingCall = { toolName, controller };
		this.#pending.set(id, pending);
		const call: HostToolCall = {
			sessionId: this.#options.sessionId,
			toolCallId: frame.toolCallId,
			toolName,
			arguments: frame.arguments ?? {},
			signal: controller.signal,
			update: (text) => {
				if (controller.signal.aborted || this.#pending.get(id) !== pending || typeof text !== "string") return;
				this.#write({ type: "host_tool_update", id, partialResult: { content: [{ type: "text", text: clip(text) }] } });
			},
		};
		let running: Promise<HostToolResult>;
		try {
			running = Promise.resolve(provider.execute(call));
		} catch (error) {
			running = Promise.reject(error);
		}
		running.then(
			(result) => this.#finish(id, pending, result, false),
			(error: unknown) => this.#finish(id, pending, { text: errorText(error), isError: true }, true),
		);
	}

	#finish(id: string, pending: PendingCall, result: HostToolResult, thrown: boolean): void {
		const live = this.#pending.get(id) === pending;
		if (live) this.#pending.delete(id);
		if (pending.controller.signal.aborted || !live) {
			// Cancelled by the agent, or the process is gone: OMP already settled this call.
			this.#options.log.debug({ sessionId: this.#options.sessionId, id, tool: pending.toolName }, "dropping the outcome of an aborted host tool call");
			return;
		}
		if (thrown) this.#options.log.warn({ sessionId: this.#options.sessionId, id, tool: pending.toolName, error: result.text }, "host tool threw");
		if (!isRecord(result) || typeof result.text !== "string") {
			this.#reply(id, `Host tool "${pending.toolName}" returned an invalid result`, true);
			return;
		}
		this.#reply(id, result.text.length > 0 ? result.text : "(no output)", result.isError === true);
	}

	#handleCancel(frame: Record<string, unknown>): void {
		const targetId = frame.targetId;
		if (typeof targetId !== "string") return;
		const pending = this.#pending.get(targetId);
		if (!pending) return; // finished already, or never ours
		this.#pending.delete(targetId);
		pending.controller.abort();
	}

	#reply(id: string, text: string, isError: boolean): void {
		this.#write({
			type: "host_tool_result",
			id,
			result: { content: [{ type: "text", text: clip(text) }], details: {} },
			...(isError ? { isError: true } : {}),
		});
	}

	#write(frame: Record<string, unknown>): void {
		try {
			this.#options.send(frame);
		} catch (error) {
			this.#options.log.debug({ sessionId: this.#options.sessionId, type: frame.type, err: error instanceof Error ? error.message : String(error) }, "host tool frame not delivered");
		}
	}
}
