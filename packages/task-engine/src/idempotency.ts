import { createHash } from "node:crypto";

export const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;

export function requestHash(method: string, path: string, bodyBytes: Uint8Array | string): string {
	return createHash("sha256")
		.update(`${method.toUpperCase()}\n${path}\n`)
		.update(bodyBytes)
		.digest("hex");
}

export function evaluateIdempotency(existing: { requestHash: string } | undefined, hash: string): "miss" | "replay" | "conflict" {
	if (!existing) return "miss";
	return existing.requestHash === hash ? "replay" : "conflict";
}
