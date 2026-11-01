import type { TurnOutputFile, TurnOutputs } from "@clam/contracts";

/** Distinct files the agent created or changed in this session, newest first (a later turn's entry replaces an earlier one's). */
export function changedFiles(outputs: readonly TurnOutputs[]): TurnOutputFile[] {
	const byPath = new Map<string, TurnOutputFile>();
	for (const o of outputs) for (const f of o.files) byPath.set(f.path, f);
	return [...byPath.values()].sort((a, b) => b.modifiedAt - a.modifiedAt);
}
