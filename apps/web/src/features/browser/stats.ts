/** Live viewer numbers. Also published read-only as `window.__clamBrowserStats` (refreshed every second) for tests. */
export interface BrowserStats {
	/** Frames drawn in the last second. */
	fps: number;
	/** Received frame payload, KB/s. */
	kbps: number;
	/** WebSocket round trip (ping → pong) in ms; null until the first pong. */
	rttMs: number | null;
	/** Mean time from an input message to the next drawn frame (last 20 samples); null until measured. */
	inputToFrameMs: number | null;
	/** Total frames drawn on this viewer. */
	frames: number;
	/** Size of the last drawn frame in pixels. */
	width: number;
	height: number;
}

declare global {
	interface Window {
		__clamBrowserStats?: Readonly<BrowserStats>;
	}
}

const EMPTY: BrowserStats = { fps: 0, kbps: 0, rttMs: null, inputToFrameMs: null, frames: 0, width: 0, height: 0 };
const MAX_INPUT_TO_FRAME_MS = 3000;
const SAMPLES = 20;

class FrameStats {
	private snap: BrowserStats = EMPTY;
	private listeners = new Set<() => void>();
	private users = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private frames = 0;
	private width = 0;
	private height = 0;
	private windowFrames = 0;
	private windowBytes = 0;
	private windowStart = 0;
	private rtt: number | null = null;
	private lastInput = 0;
	private samples: number[] = [];

	subscribe = (l: () => void): (() => void) => {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	};
	getSnapshot = (): BrowserStats => this.snap;

	/** Reference-counted: the viewer calls this on mount and the returned function on unmount. */
	acquire(): () => void {
		if (this.users++ === 0) {
			this.windowStart = performance.now();
			this.timer = setInterval(() => this.publish(), 1000);
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (--this.users === 0) {
				clearInterval(this.timer);
				this.timer = undefined;
				this.reset();
			}
		};
	}

	bytesReceived(n: number): void {
		this.windowBytes += n;
	}
	frameDrawn(width: number, height: number): void {
		this.frames++;
		this.windowFrames++;
		this.width = width;
		this.height = height;
		if (this.lastInput > 0) {
			const dt = performance.now() - this.lastInput;
			this.lastInput = 0;
			if (dt < MAX_INPUT_TO_FRAME_MS) {
				this.samples.push(dt);
				if (this.samples.length > SAMPLES) this.samples.shift();
			}
		}
	}
	inputSent(): void {
		this.lastInput = performance.now();
	}
	roundTrip(ms: number): void {
		this.rtt = ms;
	}

	private publish(): void {
		const now = performance.now();
		const secs = Math.max(0.001, (now - this.windowStart) / 1000);
		const mean = this.samples.length ? this.samples.reduce((a, b) => a + b, 0) / this.samples.length : null;
		this.snap = {
			fps: Math.round((this.windowFrames / secs) * 10) / 10,
			kbps: Math.round((this.windowBytes / 1024 / secs) * 10) / 10,
			rttMs: this.rtt === null ? null : Math.round(this.rtt * 10) / 10,
			inputToFrameMs: mean === null ? null : Math.round(mean * 10) / 10,
			frames: this.frames,
			width: this.width,
			height: this.height,
		};
		this.windowFrames = 0;
		this.windowBytes = 0;
		this.windowStart = now;
		window.__clamBrowserStats = Object.freeze({ ...this.snap });
		for (const l of [...this.listeners]) l();
	}

	private reset(): void {
		this.snap = EMPTY;
		this.frames = this.windowFrames = this.windowBytes = this.width = this.height = 0;
		this.rtt = null;
		this.lastInput = 0;
		this.samples = [];
		delete window.__clamBrowserStats;
		for (const l of [...this.listeners]) l();
	}
}

export const browserStats = new FrameStats();
