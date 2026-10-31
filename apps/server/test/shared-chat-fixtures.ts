import type { AgentSession, Peer, Project, SharedSession } from "@clam/contracts";
import { expect } from "vitest";
import { api, type FullHarness } from "./full-harness.ts";
import { eventually, pair, startNode } from "./net-helpers.ts";
import { grantShare, sharedOn, transcriptTexts, waitForShared, whenSettled } from "./shared-fixtures.ts";

/** Two paired nodes with a plain chat (no project, no git) started on A and joined by B, both agents briefed and idle. */
export interface Chat {
	a: FullHarness;
	b: FullHarness;
	aId: string;
	bId: string;
	sessionA: string;
	sessionB: string;
	shared: SharedSession;
	agentB: { nodeId: string; agentId: string };
	projectA: Project;
	projectB: Project;
}

export async function startChat(): Promise<Chat> {
	const a = await startNode("node-a");
	const b = await startNode("node-b");
	await pair(a, b);
	const aId = a.ctx.identity.nodeId;
	const bId = b.ctx.identity.nodeId;
	await grantShare(a, bId, b);
	await grantShare(b, aId, a);
	expect((await api(b).patch<Peer>(`/network/peers/${aId}`, { autoAcceptTasks: true })).status).toBe(200);
	const session = await api(a).post<AgentSession>("/sessions", { title: "Design chat" });
	expect(session.status, JSON.stringify(session.body)).toBe(201);
	const added = await api(a).post<SharedSession>(`/sessions/${session.body.id}/participants`, { nodeId: bId });
	expect(added.status, JSON.stringify(added.body)).toBe(201);
	const onB = await waitForShared(b, added.body.id, (s) => s.localRole === "participant" && s.mirrorSessionId !== null && s.localProjectId !== null, "B joined");
	await waitForShared(a, added.body.id, (s) => s.participants.some((p) => p.nodeId === bId && p.state === "active"), "A sees B active");
	const shared = await sharedOn(a, added.body.id);
	const partOf = (s: SharedSession, nodeId: string) => s.participants.find((p) => p.nodeId === nodeId) as SharedSession["participants"][number];
	const sessionB = partOf(onB, bId).agentSessionId as string;
	await eventually(async () => (await transcriptTexts(b, sessionB)).some((t) => t.startsWith("FAKE: # Shared session")), "B's agent to acknowledge the briefing");
	await whenSettled(b, sessionB);
	await whenSettled(a, session.body.id);
	return {
		a,
		b,
		aId,
		bId,
		sessionA: session.body.id,
		sessionB,
		shared,
		agentB: { nodeId: bId, agentId: partOf(shared, bId).agentId as string },
		projectA: (await api(a).get<Project>(`/projects/${session.body.projectId}`)).body,
		projectB: (await api(b).get<Project>(`/projects/${onB.localProjectId}`)).body,
	};
}


export async function stopChat(chat: Chat): Promise<void> {
	await chat.a.cleanup();
	await chat.b.cleanup();
}
