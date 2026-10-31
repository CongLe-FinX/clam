export type ApprovalMode = "always-ask" | "always-ask-cached" | "write" | "yolo";

const STRICTNESS: Record<ApprovalMode, number> = { "always-ask": 3, "always-ask-cached": 2, write: 1, yolo: 0 };

/** The stricter of the node's mode and the requested one; never looser than the node. */
export function strictestApprovalMode(nodeMode: ApprovalMode, requested?: ApprovalMode | null): ApprovalMode {
	if (!requested) return nodeMode;
	return STRICTNESS[requested] > STRICTNESS[nodeMode] ? requested : nodeMode;
}
