import type { Readable, Writable } from "node:stream";

export interface CdpEvent {
	method: string;
	params: Record<string, unknown>;
	sessionId: string | undefined;
}

export class CdpError extends Error {
	constructor(
		readonly method: string,
		message: string,
		readonly code: number,
	) {
		super(`${method}: ${message}`);
		this.name = "CdpError";
	}
}

interface Pending {
	method: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

/**
 * Chrome DevTools Protocol over the inherited pipe of `--remote-debugging-pipe`: JSON messages, each terminated by a NUL byte,
 * written to the browser's fd 3 and read from its fd 4. There is no TCP endpoint to protect: only this process holds the pipe.
 * Flattened target sessions: every command may carry a `sessionId`.
 */
export class CdpConnection {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly listeners = new Set<(event: CdpEvent) => void>();
	private readonly closeListeners = new Set<() => void>();
	private buffer = "";
	private closed = false;

	constructor(
		private readonly out: Writable,
		input: Readable,
	) {
		input.setEncoding("utf8");
		input.on("data", (chunk: string) => this.feed(chunk));
		input.on("close", () => this.shutdown());
		input.on("error", () => this.shutdown());
		out.on("error", () => this.shutdown());
	}

	get isClosed(): boolean {
		return this.closed;
	}

	private feed(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const end = this.buffer.indexOf("\0");
			if (end === -1) return;
			const text = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 1);
			if (text) this.dispatch(text);
		}
	}

	private dispatch(text: string): void {
		let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string }; sessionId?: string };
		try {
			message = JSON.parse(text);
		} catch {
			return;
		}
		if (message.id !== undefined) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) pending.reject(new CdpError(pending.method, message.error.message, message.error.code));
			else pending.resolve(message.result ?? {});
			return;
		}
		if (message.method) {
			const event: CdpEvent = { method: message.method, params: message.params ?? {}, sessionId: message.sessionId };
			for (const listener of [...this.listeners]) {
				try {
					listener(event);
				} catch {
					// one listener's failure must not starve the others or kill the read loop
				}
			}
		}
	}

	send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
		if (this.closed) return Promise.reject(new CdpError(method, "browser connection closed", -1));
		const id = this.nextId++;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const timer = setTimeout(() => {
			this.pending.delete(id);
			reject(new CdpError(method, "timed out", -2));
		}, timeoutMs);
		this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
		const payload = JSON.stringify({ id, method, params, ...(sessionId !== undefined && { sessionId }) });
		this.out.write(`${payload}\0`, (error) => {
			if (!error) return;
			const entry = this.pending.get(id);
			if (!entry) return;
			this.pending.delete(id);
			clearTimeout(entry.timer);
			entry.reject(new CdpError(method, error.message, -1));
		});
		return promise;
	}

	on(listener: (event: CdpEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onClose(listener: () => void): void {
		if (this.closed) listener();
		else this.closeListeners.add(listener);
	}

	private shutdown(): void {
		if (this.closed) return;
		this.closed = true;
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new CdpError(pending.method, "browser connection closed", -1));
			this.pending.delete(id);
		}
		for (const listener of [...this.closeListeners]) listener();
		this.closeListeners.clear();
		this.listeners.clear();
	}

	close(): void {
		this.shutdown();
		this.out.destroy();
	}
}
