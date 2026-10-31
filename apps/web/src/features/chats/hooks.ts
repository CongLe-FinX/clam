import type { AgentSession } from "@clam/contracts";
import { useMemo } from "react";
import { useProjects, useSessions } from "@/lib/queries";

/** Sessions that live in a chat folder (Project.origin "chat"), most recently active first. */
export function useChats(): { chats: AgentSession[]; chatProjectIds: Set<string>; isPending: boolean } {
	const projects = useProjects();
	const sessions = useSessions();
	const chatProjectIds = useMemo(() => new Set((projects.data ?? []).filter((p) => p.origin === "chat").map((p) => p.id)), [projects.data]);
	const chats = useMemo(() => (sessions.data ?? []).filter((s) => chatProjectIds.has(s.projectId)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), [sessions.data, chatProjectIds]);
	return { chats, chatProjectIds, isPending: projects.isPending || sessions.isPending };
}
