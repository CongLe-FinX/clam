import type { AgentRuntime } from "@clam/agent-runtime";
import { deliveryMode, type MessageKind } from "@clam/task-engine";
import type { SessionService, PromptInput } from "../services/session-service.ts";

/** How the text reached the session: `prompt` = the agent was idle (this wakes it), `steer`/`followUp` = it was mid-turn. */
export type InjectionMode = ReturnType<typeof deliveryMode>;

/**
 * Put already-framed text (see `buildMeshMessage` / `buildStatusNote` in `@clam/task-engine`) into a local agent session.
 * Feature-neutral on purpose: it knows a session id, a `clientId` (the prompt is idempotent per session + clientId, so a
 * retry never sends the text twice) and the message kind that selects the delivery mode — not tasks.
 */
export async function injectIntoSession(
	deps: { sessions: SessionService; runtime: AgentRuntime },
	i: { sessionId: string; clientId: string; text: string; kind: MessageKind; images?: PromptInput["images"] },
): Promise<InjectionMode> {
	const busy = deps.runtime.get(i.sessionId)?.status().state === "busy";
	const mode = deliveryMode({ busy, kind: i.kind });
	await deps.sessions.prompt(i.sessionId, { message: i.text, clientId: i.clientId, streamingBehavior: mode === "prompt" ? undefined : mode, ...(i.images?.length ? { images: i.images } : {}) });
	return mode;
}
