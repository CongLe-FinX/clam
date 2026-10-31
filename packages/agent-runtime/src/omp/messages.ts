import type { ContextUsage, RuntimeStatus, SessionLiveState, SessionStats, TokenTotals, TodoPhase, UiBlock, UiMessage } from "@clam/contracts";
import { isRecord } from "./frames.ts";

/** Pure converters from OMP wire messages (pi-ai / coding-agent `AgentMessage`) to CLAM contracts. */

const RESULT_TEXT_CAP = 64 * 1024;

type Rec = Record<string, unknown>;

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function toTokenTotals(usage: unknown): TokenTotals {
	const u = isRecord(usage) ? usage : {};
	const input = num(u.input);
	const output = num(u.output);
	const cacheRead = num(u.cacheRead);
	const cacheWrite = num(u.cacheWrite);
	const explicit = typeof u.totalTokens === "number" ? u.totalTokens : typeof u.total === "number" ? u.total : undefined;
	const total = explicit !== undefined && Number.isFinite(explicit) ? explicit : input + output + cacheRead + cacheWrite;
	return { input, output, cacheRead, cacheWrite, total };
}

function toContextUsage(value: unknown): ContextUsage | null {
	if (!isRecord(value)) return null;
	const { tokens, contextWindow, percent } = value;
	if (typeof tokens !== "number" || typeof contextWindow !== "number") return null;
	return { tokens, contextWindow, percent: typeof percent === "number" ? percent : contextWindow > 0 ? (tokens / contextWindow) * 100 : 0 };
}

export function toSessionStats(data: unknown): SessionStats & { sessionId: string | null } {
	const d = isRecord(data) ? data : {};
	return {
		sessionId: str(d.sessionId) ?? null,
		userMessages: num(d.userMessages),
		assistantMessages: num(d.assistantMessages),
		toolCalls: num(d.toolCalls),
		tokens: toTokenTotals(d.tokens),
		cost: num(d.cost),
		contextUsage: toContextUsage(d.contextUsage),
	};
}

function toStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((v) => (typeof v === "string" ? v : isRecord(v) && typeof v.text === "string" ? v.text : JSON.stringify(v)));
}

function toTodoPhases(value: unknown): TodoPhase[] {
	if (!Array.isArray(value)) return [];
	const phases: TodoPhase[] = [];
	for (const p of value) {
		if (!isRecord(p)) continue;
		const tasks = Array.isArray(p.tasks) ? p.tasks.filter(isRecord).map((t) => ({ content: str(t.content) ?? "", status: str(t.status) ?? "pending" })) : [];
		phases.push({ name: str(p.name) ?? "", tasks });
	}
	return phases;
}

export function toLiveState(args: {
	sessionId: string;
	runtime: RuntimeStatus;
	state: unknown;
	availableThinkingLevels: string[];
}): SessionLiveState {
	const s = isRecord(args.state) ? args.state : {};
	const model = isRecord(s.model) && typeof s.model.id === "string" && typeof s.model.provider === "string" ? s.model : null;
	const queued = isRecord(s.queuedMessages) ? s.queuedMessages : {};
	const isStreaming = s.isStreaming === true;
	const name = model ? str(model.name) : undefined;
	return {
		sessionId: args.sessionId,
		runtime: args.runtime,
		model: model ? { provider: model.provider as string, id: model.id as string, ...(name !== undefined ? { name } : {}) } : null,
		thinkingLevel: str(s.thinkingLevel) ?? null,
		availableThinkingLevels: args.availableThinkingLevels,
		isStreaming,
		isSettled: typeof s.isSettled === "boolean" ? s.isSettled : !isStreaming,
		contextUsage: toContextUsage(s.contextUsage),
		queued: { steering: toStringList(queued.steering), followUp: toStringList(queued.followUp) },
		todoPhases: toTodoPhases(s.todoPhases),
		tokensPerSecond: typeof s.tokensPerSecond === "number" && Number.isFinite(s.tokensPerSecond) ? s.tokensPerSecond : null,
	};
}

/** Tool result (`AgentToolResult`: `{content:[...]}`) to display text, capped at ~64 KB. */
export function resultText(result: unknown): string {
	let text: string;
	if (typeof result === "string") {
		text = result;
	} else if (isRecord(result) && Array.isArray(result.content)) {
		const parts: string[] = [];
		for (const block of result.content) {
			if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
		text = parts.join("\n");
	} else if (result === undefined || result === null) {
		text = "";
	} else {
		try {
			text = JSON.stringify(result) ?? "";
		} catch {
			text = String(result);
		}
	}
	if (text.length > RESULT_TEXT_CAP) {
		return `${text.slice(0, RESULT_TEXT_CAP)}\n… [truncated ${text.length - RESULT_TEXT_CAP} characters]`;
	}
	return text;
}

function userBlocks(content: unknown): UiBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	const blocks: UiBlock[] = [];
	for (const b of content) {
		if (!isRecord(b)) continue;
		if (b.type === "text" && typeof b.text === "string") blocks.push({ type: "text", text: b.text });
		else if (b.type === "image" && typeof b.data === "string") blocks.push({ type: "image", mimeType: str(b.mimeType) ?? "application/octet-stream", data: b.data });
	}
	return blocks;
}

/** Convert one assistant content block; unknown kinds (fallback, anthropicServerTool, ...) yield null. */
export function toAssistantBlock(b: unknown): UiBlock | null {
	if (!isRecord(b)) return null;
	switch (b.type) {
		case "text":
			return typeof b.text === "string" ? { type: "text", text: b.text } : null;
		case "thinking":
			if (typeof b.thinking !== "string") return null;
			// Narration is prose addressed to the user, returned by the provider as thinking.
			return b.narration === true ? { type: "text", text: b.thinking } : { type: "thinking", text: b.thinking };
		case "redactedThinking":
			return { type: "thinking", text: "", redacted: true };
		case "toolCall": {
			if (typeof b.id !== "string" || typeof b.name !== "string") return null;
			const block: UiBlock = { type: "toolCall", id: b.id, name: b.name, arguments: b.arguments ?? {} };
			if (typeof b.intent === "string") block.intent = b.intent;
			return block;
		}
		case "image":
			return typeof b.data === "string" ? { type: "image", mimeType: str(b.mimeType) ?? "application/octet-stream", data: b.data } : null;
		default:
			return null;
	}
}

function textOf(blocks: UiBlock[]): string {
	return blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
}

function executionText(prefix: string, source: string, m: Rec): string {
	const output = str(m.output) ?? "";
	const flags: string[] = [];
	if (m.cancelled === true) flags.push("cancelled");
	if (m.truncated === true) flags.push("truncated");
	if (typeof m.exitCode === "number") flags.push(`exit ${m.exitCode}`);
	return `${prefix} ${source}${output ? `\n${output}` : ""}${flags.length ? `\n[${flags.join(", ")}]` : ""}`;
}

function usageOf(m: Rec): { tokens: TokenTotals; cost: number } | undefined {
	if (!isRecord(m.usage)) return undefined;
	const cost = isRecord(m.usage.cost) ? num(m.usage.cost.total) : 0;
	return { tokens: toTokenTotals(m.usage), cost };
}

/** `null` = not displayable. */
export function toUiMessage(message: unknown, id: string, opts?: { clientId?: string }): UiMessage | null {
	if (!isRecord(message)) return null;
	const timestamp = typeof message.timestamp === "number" ? message.timestamp : 0;
	const custom = (customType: string, text: string, extra: UiBlock[] = []): UiMessage => ({
		id,
		role: "custom",
		timestamp,
		customType,
		content: [{ type: "text", text }, ...extra],
	});
	switch (message.role) {
		case "user": {
			const out: UiMessage = { id, role: "user", timestamp, content: userBlocks(message.content) };
			if (opts?.clientId !== undefined) out.clientId = opts.clientId;
			return out;
		}
		case "assistant": {
			const content: UiBlock[] = [];
			if (Array.isArray(message.content)) {
				for (const b of message.content) {
					const block = toAssistantBlock(b);
					if (block) content.push(block);
				}
			}
			const out: UiMessage = { id, role: "assistant", timestamp, content };
			if (typeof message.provider === "string") out.provider = message.provider;
			if (typeof message.model === "string") out.model = message.model;
			const usage = usageOf(message);
			if (usage) out.usage = usage;
			if (typeof message.stopReason === "string") out.stopReason = message.stopReason;
			if (typeof message.errorMessage === "string") out.errorMessage = message.errorMessage;
			return out;
		}
		case "toolResult": {
			const out: UiMessage = { id, role: "toolResult", timestamp, content: userBlocks(message.content) };
			if (typeof message.toolCallId === "string") out.toolCallId = message.toolCallId;
			if (typeof message.toolName === "string") out.toolName = message.toolName;
			out.isError = message.isError === true;
			return out;
		}
		case "custom":
		case "hookMessage": {
			if (message.display === false) return null;
			const blocks = userBlocks(message.content);
			const images = blocks.filter((b) => b.type === "image");
			return custom(str(message.customType) ?? message.role, textOf(blocks), images);
		}
		case "bashExecution":
			return custom("bashExecution", executionText("$", str(message.command) ?? "", message));
		case "pythonExecution":
			return custom("pythonExecution", executionText(">>>", str(message.code) ?? "", message));
		case "branchSummary":
			return custom("branchSummary", str(message.summary) ?? "");
		case "compactionSummary":
			return custom("compactionSummary", str(message.summary) ?? "");
		case "fileMention": {
			const files = Array.isArray(message.files) ? message.files.filter(isRecord) : [];
			const lines = files.map((f) => {
				const skipped = str(f.skippedReason);
				return `${str(f.path) ?? "?"}${typeof f.lineCount === "number" ? ` (${f.lineCount} lines)` : ""}${skipped ? ` [skipped: ${skipped}]` : ""}`;
			});
			return custom("fileMention", lines.join("\n"));
		}
		default:
			return null;
	}
}
