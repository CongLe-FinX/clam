import type { HandoffRole, HandoffState } from "@clam/contracts";

/** Thrown from `HandoffHub.transition` right after a state became durable when the fault spec matches (test seam). */
export class FaultInjected extends Error {
	readonly code = "fault_injected" as const;
	constructor(readonly point: string) {
		super(`fault injected after persisting ${point}`);
		this.name = "FaultInjected";
	}
}

/**
 * Fault injection for crash tests (docs/handoff-protocol.md §6): `CLAM_FAULT=handoff:<role>:<state>` (also a comma-separated list,
 * `*` as a wildcard for role or state) makes the process exit — or, in-process, throw {@link FaultInjected} and "crash" the handoff
 * service — RIGHT AFTER the matching state was persisted and before any side effect that follows it. Inert unless the variable (or
 * the test seam `HandoffServiceOptions.fault`) is set. Fires at most once per process.
 */
export interface FaultOptions {
	/** `handoff:<role>:<state>[,...]`; default: `process.env.CLAM_FAULT`. */
	spec?: string | undefined;
	/** `exit` (default for the environment variable) ends the process with code 86; `throw` raises {@link FaultInjected} (in-process tests). */
	mode?: "exit" | "throw";
	/** Called with the point just before throwing/exiting (tests use it to know the fault fired). */
	onFire?: (point: string) => void;
}

export class FaultInjector {
	private readonly points: Array<{ role: string; state: string }>;
	private readonly mode: "exit" | "throw";
	private fired = false;

	constructor(private readonly options: FaultOptions = {}) {
		const spec = options.spec ?? process.env.CLAM_FAULT ?? "";
		this.mode = options.mode ?? "exit";
		this.points = spec
			.split(",")
			.map((s) => s.trim())
			.flatMap((s) => {
				const [scope, role, state] = s.split(":");
				return scope === "handoff" && role && state ? [{ role, state }] : [];
			});
	}

	get enabled(): boolean {
		return this.points.length > 0;
	}

	/** True once a fault fired: the node is considered crashed. */
	get crashed(): boolean {
		return this.fired && this.mode === "throw";
	}

	check(role: HandoffRole, state: HandoffState): void {
		if (this.fired || this.points.length === 0) return;
		if (!this.points.some((p) => (p.role === "*" || p.role === role) && (p.state === "*" || p.state === state))) return;
		this.fired = true;
		const point = `${role}:${state}`;
		this.options.onFire?.(point);
		if (this.mode === "exit") process.exit(86);
		throw new FaultInjected(point);
	}
}
