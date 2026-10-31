import { AccessService } from "./auth/service.ts";
import { createNetwork, type NetworkOptions } from "./network/index.ts";
import type { NetworkBase } from "./network/types.ts";
import type { ServerContext } from "./context.ts";
import { GitService } from "./services/git-service.ts";
import { HostToolRegistry } from "./services/host-tool-registry.ts";
import { SessionService } from "./services/session-service.ts";
import { SharedService, type SharedServiceOptions } from "./shared/service.ts";
import { TaskService, type TaskServiceOptions } from "./tasks/service.ts";

/**
 * Build the services that depend on each other after the base context exists: the agent network, the session and git
 * services, the task engine and the shared sessions (which the network listener serves, hence `attachTasks` /
 * `attachShared`). Nothing runs until `network.listen()` and `tasks.start()` (which starts the shared sessions too).
 */
export function assembleContext(base: NetworkBase, options: { network?: NetworkOptions; cloudflaredBinary?: string; tasks?: TaskServiceOptions; shared?: SharedServiceOptions } = {}): ServerContext {
	const network = createNetwork(base, { ...options.network, ...(options.cloudflaredBinary !== undefined && { cloudflaredBinary: options.cloudflaredBinary }) });
	const ctx = { ...base, network } as ServerContext;
	ctx.access = new AccessService(ctx);
	ctx.sessions = new SessionService(ctx);
	ctx.gitService = new GitService(ctx);
	ctx.hostTools = new HostToolRegistry();
	ctx.tasks = new TaskService(ctx, options.tasks);
	network.attachTasks(ctx.tasks);
	ctx.shared = new SharedService(ctx, options.shared);
	network.attachShared(ctx.shared);
	// The public listener serves the owner web UI (behind the owner-session gate) from this context.
	network.attachUi(ctx);
	return ctx;
}
