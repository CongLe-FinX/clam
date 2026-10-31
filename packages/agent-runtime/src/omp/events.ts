import type { MessagesPage, SessionEvent, TokenTotals, UiBlock, UiMessage } from "@clam/contracts";
import { isRecord, type OmpFrame } from "./frames.ts";
import { resultText, toAssistantBlock, toTokenTotals, toUiMessage } from "./messages.ts";

export interface MapResult {
	events: SessionEvent[];
	/** Caller should refetch get_state and publish a `state` event. */
	stateDirty: boolean;
}

export interface UsageDelta {
	provider: string;
	model: string;
	tokens: TokenTotals;
	cost: number;
}

type UiRequestEvent = Extract<SessionEvent, { type: "ui_request" }>;

interface OpenMessage {
	wireId: string | undefined;
	/** null = hidden (not displayable); its updates and end are swallowed. */
	msg: UiMessage | null;
	/** Block indexes filled in only to keep wire contentIndex == UI index. */
	placeholders: Set<number>;
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 256;
const PREVIEW_CAP = 4096;
const ENDED_CAP = 512;

/** Frames whose arrival changes a `get_state` field. */
const STATE_DIRTY_TYPES: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	turn_end: true,
	queue_update: true,
	session_settled: true,
	goal_updated: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	manual_compaction_start: true,
	manual_compaction_end: true,
	todo_reminder: true,
	todo_auto_clear: true,
	model_changed: true,
	thinking_level_changed: true,
	retry_fallback_applied: true,
	retry_fallback_succeeded: true,
	prompt_result: true,
};

const EMPTY: Readonly<MapResult> = { events: [], stateDirty: false };

function asLevel(value: unknown): "info" | "warning" | "error" {
	return value === "warning" || value === "error" ? value : "info";
}

function preview(text: string): string {
	return text.length > PREVIEW_CAP ? `…${text.slice(-PREVIEW_CAP)}` : text;
}

function encodeCursor(index: number): string {
	return Buffer.from(`u${index}`).toString("base64url");
}

function decodeCursor(cursor: string): number | null {
	const match = /^u(\d{1,9})$/.exec(Buffer.from(cursor, "base64url").toString());
	return match?.[1] === undefined ? null : Number(match[1]);
}

function blockPlaceholder(): UiBlock {
	return { type: "text", text: "" };
}

function cloneMessage(msg: UiMessage): UiMessage {
	return { ...msg, content: [...msg.content] };
}

interface PromptRecord {
	clientId: string;
	text: string;
	/** User message shown when the prompt was admitted, before OMP echoed it; the echo is folded into it. */
	synthetic?: UiMessage;
	/** OMP's echo arrived and was folded into `synthetic`: the prompt really ran. */
	echoed?: boolean;
}

export class OmpEventMapper {
	#transcript: UiMessage[] = [];
	#counter = 0;
	#open: OpenMessage[] = [];
	#ended = new Set<string>();
	#prompts = new Map<string, PromptRecord>();
	#echoQueue: string[] = [];
	#usage = new Map<string, UsageDelta>();
	#pendingUi = new Map<string, UiRequestEvent>();

	get messageCount(): number {
		return this.#transcript.length;
	}

	loadHistory(messages: unknown[]): void {
		for (const m of messages) {
			const ui = toUiMessage(m, `m${this.#counter + 1}`);
			if (!ui) continue;
			this.#counter++;
			this.#transcript.push(ui);
		}
	}

	reset(): void {
		this.#transcript = [];
		this.#counter = 0;
		this.#open = [];
		this.#ended.clear();
		this.#prompts.clear();
		this.#echoQueue = [];
		this.#pendingUi.clear();
	}

	/**
	 * Register a prompt about to be sent so its user echo and `prompt_result` carry `clientId`.
	 *
	 * OMP echoes the user message only when the run actually starts, which can be a second or more after the
	 * prompt was admitted. With `showPending` the prompt is put in the transcript right away (returned as
	 * `message_start` + `message_end` events to publish) so a client attaching in that window already sees it;
	 * when OMP's echo arrives it is folded into that same message id instead of creating a second one. Only ask
	 * for it when nothing is running: a prompt queued behind a run is delivered later, so showing it at the end
	 * of the transcript now would put it before messages that still have to arrive.
	 */
	registerPrompt(promptId: string, clientId: string, text: string, options: { showPending?: boolean } = {}): SessionEvent[] {
		const record: PromptRecord = { clientId, text };
		this.#prompts.set(promptId, record);
		this.#echoQueue.push(promptId);
		if (!options.showPending) return [];
		const message: UiMessage = { id: `m${this.#counter + 1}`, role: "user", timestamp: Date.now(), content: [{ type: "text", text }], clientId };
		this.#counter++;
		record.synthetic = message;
		this.#transcript.push(message);
		return [
			{ type: "message_start", message: cloneMessage(message) },
			{ type: "message_end", message: cloneMessage(message) },
		];
	}

	/** A prompt that finished locally (e.g. a slash command: no echo, no `prompt_result` frame): the `prompt_result` event to publish. */
	completePrompt(promptId: string): SessionEvent[] {
		const record = this.#prompts.get(promptId);
		if (!record) return [];
		this.#prompts.delete(promptId);
		const queued = this.#echoQueue.indexOf(promptId);
		if (queued >= 0) this.#echoQueue.splice(queued, 1);
		return [{ type: "prompt_result", promptId, clientId: record.clientId, status: "completed" }];
	}

	/**
	 * Close a prompt that ends without having run: events to publish. A message shown for it that OMP never echoed is
	 * withdrawn (`message_removed`) so the bubble does not linger, then `prompt_result` reports the outcome.
	 */
	failPrompt(promptId: string, status: "aborted" | "error", error?: string): SessionEvent[] {
		const record = this.#prompts.get(promptId);
		if (!record) return [];
		this.#prompts.delete(promptId);
		const queued = this.#echoQueue.indexOf(promptId);
		if (queued >= 0) this.#echoQueue.splice(queued, 1);
		const events: SessionEvent[] = [];
		if (record.synthetic && !record.echoed) {
			const at = this.#transcript.lastIndexOf(record.synthetic);
			if (at >= 0) {
				this.#transcript.splice(at, 1);
				events.push({ type: "message_removed", messageId: record.synthetic.id });
			}
		}
		events.push({ type: "prompt_result", promptId, clientId: record.clientId, status, ...(error ? { error } : {}) });
		return events;
	}

	takeUsage(): UsageDelta[] {
		const out = [...this.#usage.values()];
		this.#usage.clear();
		return out;
	}

	pendingUiRequests(): UiRequestEvent[] {
		return [...this.#pendingUi.values()];
	}

	markUiResolved(requestId: string): SessionEvent | null {
		return this.#pendingUi.delete(requestId) ? { type: "ui_request_resolved", requestId } : null;
	}

	page(query: { cursor?: string; limit?: number }): MessagesPage {
		const total = this.#transcript.length;
		const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_PAGE_LIMIT) || DEFAULT_PAGE_LIMIT));
		let end = total;
		if (query.cursor) {
			const decoded = decodeCursor(query.cursor);
			if (decoded !== null && decoded <= total) end = decoded;
		}
		const start = Math.max(0, end - limit);
		const inFlight = new Set(this.#open.map((o) => o.msg));
		const messages = this.#transcript.slice(start, end).map((m) => (inFlight.has(m) ? cloneMessage(m) : m));
		return { messages, total, nextCursor: start > 0 ? encodeCursor(start) : null };
	}

	handleFrame(frame: OmpFrame): MapResult {
		try {
			return this.#dispatch(frame);
		} catch {
			return { events: [], stateDirty: false };
		}
	}

	// ------------------------------------------------------------ dispatch

	#dispatch(frame: OmpFrame): MapResult {
		if (!isRecord(frame) || typeof frame.type !== "string") return EMPTY;
		const dirty = Object.hasOwn(STATE_DIRTY_TYPES, frame.type);
		switch (frame.type) {
			case "agent_start":
				return { events: [{ type: "agent_start" }], stateDirty: true };
			case "agent_end": {
				const events = this.#closeOpen();
				events.push({ type: "agent_end" });
				return { events, stateDirty: true };
			}
			case "message_start":
				return { events: this.#messageStart(frame), stateDirty: false };
			case "message_update":
				return { events: this.#messageUpdate(frame), stateDirty: false };
			case "message_end":
				return { events: this.#messageEnd(frame), stateDirty: false };
			case "tool_execution_start": {
				if (typeof frame.toolCallId !== "string") return EMPTY;
				const event: SessionEvent = { type: "tool_start", toolCallId: frame.toolCallId, toolName: typeof frame.toolName === "string" ? frame.toolName : "", args: frame.args };
				if (typeof frame.intent === "string") event.intent = frame.intent;
				return { events: [event], stateDirty: false };
			}
			case "tool_execution_update":
			case "tool_stream_update": {
				if (typeof frame.toolCallId !== "string") return EMPTY;
				const source = frame.type === "tool_stream_update" ? frame.update : frame.partialResult;
				return { events: [{ type: "tool_update", toolCallId: frame.toolCallId, preview: preview(resultText(source)) }], stateDirty: false };
			}
			case "tool_execution_end": {
				if (typeof frame.toolCallId !== "string") return EMPTY;
				return {
					events: [{ type: "tool_end", toolCallId: frame.toolCallId, isError: frame.isError === true, result: resultText(frame.result) }],
					stateDirty: frame.toolName === "todo",
				};
			}
			case "prompt_result":
				return this.#promptResult(frame);
			case "session_settled":
				return { events: [{ type: "settled" }], stateDirty: true };
			case "notice":
				return typeof frame.message === "string" ? { events: [{ type: "notice", level: asLevel(frame.level), message: frame.message }], stateDirty: false } : EMPTY;
			case "rpc_frame_error":
				return { events: [{ type: "notice", level: "warning", message: `RPC frame error: ${typeof frame.error === "string" ? frame.error : "unknown"}` }], stateDirty: false };
			case "extension_error": {
				const where = typeof frame.event === "string" ? ` (${frame.event})` : "";
				return { events: [{ type: "notice", level: "warning", message: `Extension error${where}: ${typeof frame.error === "string" ? frame.error : "unknown"}` }], stateDirty: false };
			}
			case "auto_retry_start":
				return { events: [{ type: "notice", level: "warning", message: `Retrying (${String(frame.attempt)}/${String(frame.maxAttempts)}): ${typeof frame.errorMessage === "string" ? frame.errorMessage : "request failed"}` }], stateDirty: false };
			case "auto_compaction_end":
			case "manual_compaction_end":
				return {
					events: typeof frame.errorMessage === "string" && frame.errorMessage ? [{ type: "notice", level: "warning", message: `Compaction: ${frame.errorMessage}` }] : [],
					stateDirty: true,
				};
			case "extension_ui_request":
				return { events: this.#uiRequest(frame), stateDirty: false };
			default:
				return dirty ? { events: [], stateDirty: true } : EMPTY;
		}
	}

	// ------------------------------------------------------------ messages

	#findOpen(wireId: string | undefined): number {
		if (wireId === undefined) return this.#open.length - 1;
		for (let i = this.#open.length - 1; i >= 0; i--) if (this.#open[i]?.wireId === wireId) return i;
		return -1;
	}

	#markEnded(wireId: string | undefined): void {
		if (wireId === undefined) return;
		this.#ended.add(wireId);
		if (this.#ended.size > ENDED_CAP) {
			const oldest = this.#ended.values().next().value;
			if (oldest !== undefined) this.#ended.delete(oldest);
		}
	}

	/**
	 * The prompt a user echo belongs to: the oldest registered prompt with the same text. When OMP rewrote the text
	 * (templates, mentions) the first user-authored echo belongs to the oldest prompt that is still showing a pending message.
	 */
	#matchPrompt(text: string, userAuthored: boolean): PromptRecord | undefined {
		for (let i = 0; i < this.#echoQueue.length; i++) {
			const record = this.#prompts.get(this.#echoQueue[i] as string);
			if (record && record.text.trim() === text.trim()) {
				this.#echoQueue.splice(i, 1);
				return record;
			}
		}
		if (!userAuthored) return undefined;
		for (let i = 0; i < this.#echoQueue.length; i++) {
			const record = this.#prompts.get(this.#echoQueue[i] as string);
			if (record?.synthetic) {
				this.#echoQueue.splice(i, 1);
				return record;
			}
		}
		return undefined;
	}

	#messageStart(frame: OmpFrame): SessionEvent[] {
		const wireId = typeof frame.messageId === "string" ? frame.messageId : undefined;
		if (wireId !== undefined && (this.#ended.has(wireId) || this.#findOpen(wireId) >= 0)) return [];
		const raw = frame.message;
		let clientId: string | undefined;
		if (isRecord(raw) && raw.role === "user") {
			const probe = toUiMessage(raw, "");
			const text = probe ? probe.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
			const matched = this.#matchPrompt(text, raw.synthetic !== true && raw.attribution !== "agent");
			clientId = matched?.clientId;
			if (matched?.synthetic && this.#transcript.includes(matched.synthetic)) {
				// Already in the transcript, and published, since the prompt was admitted: the echo completes that message.
				matched.echoed = true;
				this.#open.push({ wireId, msg: matched.synthetic, placeholders: new Set() });
				return [];
			}
		}
		const ui = toUiMessage(raw, `m${this.#counter + 1}`, clientId !== undefined ? { clientId } : undefined);
		if (!ui) {
			this.#open.push({ wireId, msg: null, placeholders: new Set() });
			return [];
		}
		this.#counter++;
		// Assistant content is rebuilt from the stream; the start frame may carry a partial snapshot.
		if (ui.role === "assistant") ui.content = [];
		this.#transcript.push(ui);
		this.#open.push({ wireId, msg: ui, placeholders: new Set() });
		return [{ type: "message_start", message: cloneMessage(ui) }];
	}

	#messageEnd(frame: OmpFrame): SessionEvent[] {
		const wireId = typeof frame.messageId === "string" ? frame.messageId : undefined;
		const at = this.#findOpen(wireId);
		if (at < 0) {
			if (wireId !== undefined && this.#ended.has(wireId)) return [];
			// End without a start: authoritative standalone message.
			this.#markEnded(wireId);
			const ui = toUiMessage(frame.message, `m${this.#counter + 1}`);
			if (!ui) return [];
			this.#counter++;
			this.#transcript.push(ui);
			this.#recordUsage(frame.message);
			return [{ type: "message_end", message: ui }];
		}
		const [entry] = this.#open.splice(at, 1) as [OpenMessage];
		this.#markEnded(entry.wireId);
		if (!entry.msg) return [];
		const final = toUiMessage(frame.message, entry.msg.id, entry.msg.clientId !== undefined ? { clientId: entry.msg.clientId } : undefined);
		const settled = final ?? entry.msg;
		const index = this.#transcript.lastIndexOf(entry.msg);
		if (index >= 0) this.#transcript[index] = settled;
		this.#recordUsage(frame.message);
		return [{ type: "message_end", message: settled }];
	}

	/** Finalize messages a dropped frame left open; their in-flight state is the best available. */
	#closeOpen(): SessionEvent[] {
		const events: SessionEvent[] = [];
		for (const entry of this.#open) {
			this.#markEnded(entry.wireId);
			if (entry.msg) events.push({ type: "message_end", message: cloneMessage(entry.msg) });
		}
		this.#open = [];
		return events;
	}

	#recordUsage(raw: unknown): void {
		if (!isRecord(raw) || raw.role !== "assistant" || !isRecord(raw.usage)) return;
		const provider = typeof raw.provider === "string" ? raw.provider : "";
		const model = typeof raw.model === "string" ? raw.model : "";
		const tokens = toTokenTotals(raw.usage);
		const cost = isRecord(raw.usage.cost) && typeof raw.usage.cost.total === "number" ? raw.usage.cost.total : 0;
		if (tokens.total === 0 && cost === 0) return;
		const key = `${provider}\u0000${model}`;
		const acc = this.#usage.get(key);
		if (!acc) {
			this.#usage.set(key, { provider, model, tokens, cost });
			return;
		}
		acc.tokens = {
			input: acc.tokens.input + tokens.input,
			output: acc.tokens.output + tokens.output,
			cacheRead: acc.tokens.cacheRead + tokens.cacheRead,
			cacheWrite: acc.tokens.cacheWrite + tokens.cacheWrite,
			total: acc.tokens.total + tokens.total,
		};
		acc.cost += cost;
	}

	#messageUpdate(frame: OmpFrame): SessionEvent[] {
		const wireId = typeof frame.messageId === "string" ? frame.messageId : undefined;
		const entry = this.#open[this.#findOpen(wireId)];
		const msg = entry?.msg;
		if (!entry || !msg || msg.role !== "assistant") return [];
		// Full projection: `message` is the accumulated snapshot.
		if (isRecord(frame.message) && Array.isArray(frame.message.content)) return this.#applySnapshot(entry, msg, frame.message.content);
		const ame = frame.assistantMessageEvent;
		if (!isRecord(ame) || typeof ame.type !== "string") return [];
		if (ame.type === "start") {
			const partial = isRecord(ame.message) ? ame.message : isRecord(ame.partial) ? ame.partial : undefined;
			if (partial) {
				if (typeof partial.provider === "string") msg.provider = partial.provider;
				if (typeof partial.model === "string") msg.model = partial.model;
			}
			return [];
		}
		const index = typeof ame.contentIndex === "number" && Number.isInteger(ame.contentIndex) && ame.contentIndex >= 0 ? ame.contentIndex : -1;
		if (index < 0) return [];
		switch (ame.type) {
			case "text_start":
			case "thinking_start":
			case "toolcall_start": {
				const kind = ame.type === "text_start" ? "text" : ame.type === "thinking_start" ? "thinking" : "toolCall";
				this.#ensureBlock(entry, msg, index, kind, toAssistantBlock(ame.block) ?? undefined);
				return [];
			}
			case "text_delta":
			case "thinking_delta":
			case "toolcall_delta": {
				if (typeof ame.delta !== "string") return [];
				const kind = ame.type === "text_delta" ? "text" : ame.type === "thinking_delta" ? "thinking" : "toolCall";
				const block = this.#ensureBlock(entry, msg, index, kind);
				if (block.type === "image") return [];
				if (block.type === "text" || block.type === "thinking") msg.content[index] = { ...block, text: block.text + ame.delta };
				return [{ type: "message_delta", messageId: msg.id, contentIndex: index, kind: block.type, delta: ame.delta }];
			}
			case "text_end":
			case "thinking_end": {
				if (typeof ame.content !== "string") return [];
				const block = this.#ensureBlock(entry, msg, index, ame.type === "text_end" ? "text" : "thinking");
				if (block.type === "text" || block.type === "thinking") msg.content[index] = { ...block, text: ame.content };
				return [];
			}
			case "toolcall_end":
			case "image_end": {
				const block = toAssistantBlock(ame.type === "toolcall_end" ? ame.toolCall : ame.content);
				if (block) this.#setBlock(entry, msg, index, block);
				return [];
			}
			default:
				return [];
		}
	}

	#setBlock(entry: OpenMessage, msg: UiMessage, index: number, block: UiBlock): void {
		while (msg.content.length < index) {
			entry.placeholders.add(msg.content.length);
			msg.content.push(blockPlaceholder());
		}
		entry.placeholders.delete(index);
		msg.content[index] = block;
	}

	/** Returns the block at `index`, creating (or replacing a placeholder with) one of `kind` when absent. */
	#ensureBlock(entry: OpenMessage, msg: UiMessage, index: number, kind: "text" | "thinking" | "toolCall", seed?: UiBlock): UiBlock {
		const existing = msg.content[index];
		if (existing && !entry.placeholders.has(index)) return existing;
		const block: UiBlock =
			seed ??
			(kind === "toolCall" ? { type: "toolCall", id: "", name: "", arguments: {} } : kind === "thinking" ? { type: "thinking", text: "" } : { type: "text", text: "" });
		this.#setBlock(entry, msg, index, block);
		return block;
	}

	/** Diff an accumulated snapshot (non-delta projection) against the in-flight message. */
	#applySnapshot(entry: OpenMessage, msg: UiMessage, snapshot: unknown[]): SessionEvent[] {
		const events: SessionEvent[] = [];
		const grow = (index: number, kind: "text" | "thinking" | "toolCall", before: string, after: string): void => {
			if (after.length > before.length && after.startsWith(before)) {
				events.push({ type: "message_delta", messageId: msg.id, contentIndex: index, kind, delta: after.slice(before.length) });
			}
		};
		snapshot.forEach((raw, index) => {
			const block = toAssistantBlock(raw);
			const existing = entry.placeholders.has(index) ? undefined : msg.content[index];
			if (!block) {
				if (!existing) this.#setBlock(entry, msg, index, blockPlaceholder());
				entry.placeholders.add(index);
				return;
			}
			if (block.type === "text" || block.type === "thinking") {
				const before = existing && existing.type === block.type ? existing.text : "";
				this.#setBlock(entry, msg, index, block);
				grow(index, block.type, before, block.text);
			} else if (block.type === "toolCall") {
				const before = existing && existing.type === "toolCall" ? JSON.stringify(existing.arguments) : "";
				const after = JSON.stringify(block.arguments);
				this.#setBlock(entry, msg, index, block);
				if (after !== "{}") grow(index, "toolCall", before, after);
			} else {
				this.#setBlock(entry, msg, index, block);
			}
		});
		return events;
	}

	// ------------------------------------------------------------ prompts / ui

	#promptResult(frame: OmpFrame): MapResult {
		const id = typeof frame.id === "string" ? frame.id : undefined;
		const prompt = id === undefined ? undefined : this.#prompts.get(id);
		if (id === undefined || !prompt) return EMPTY;
		const status = frame.status === "completed" || frame.status === "aborted" ? frame.status : "error";
		// OMP reports `{ message, ... }`; older shapes were a bare string.
		const reason = isRecord(frame.error) ? frame.error.message : frame.error;
		const error = typeof reason === "string" && reason ? reason : undefined;
		if (status !== "completed") return { events: this.failPrompt(id, status, error), stateDirty: true };
		this.#prompts.delete(id);
		const queued = this.#echoQueue.indexOf(id);
		if (queued >= 0) this.#echoQueue.splice(queued, 1);
		return { events: [{ type: "prompt_result", promptId: id, clientId: prompt.clientId, status }], stateDirty: true };
	}

	#uiRequest(frame: OmpFrame): SessionEvent[] {
		const id = typeof frame.id === "string" ? frame.id : undefined;
		if (id === undefined) return [];
		const title = typeof frame.title === "string" ? frame.title : "";
		let request: UiRequestEvent;
		switch (frame.method) {
			case "select": {
				const options = Array.isArray(frame.options) ? frame.options.filter((o): o is string => typeof o === "string") : [];
				request = { type: "ui_request", requestId: id, method: "select", title, options };
				break;
			}
			case "confirm":
				request = { type: "ui_request", requestId: id, method: "confirm", title, ...(typeof frame.message === "string" ? { message: frame.message } : {}) };
				break;
			case "input":
				request = { type: "ui_request", requestId: id, method: "input", title, ...(typeof frame.placeholder === "string" ? { message: frame.placeholder } : {}) };
				break;
			case "editor":
				request = { type: "ui_request", requestId: id, method: "editor", title, ...(typeof frame.prefill === "string" ? { message: frame.prefill } : {}) };
				break;
			case "ask": {
				const questions = Array.isArray(frame.questions) ? frame.questions.filter(isRecord) : [];
				const first = questions[0];
				if (!first) return [];
				const options = Array.isArray(first.options)
					? first.options.map((o) => (isRecord(o) && typeof o.label === "string" ? o.label : typeof o === "string" ? o : undefined)).filter((o): o is string => o !== undefined)
					: [];
				const lines = questions.map((q) => (typeof q.question === "string" ? q.question : "")).filter(Boolean);
				request = {
					type: "ui_request",
					requestId: id,
					method: "ask",
					title: typeof first.header === "string" ? first.header : (lines[0] ?? ""),
					message: lines.join("\n"),
					options,
				};
				break;
			}
			case "cancel": {
				const target = typeof frame.targetId === "string" ? frame.targetId : undefined;
				return target !== undefined && this.#pendingUi.delete(target) ? [{ type: "ui_request_resolved", requestId: target }] : [];
			}
			case "notify":
				return typeof frame.message === "string" ? [{ type: "notice", level: asLevel(frame.notifyType), message: frame.message }] : [];
			default:
				return [];
		}
		this.#pendingUi.set(id, request);
		return [request];
	}
}
