import { TaskStatus } from "@clam/contracts";
import type { TaskStatus as TaskStatusT } from "@clam/contracts";
import type { MessageKind } from "./messages.ts";

export const MESH_MARKER = "[CL Agent Mesh]";

export interface InjectionAuthor {
	kind: "human" | "agent" | "system";
	agentName: string | null;
	nodeName: string;
}

const KINDS: readonly MessageKind[] = ["instruction", "question", "answer", "note"];

export function formatAuthor(a: InjectionAuthor): string {
	if (a.kind === "agent") return `${a.agentName ?? "agent"}@${a.nodeName}`;
	return `${a.kind}@${a.nodeName}`;
}

function flatten(title: string): string {
	return title.replace(/\s+/g, " ").replace(/"/g, "'").trim();
}

/**
 * The generic message a session receives: the header line, the text, one reminder line. `ref` is the thing the message
 * belongs to ("task tsk_…"), so other features (shared sessions) reuse the framing with their own reference.
 */
export function buildMeshMessage(i: { ref: string; title: string; author: InjectionAuthor; kind: string; text: string; reminder: string; before?: string }): string {
	const head = `${MESH_MARKER} ${i.ref} · "${flatten(i.title)}" · from ${formatAuthor(i.author)} · kind ${i.kind}`;
	return `${head}\n\n${i.before ? `${i.before}\n\n` : ""}${i.text}\n\n${i.reminder}`;
}

export function buildMessageInjection(i: {
	taskId: string;
	title: string;
	author: InjectionAuthor;
	kind: MessageKind;
	text: string;
	role: "sender" | "executor";
}): string {
	const reminder =
		i.role === "executor"
			? `Reply with mesh_message (taskId ${i.taskId}); finish with mesh_complete when done.`
			: `Answer or instruct with mesh_message (taskId ${i.taskId}); the delegated task continues on the other node.`;
	return buildMeshMessage({ ref: `task ${i.taskId}`, title: i.title, author: i.author, kind: i.kind, text: i.text, reminder });
}

export function buildStatusNote(i: {
	taskId: string;
	title: string;
	status: TaskStatusT;
	summary?: string | null;
	reason?: string | null;
	branch?: string | null;
	commit?: string | null;
	compareUrl?: string | null;
	pushed?: boolean;
	autoCompleted?: boolean;
	artifacts?: { name: string }[];
}): string {
	const L = [`${MESH_MARKER} task ${i.taskId} · "${flatten(i.title)}" · status ${i.status}`];
	if (i.autoCompleted) L.push("completed automatically (the agent ended its turn without calling mesh_complete)");
	if (i.summary) L.push(`summary: ${i.summary}`);
	if (i.reason) L.push(`reason: ${i.reason}`);
	if (i.branch) L.push(`branch: ${i.branch}${i.commit ? ` @ ${i.commit.slice(0, 12)}` : ""}${i.pushed ? " (pushed)" : ""}`);
	if (i.compareUrl) L.push(`compare: ${i.compareUrl}`);
	if (i.artifacts?.length) L.push(`artifacts: ${i.artifacts.map((a) => a.name).join(", ")}`);
	return L.join("\n");
}

export type InjectionHeader = {
	taskId: string;
	title: string;
	kind: "message" | "status";
	from?: string;
	messageKind?: MessageKind;
	status?: TaskStatusT;
};

const MSG_RE = /^\[CL Agent Mesh\] task (\S+) · "(.*)" · from (\S+) · kind (\w+)$/;
const STATUS_RE = /^\[CL Agent Mesh\] task (\S+) · "(.*)" · status (\w+)$/;

export function parseInjectionHeader(text: string): InjectionHeader | null {
	const first = text.split("\n", 1)[0] ?? "";
	let m = first.match(MSG_RE);
	if (m) {
		const kind = m[4] as MessageKind;
		if (!KINDS.includes(kind)) return null;
		return { taskId: m[1]!, title: m[2]!, kind: "message", from: m[3]!, messageKind: kind };
	}
	m = first.match(STATUS_RE);
	if (m) {
		const st = TaskStatus.safeParse(m[3]);
		if (!st.success) return null;
		return { taskId: m[1]!, title: m[2]!, kind: "status", status: st.data };
	}
	return null;
}

export function deliveryMode(i: { busy: boolean; kind: MessageKind }): "prompt" | "steer" | "followUp" {
	if (!i.busy) return "prompt";
	return i.kind === "instruction" ? "steer" : "followUp";
}
