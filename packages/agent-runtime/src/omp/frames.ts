/**
 * Wire frame shapes of the OMP RPC protocol (`omp --mode rpc`, JSONL over stdio).
 * Only the transport-level frames are typed here; everything else is an opaque event frame.
 */

export interface OmpReadyFrame {
	type: "ready";
	protocolVersion: number;
	supportedProtocolVersions: number[];
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
}

export interface OmpResponseFrame {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
	code?: string;
}

/** Any frame that is not ready/response/rpc_chunk: events, extension_ui_request, prompt_result, session_settled, ... */
export type OmpFrame = { type: string } & Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOmpResponseFrame(frame: unknown): frame is OmpResponseFrame {
	return isRecord(frame) && frame.type === "response" && typeof frame.command === "string";
}

export function isOmpReadyFrame(frame: unknown): frame is OmpReadyFrame {
	return (
		isRecord(frame) &&
		frame.type === "ready" &&
		typeof frame.protocolVersion === "number" &&
		Array.isArray(frame.supportedProtocolVersions) &&
		typeof frame.maxFrameBytes === "number" &&
		typeof frame.maxReassembledFrameBytes === "number"
	);
}
