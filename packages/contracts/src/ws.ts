import { z } from "zod";
import type { LoginFlow } from "./omp.ts";
import type { AgentSession, RuntimeStatus, SessionEvent } from "./session.ts";
import type { DeviceFlowStatus } from "./github.ts";
import type { ContextTopicEvent } from "./context.ts";
import type { HandoffTopicEvent } from "./handoff.ts";
import type { GitEvent, GitOperationEvent } from "./git.ts";
import type { NetworkEvent, TunnelEvent } from "./network.ts";
import type { NodeHealth } from "./node.ts";
import type { SharedTopicEvent } from "./shared.ts";
import type { TaskTopicEvent } from "./tasks.ts";

/**
 * Single multiplexed socket at `/ws`.
 * Topics: `session:<id>` · `sessions` · `runtime` · `login:<flowId>` · `github-device:<flowId>` · `node` · `git:<projectId>` · `git-op:<operationId>` · `network` · `tunnel` · `tasks` · `task:<id>` · `shared` · `shared:<id>` · `contexts` · `handoffs` · `handoff:<id>`.
 */
export const ClientWsMessage = z.discriminatedUnion("type", [
	z.object({ type: z.literal("subscribe"), topics: z.array(z.string()).max(64) }),
	z.object({ type: z.literal("unsubscribe"), topics: z.array(z.string()).max(64) }),
	z.object({ type: z.literal("ping"), t: z.number() }),
]);
export type ClientWsMessage = z.infer<typeof ClientWsMessage>;

export type TopicPayload =
	| { topic: `session:${string}`; event: SessionEvent }
	| { topic: "sessions"; event: { type: "upsert"; session: AgentSession } | { type: "remove"; sessionId: string } }
	| { topic: "runtime"; event: { type: "status"; status: RuntimeStatus } }
	| { topic: `login:${string}`; event: { type: "flow"; flow: LoginFlow } }
	| { topic: `github-device:${string}`; event: { type: "flow"; status: DeviceFlowStatus } }
	| { topic: "node"; event: { type: "health"; health: NodeHealth } }
	| { topic: `git:${string}`; event: GitEvent }
	| { topic: `git-op:${string}`; event: GitOperationEvent }
	| { topic: "network"; event: NetworkEvent }
	| { topic: "tunnel"; event: TunnelEvent }
	| { topic: "tasks"; event: TaskTopicEvent }
	| { topic: `task:${string}`; event: TaskTopicEvent }
	| { topic: "shared"; event: SharedTopicEvent }
	| { topic: `shared:${string}`; event: SharedTopicEvent }
	| { topic: "contexts"; event: ContextTopicEvent }
	| { topic: "handoffs"; event: HandoffTopicEvent }
	| { topic: `handoff:${string}`; event: HandoffTopicEvent };

/** Server → client frames. `seq` is per-topic, monotonically increasing; gaps mean the client must refetch. */
export type ServerWsMessage =
	| ({ type: "event"; seq: number } & TopicPayload)
	| { type: "subscribed"; topics: string[] }
	| { type: "pong"; t: number }
	| { type: "error"; message: string };
