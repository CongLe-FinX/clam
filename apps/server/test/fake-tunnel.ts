import type { TunnelManager, TunnelRunConfig, TunnelRuntimeState } from "@clam/cloudflare-tunnel";

/** A tunnel manager that never spawns cloudflared: the test decides which public URL "the tunnel" gets. */
export class FakeTunnelManager implements TunnelManager {
	readonly starts: TunnelRunConfig[] = [];
	disposed = false;
	url: string | null = null;
	private current: TunnelRuntimeState = { state: "stopped", mode: "off", publicUrl: null, pid: null, connections: 0, lastError: null, startedAt: null };
	private readonly listeners = new Set<(s: TunnelRuntimeState) => void>();

	private set(patch: Partial<TunnelRuntimeState>): void {
		this.current = { ...this.current, ...patch };
		for (const listener of [...this.listeners]) listener(this.current);
	}

	async start(config: TunnelRunConfig): Promise<TunnelRuntimeState> {
		this.starts.push(config);
		this.set({ state: "running", mode: config.mode, publicUrl: this.url, pid: 4242, connections: 4, startedAt: new Date().toISOString(), lastError: null });
		return this.current;
	}

	async stop(): Promise<TunnelRuntimeState> {
		this.set({ state: "stopped", mode: "off", publicUrl: null, pid: null, connections: 0, startedAt: null });
		return this.current;
	}

	/** The tunnel restarted and got a new address. */
	changeUrl(url: string | null): void {
		this.url = url;
		this.set({ publicUrl: url });
	}

	state(): TunnelRuntimeState {
		return this.current;
	}

	onChange(listener: (s: TunnelRuntimeState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
	}
}
