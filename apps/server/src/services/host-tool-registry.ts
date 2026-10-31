import type { HostToolCall, HostToolDefinition, HostToolProvider, HostToolResult } from "@clam/agent-runtime";

/** One feature's host tools (the `mesh_*` tools are one set). A set owns the tool names it lists; names must be unique across sets. */
export interface HostToolSet {
	/** Names of the tools this set provides; `execute` is only called with these. */
	readonly names: readonly string[];
	definitions(sessionId: string): HostToolDefinition[];
	execute(call: HostToolCall): Promise<HostToolResult>;
}

/**
 * The runtime's single `HostToolProvider`, composed of per-feature sets. Every OMP runtime the node starts gets the union
 * of the registered sets' tools (`AgentRuntime.setHostToolProvider(registry)` once; sets may be added later and reach
 * sessions at their next `refreshHostTools`/(re)start).
 */
export class HostToolRegistry implements HostToolProvider {
	private readonly sets: HostToolSet[] = [];

	register(set: HostToolSet): void {
		const taken = set.names.find((name) => this.sets.some((existing) => existing.names.includes(name)));
		if (taken !== undefined) throw new Error(`Host tool "${taken}" is already provided by another set`);
		this.sets.push(set);
	}

	definitions(sessionId: string): HostToolDefinition[] {
		return this.sets.flatMap((set) => set.definitions(sessionId));
	}

	async execute(call: HostToolCall): Promise<HostToolResult> {
		const owner = this.sets.find((set) => set.names.includes(call.toolName));
		if (!owner) return { text: `Unknown tool ${call.toolName}`, isError: true };
		return owner.execute(call);
	}
}
