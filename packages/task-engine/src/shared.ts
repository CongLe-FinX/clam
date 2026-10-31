import { z } from "zod";
import type { HostToolSpec } from "./host-tools.ts";
import { formatAuthor, buildMeshMessage, MESH_MARKER, type InjectionAuthor } from "./injection.ts";
import type { GroupMessageKind } from "./group.ts";
import { AGENT_MESSAGE_LIMIT, type MessageKind } from "./messages.ts";

/**
 * Text and tool definitions of shared sessions (docs/shared-sessions.md): the briefing a joining agent receives, the
 * framing of discussion messages injected into agent sessions, the continuation note after a takeover and the two host
 * tools (`mesh_team`, `mesh_say`). Pure functions; the server decides when to use them.
 */

export const SHARED_HOST_TOOLS = ["mesh_team", "mesh_say"] as const;

export const SHARED_HOST_TOOL_DEFINITIONS: readonly HostToolSpec[] = [
	{
		name: "mesh_team",
		label: "Mesh: shared session team",
		description:
			"Show the shared session this session belongs to: its title, the shared git branch, who drives it (the driver's agent does the work) and the participants with their role and node status (online/offline), plus the last checkpoint (commit and whether a session snapshot exists). Only available in sessions that belong to a shared session. Takes no arguments.",
		parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
		loadMode: "essential",
	},
	{
		name: "mesh_say",
		label: "Mesh: say in shared session",
		description: `Post a message to the group chat of the shared session in the middle of a turn (the final text of each turn is posted automatically, do not repeat it here). Every member node stores it. It wakes another agent only if the text mentions it: @AgentName, @NodeName (that node's agent) or @all; a message without a mention is shown to everyone and wakes nobody. A woken agent sees it as a message beginning ${MESH_MARKER}. kind: 'question' (ask), 'answer' (reply to a question), 'note' (FYI, default), 'instruction' (only the lead may instruct). After a question that mentions someone END YOUR TURN: the answer arrives as a new message. Loop guard: each node's agents may post at most ${AGENT_MESSAGE_LIMIT} messages that wake another agent until a human writes in the group; be concise and only post when it moves the work forward. Only available in sessions that belong to a shared session.`,
		parameters: {
			type: "object",
			properties: {
				text: { type: "string", description: "Message text (max 20000 chars)." },
				kind: { type: "string", enum: ["question", "answer", "note", "instruction"], description: "Message kind, default 'note'." },
			},
			required: ["text"],
			additionalProperties: false,
		},
		loadMode: "essential",
	},
];

export type SharedHostToolCall = { name: "mesh_team"; args: Record<string, never> } | { name: "mesh_say"; args: { text: string; kind: MessageKind } };

const SCHEMAS = {
	mesh_team: z.object({}).strict(),
	mesh_say: z
		.object({
			text: z
				.string({ error: "mesh_say: text is required and must be a string" })
				.trim()
				.min(1, "mesh_say: text must not be empty")
				.max(20000, "mesh_say: text must be at most 20000 characters"),
			kind: z.enum(["question", "answer", "note", "instruction"], { error: "mesh_say: kind must be one of question, answer, note, instruction" }).default("note"),
		})
		.strict(),
} as const;

export function parseSharedHostToolCall(name: string, raw: unknown): { ok: true; call: SharedHostToolCall } | { ok: false; error: string } {
	if (!Object.hasOwn(SCHEMAS, name)) return { ok: false, error: `unknown tool '${name}'; available: ${Object.keys(SCHEMAS).join(", ")}` };
	const key = name as keyof typeof SCHEMAS;
	const parsed = SCHEMAS[key].safeParse(raw === undefined || raw === null ? {} : raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		let message = issue?.message ?? "invalid arguments";
		if (issue?.code === "unrecognized_keys") message = `${name}: unknown argument(s) ${issue.keys.join(", ")}`;
		else if (issue && !message.startsWith(name)) {
			const field = issue.path.join(".");
			message = `${name}: ${field ? `${field}: ` : ""}${message}`;
		}
		return { ok: false, error: message };
	}
	return { ok: true, call: { name: key, args: parsed.data } as SharedHostToolCall };
}

/** What an agent session of a group chat is told about how a message reached it. */
export interface SharedInjectionInput {
	sharedSessionId: string;
	title: string;
	author: InjectionAuthor;
	kind: GroupMessageKind;
	text: string;
	/** The local agent's seat: the lead edits code and drives the shared branch, a participant helps from its own clone. */
	role: "driver" | "participant";
	/** What the group said that was not addressed to this agent since its last addressed turn (`buildSinceLastTurnBlock`). */
	sinceLastTurn?: string | null;
	/** A participant agent woken because the lead cannot be reached: the lead's node (it must not edit the shared branch). */
	leadOffline?: { nodeName: string } | null;
}

/** A group message addressed to this agent as it receives it (see `buildMeshMessage`); `ref` is `shared session <id>`. */
export function buildSharedMessageInjection(i: SharedInjectionInput): string {
	const who = i.role === "driver" ? "you are the lead: the work on the shared branch happens in this session" : "the lead agent does the main work, you help from your own clone";
	const posting = "The final text of your turn is posted to the group automatically; use mesh_say only in the middle of a turn. To wake another agent, write an at-sign right before its agent name or node name (or before the word all, for everybody) in your text; without a mention nobody is woken.";
	const reminder =
		i.kind === "question"
			? `This is a question to you: answer it in your final text; ${who}. ${posting}`
			: i.kind === "instruction"
				? `Carry it out; ${who}. ${posting}`
				: `It is addressed to you in the group chat; ${who}. ${posting}`;
	const offline = i.leadOffline
		? `\nThe lead (${i.leadOffline.nodeName}) is offline right now, so this message was routed to you instead. You may answer, plan and review, but do NOT edit, commit or push code on the shared branch: only the lead edits it. If the work must continue here, a human has to take over on this node (then this agent becomes the lead).`
		: "";
	return buildMeshMessage({ ref: `shared session ${i.sharedSessionId}`, title: i.title, author: i.author, kind: i.kind, text: i.text, reminder: `${reminder}${offline}`, ...(i.sinceLastTurn ? { before: `${i.sinceLastTurn}\n\nAddressed to you now:` } : {}) });
}

/** Header of `buildSharedMessageInjection` text, for the UI to recognise a group message in a transcript. */
export function parseSharedInjectionHeader(text: string): { sharedSessionId: string; title: string; from: string; kind: GroupMessageKind } | null {
	const first = text.split("\n", 1)[0] ?? "";
	const match = first.match(/^\[CL Agent Mesh\] shared session (\S+) · "(.*)" · from (\S+) · kind (chat|reply|instruction|question|answer|note)$/);
	if (!match) return null;
	return { sharedSessionId: match[1] as string, title: match[2] as string, from: match[3] as string, kind: match[4] as GroupMessageKind };
}

export interface SharedBriefInput {
	sharedSessionId: string;
	title: string;
	goal: string;
	driver: { agentName: string | null; nodeName: string };
	/** The agent being briefed and its node. */
	self: { agentName: string | null; nodeName: string };
	repo: { url: string; branch: string };
	/** Other participants (agent@node) besides the driver and self. */
	others: string[];
	agentMessageLimit: number;
}

/** First prompt of a participant agent session. Asks for a one-line acknowledgement so joining costs one tiny turn. */
export function buildSharedBrief(i: SharedBriefInput): string {
	const L: string[] = [`# Shared session: ${i.title}`, "", `Shared session id: ${i.sharedSessionId}`];
	L.push(`You are: ${i.self.agentName ?? "agent"}@${i.self.nodeName} — a PARTICIPANT agent.`);
	L.push(`Driver: ${i.driver.agentName ?? "agent"}@${i.driver.nodeName} (their agent does the main work in its own session)`);
	if (i.others.length > 0) L.push(`Other participants: ${i.others.join(", ")}`);
	L.push("", "## Goal", "", i.goal.trim() || i.title, "", "## Repository", "", `- Repo: ${i.repo.url}`, `- Shared branch: ${i.repo.branch} (the driver commits checkpoints there; do not commit to it yourself)`);
	L.push("- You are NOT the lead: you may answer, plan, review and try things in your own clone of the repository on this node, but you must not edit, commit or push the shared branch: only the lead's checkpoints go there, and what you change here stays local unless you are asked to deliver it. Only a takeover or hand-over (done by a human) makes this node the lead.");
	L.push("", "## Working in the group chat", "");
	L.push(
		"- This shared session is a GROUP CHAT: the owner (a human, from any node) and one agent per node talk in one timeline that every node keeps a copy of. Your own session here is your private workspace.",
		"- The final text of EVERY turn you finish is posted to the group automatically, as your reply. Use `mesh_say` only for a message in the middle of a turn or a question (kind question | answer | note; only the lead may instruct).",
		"- To wake another agent, mention it in the text: `@AgentName`, `@NodeName` (that node's agent) or `@all`. A message without a mention is shown to everyone and wakes nobody; a human's message without a mention goes to the lead (to the agent of the node it was written on while the lead's node is offline).",
		`- Messages addressed to you arrive as new messages starting with \`${MESH_MARKER} shared session ${i.sharedSessionId}\`. What the group said that was not for you is put in front of your next addressed turn under "Since your last turn in the group:".`,
		"- `mesh_team` shows the team, the lead, their node status and the last checkpoint.",
		`- Loop guard: at most ${i.agentMessageLimit} messages from your node's agents that wake another agent until a human writes in the group. Be concise.`,
		"- If the driver's node goes offline, a human may continue the work on this node from the last checkpoint; you would then receive a continuation note. The group keeps working as long as one node is online.",
		"",
		"Reply with ONE short sentence in THIS session acknowledging that you joined (this acknowledgement is not posted to the group, and do NOT post it with mesh_say: the team does not need it), then end your turn. Do not start any work until the group asks you to.",
	);
	return L.join("\n");
}

export interface ContinuationInput {
	sharedSessionId: string;
	title: string;
	/** The node that drove before and the node continuing now. */
	from: { nodeName: string; agentName: string | null };
	to: { nodeName: string; agentName: string | null };
	epoch: number;
	reason: "takeover" | "transfer";
	checkpoint: { seq: number; at: string; commit: string | null; pushed: boolean } | null;
	branch: string;
	/** The commit the working tree was put on, when known. */
	headCommit: string | null;
	/** Why the working tree is not exactly at the checkpoint, when so (for example "the branch tip is newer than the snapshot"). */
	treeNote: string | null;
	/** Digest of the former driver's work after the checkpoint (`buildPostCheckpointDigest`), when there is any. */
	afterCheckpoint?: string | null;
	/** Transfer only: the former driver aborted a running turn to hand over. */
	interrupted?: boolean;
}

/** The prompt that opens the continued session on the node that took over: where it stands and what may be missing. */
export function buildContinuationNote(i: ContinuationInput): string {
	const where = i.checkpoint ? `checkpoint ${i.checkpoint.seq} (${i.checkpoint.commit ? `commit ${i.checkpoint.commit.slice(0, 12)}` : "no commit"}${i.checkpoint.pushed ? "" : ", not pushed"}, taken ${i.checkpoint.at})` : "the last session snapshot";
	const head = `${MESH_MARKER} shared session ${i.sharedSessionId} · "${i.title.replace(/\s+/g, " ").replace(/"/g, "'").trim()}" · driver changed (epoch ${i.epoch})`;
	const L = [head, ""];
	if (i.reason === "transfer") {
		L.push(
			`The driver role was handed over to this node (${i.to.nodeName}) by ${i.from.agentName ?? "agent"}@${i.from.nodeName}. Continuing from ${where}.`,
			`That checkpoint was taken at the hand-over: it contains ALL of ${i.from.nodeName}'s work, every file change is committed on the branch and the conversation above is complete. Nothing is missing.`,
		);
		if (i.interrupted) L.push(`${i.from.nodeName} stopped a running turn for the hand-over, so its last step may have been cut off: look at the last messages above and at the working tree before you carry on.`);
	} else {
		L.push(`Continuing on ${i.to.nodeName} from ${where}. ${i.from.nodeName} did not hand over (it was unreachable) — work done there after that checkpoint may be missing: uncommitted edits, unpushed commits and everything after ${i.checkpoint?.at ?? "the checkpoint"}.`);
	}
	L.push(`The working tree is on branch ${i.branch}${i.headCommit ? ` at ${i.headCommit.slice(0, 12)}` : ""}.`);
	if (i.treeNote) L.push(i.treeNote);
	if (i.afterCheckpoint) {
		const cp = i.checkpoint;
		const label = cp ? `checkpoint ${cp.seq}${cp.commit ? ` (commit ${cp.commit.slice(0, 12)})` : ""}` : "the last snapshot";
		L.push(
			"",
			`--- What ${i.from.nodeName}'s agent did after ${label} ---`,
			`This is a digest of the former driver's conversation after the snapshot you are continuing from (the conversation above stops at ${label}). The file changes it made after ${cp?.commit ? `commit ${cp.commit.slice(0, 12)}` : "that checkpoint"} are NOT in this working tree${cp && !cp.pushed ? "; that checkpoint was never pushed either, so even its own commit may be missing" : " unless they were pushed to the branch"}. Treat it as information on what was attempted, and verify the files before relying on it.`,
			"",
			i.afterCheckpoint,
			"--- end ---",
		);
	}
	L.push(
		"",
		"You are now the DRIVER of this shared session: your session does the work, and the other nodes mirror it. Continue the work the conversation above was doing: check the working tree and the recent git log against it, then carry on with the task. Talk to the team with `mesh_say` and look at it with `mesh_team`.",
	);
	return L.join("\n");
}

/** The part of a transcript message the digest reads (a structural subset of the UI message, so this package needs no server types). */
export interface DigestMessage {
	role: string;
	content: readonly { type: string; text?: string; id?: string; name?: string; arguments?: unknown; intent?: string }[];
	toolCallId?: string;
	isError?: boolean;
}

export interface PostCheckpointDigestOptions {
	/**
	 * How many messages of the transcript the snapshot already holds (`Checkpoint.snapshot.messageCount`). The transcript is
	 * ordered and the snapshot holds its first `snapshotMessages`, so the tail is the messages at positions >= that count.
	 * Null/undefined: the boundary is unknown and there is no digest.
	 */
	snapshotMessages: number | null | undefined;
	maxMessageChars?: number;
	maxTotalChars?: number;
	maxIntentChars?: number;
	maxResultChars?: number;
}

const DIGEST_MESSAGE_CHARS = 1500;
const DIGEST_TOTAL_CHARS = 10_000;
const DIGEST_INTENT_CHARS = 120;
const DIGEST_RESULT_CHARS = 200;

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function textOf(message: DigestMessage): string {
	return message.content
		.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : []))
		.join("\n")
		.trim();
}

/** A short intent for a tool call: its own `intent`, else the path/command/query-like argument, else the first string argument. */
function toolIntent(block: DigestMessage["content"][number], max: number): string {
	const args: unknown = block.arguments;
	const values = typeof args === "object" && args !== null ? Object.values(args) : [];
	const named = typeof args === "object" && args !== null ? ["path", "file_path", "command", "cmd", "pattern", "query", "url", "task"].map((key) => Reflect.get(args, key)) : [];
	const pick = [...named, ...values].find((v): v is string => typeof v === "string" && v.trim() !== "");
	return clip((block.intent?.trim() || pick?.trim() || "").replace(/\s+/g, " "), max);
}

/**
 * What the driver did after its last snapshot, for the continuation note. Boundary: the mirror transcript is ordered and the
 * snapshot holds its first `snapshotMessages` messages (both count UI messages: the snapshot count is the driving session's
 * message total when the snapshot was taken, the mirror stores the same UI messages by position), so the tail is
 * `messages.slice(snapshotMessages)`. Returns null when there is no tail. Oldest first: user and assistant text verbatim
 * (capped per message), thinking left out, tool calls as `name(intent): result`. Over the total cap the most recent items
 * are kept and the number of earlier messages dropped is stated.
 */
export function buildPostCheckpointDigest(messages: readonly DigestMessage[], options: PostCheckpointDigestOptions): string | null {
	const from = options.snapshotMessages;
	if (from == null || !Number.isFinite(from) || from < 0 || messages.length <= from) return null;
	const tail = messages.slice(from);
	const messageMax = options.maxMessageChars ?? DIGEST_MESSAGE_CHARS;
	const totalMax = options.maxTotalChars ?? DIGEST_TOTAL_CHARS;
	const intentMax = options.maxIntentChars ?? DIGEST_INTENT_CHARS;
	const resultMax = options.maxResultChars ?? DIGEST_RESULT_CHARS;
	const results = new Map<string, DigestMessage>();
	for (const m of tail) if (m.role === "toolResult" && m.toolCallId) results.set(m.toolCallId, m);
	const entries: string[] = [];
	for (const m of tail) {
		if (m.role === "user" || m.role === "assistant") {
			const lines: string[] = [];
			const text = textOf(m);
			if (text) lines.push(`${m.role === "user" ? "User" : "Agent"}: ${clip(text, messageMax)}`);
			for (const block of m.content) {
				if (block.type !== "toolCall" || !block.name) continue;
				const result = block.id ? results.get(block.id) : undefined;
				let outcome = "no result recorded";
				if (result) {
					const first = clip(textOf(result).split("\n").find((l) => l.trim() !== "")?.replace(/\s+/g, " ").trim() ?? "", resultMax);
					outcome = result.isError ? `ERROR ${first || "(no message)"}` : first || "ok";
				}
				lines.push(`- ${block.name}(${toolIntent(block, intentMax)}): ${outcome}`);
			}
			if (lines.length > 0) entries.push(lines.join("\n"));
		}
	}
	if (entries.length === 0) return null;
	const kept: string[] = [];
	let size = 0;
	for (const entry of entries.toReversed()) {
		if (kept.length > 0 && size + entry.length + 2 > totalMax) break;
		kept.unshift(kept.length === 0 ? clip(entry, totalMax) : entry);
		size += entry.length + 2;
	}
	const omitted = entries.length - kept.length;
	return `${omitted > 0 ? `(${omitted} earlier message${omitted === 1 ? "" : "s"} omitted)\n\n` : ""}${kept.join("\n\n")}`;
}

/** One line for a participant row: `Agent@Node`. */
export function formatParticipant(p: { agentName: string | null; nodeName: string }): string {
	return formatAuthor({ kind: "agent", agentName: p.agentName, nodeName: p.nodeName });
}
