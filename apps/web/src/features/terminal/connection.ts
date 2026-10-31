import { TERMINAL_CLOSE, TERMINAL_WS_PATH, type TerminalServerMessage, type TerminalSession } from "@clam/contracts";

/**
 * - `connecting`: opening the socket / receiving the scrollback replay
 * - `live`: attached and streaming
 * - `reconnecting`: the socket dropped; retrying with backoff (the shell keeps running on the machine)
 * - `ended`: the terminal was closed or no longer exists
 * - `denied`: this browser's session ended or the machine's remote Terminal was switched off
 */
export type ConnectionState = "connecting" | "live" | "reconnecting" | "ended" | "denied";

export interface ConnectionHandlers {
	/** First frame after (re)attach: the screen must be reset, the replay follows as bytes. */
	onAttached(session: TerminalSession, replayBytes: number): void;
	onBytes(bytes: Uint8Array): void;
	onLive(): void;
	onExit(exitCode: number | null, signal: number | null): void;
	onSession(session: TerminalSession): void;
	onState(state: ConnectionState): void;
	/** Connecting failed before the socket ever opened (refused, offline, gate): the page re-checks why. */
	onRefused(): void;
}

const encoder = new TextEncoder();
const MAX_BACKOFF_MS = 8_000;

const socketUrl = (id: string): string => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${TERMINAL_WS_PATH(id)}`;

/** One browser's attachment to one terminal: binary frames carry bytes both ways, small JSON frames carry control. */
export class TerminalConnection {
	private socket: WebSocket | null = null;
	private attempts = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;
	private opened = false;
	private state: ConnectionState = "connecting";

	constructor(
		private readonly id: string,
		private readonly handlers: ConnectionHandlers,
	) {}

	start(): void {
		this.open();
	}

	private setState(next: ConnectionState): void {
		if (this.state === next) return;
		this.state = next;
		this.handlers.onState(next);
	}

	private open(): void {
		if (this.disposed) return;
		this.opened = false;
		const socket = new WebSocket(socketUrl(this.id));
		socket.binaryType = "arraybuffer";
		this.socket = socket;
		socket.onopen = () => {
			this.opened = true;
		};
		socket.onmessage = (event) => {
			if (event.data instanceof ArrayBuffer) {
				this.handlers.onBytes(new Uint8Array(event.data));
				return;
			}
			let message: TerminalServerMessage;
			try {
				message = JSON.parse(String(event.data)) as TerminalServerMessage;
			} catch {
				return;
			}
			switch (message.type) {
				case "attached":
					this.attempts = 0;
					this.handlers.onAttached(message.session, message.replayBytes);
					break;
				case "live":
					this.setState("live");
					this.handlers.onLive();
					break;
				case "exit":
					this.handlers.onExit(message.exitCode, message.signal);
					break;
				case "session":
					this.handlers.onSession(message.session);
					break;
				default:
					break;
			}
		};
		socket.onclose = (event) => {
			if (this.socket !== socket) return;
			this.socket = null;
			if (this.disposed) return;
			if (event.code === TERMINAL_CLOSE.removed) return this.setState("ended");
			if (event.code === TERMINAL_CLOSE.sessionEnded) return this.setState("denied");
			if (!this.opened) this.handlers.onRefused();
			this.setState("reconnecting");
			this.schedule();
		};
	}

	private schedule(): void {
		if (this.timer || this.disposed) return;
		const wait = Math.min(250 * 2 ** this.attempts, MAX_BACKOFF_MS);
		this.attempts += 1;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.open();
		}, wait);
	}

	/** Try again now (after the owner re-entered the password, or the network came back). */
	retryNow(): void {
		if (this.disposed || this.socket) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.attempts = 0;
		this.setState("connecting");
		this.open();
	}

	/** Keystrokes / paste as UTF-8. */
	sendText(text: string): void {
		this.sendBytes(encoder.encode(text));
	}

	sendBytes(bytes: Uint8Array): void {
		if (this.socket?.readyState === WebSocket.OPEN && this.state === "live") this.socket.send(bytes);
	}

	resize(cols: number, rows: number): void {
		if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "resize", cols, rows }));
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			socket.onclose = null;
			socket.onmessage = null;
			socket.close(1000);
		}
	}
}
