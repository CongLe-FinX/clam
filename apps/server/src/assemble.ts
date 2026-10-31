import { AccessService } from "./auth/service.ts";
import { BrowserService, type BrowserServiceOptions } from "./browser/service.ts";
import { ContextService, type ContextServiceOptions } from "./context/service.ts";
import { HandoffService, type HandoffServiceOptions } from "./handoff/service.ts";
import { createNetwork, type NetworkOptions } from "./network/index.ts";
import type { NetworkBase } from "./network/types.ts";
import type { ServerContext } from "./context.ts";
import { GitService } from "./services/git-service.ts";
import { HostToolRegistry } from "./services/host-tool-registry.ts";
import { SessionService } from "./services/session-service.ts";
import { TerminalService, type TerminalOptions } from "./terminal/service.ts";
import { TurnOutputService } from "./services/turn-outputs.ts";
import { SharedService, type SharedServiceOptions } from "./shared/service.ts";
import { TaskService, type TaskServiceOptions } from "./tasks/service.ts";

/**
 * Build the services that depend on each other after the base context exists: the agent network, the session and git
 * services, the task engine and the shared sessions (which the network listener serves, hence `attachTasks` /
 * `attachShared`). Nothing runs until `network.listen()` and `tasks.start()` (which starts the shared sessions too).
 */
export function assembleContext(base: NetworkBase, options: { network?: NetworkOptions; cloudflaredBinary?: string; tasks?: TaskServiceOptions; shared?: SharedServiceOptions; contexts?: ContextServiceOptions; handoffs?: HandoffServiceOptions; terminal?: TerminalOptions; browser?: BrowserServiceOptions } = {}): ServerContext {
	const network = createNetwork(base, { ...options.network, ...(options.cloudflaredBinary !== undefined && { cloudflaredBinary: options.cloudflaredBinary }) });
	const ctx = { ...base, network } as ServerContext;
	ctx.access = new AccessService(ctx);
	ctx.terminals = new TerminalService(ctx, options.terminal);
	ctx.browser = new BrowserService(ctx, options.browser);
	ctx.turnOutputs = new TurnOutputService(ctx);
	ctx.sessions = new SessionService(ctx);
	ctx.gitService = new GitService(ctx);
	ctx.hostTools = new HostToolRegistry();
	ctx.tasks = new TaskService(ctx, options.tasks);
	network.attachTasks(ctx.tasks);
	ctx.shared = new SharedService(ctx, options.shared);
	network.attachShared(ctx.shared);
	ctx.contexts = new ContextService(ctx, options.contexts);
	network.attachContexts(ctx.contexts);
	ctx.handoffs = new HandoffService(ctx, options.handoffs);
	network.attachHandoffs(ctx.handoffs);
	// The public listener serves the owner web UI (behind the owner-session gate) from this context.
	network.attachUi(ctx);
	return ctx;
}
