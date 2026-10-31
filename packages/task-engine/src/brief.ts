import type { MessageKind } from "./messages.ts";

export interface BriefInput {
	taskId: string;
	title: string;
	description: string;
	delegator: { agentName: string | null; nodeName: string };
	executorNodeName: string;
	/** null: a task without a git repository. */
	repo: { url: string; branch: string | null; commit: string | null } | null;
	baseBranch: string | null;
	workBranch: string | null;
	deliverAs: "summary" | "branch" | "files";
	/** Files the sender sent along, already placed in the working folder (paths relative to it). */
	inputFiles?: { paths: string[]; notReplaced?: string[] } | null;
	constraints: { maxCostUsd?: number; deadline?: string; approvalMode?: string };
	priorMessages: { author: string; kind: MessageKind; text: string }[];
	canAskDelegator: boolean;
}

export function buildBrief(i: BriefInput): string {
	const L: string[] = [];
	L.push(`# Delegated task: ${i.title}`, "", `Task id: ${i.taskId}`);
	L.push(`Delegated by: ${i.delegator.agentName ?? "agent"}@${i.delegator.nodeName}`);
	L.push(`Executing on: ${i.executorNodeName}`, "", "## Description", "", i.description, "");
	if (i.repo) {
		L.push("## Repository", "", `- Repo: ${i.repo.url}`);
		if (i.repo.branch) L.push(`- Branch checked out: ${i.repo.branch}`);
		if (i.repo.commit) L.push(`- Commit: ${i.repo.commit}`);
		if (i.baseBranch) L.push(`- Base branch: ${i.baseBranch}`);
		if (i.workBranch) L.push(`- Work branch: ${i.workBranch}`);
	} else {
		L.push("## Working folder", "", "- This task is not tied to a git repository: your session's working directory is the folder to work in.");
		if (i.inputFiles && i.inputFiles.paths.length > 0) {
			const shown = i.inputFiles.paths.slice(0, 40);
			L.push(`- The delegator sent ${i.inputFiles.paths.length} input file(s), already placed in the folder: ${shown.join(", ")}${i.inputFiles.paths.length > shown.length ? `, … (${i.inputFiles.paths.length - shown.length} more)` : ""}.`);
			if (i.inputFiles.notReplaced && i.inputFiles.notReplaced.length > 0) {
				L.push(`- These input files were NOT placed because a different file with that name already exists in the folder: ${i.inputFiles.notReplaced.join(", ")}.`);
			}
		} else {
			L.push("- No input files were sent; the folder may be empty.");
		}
	}
	L.push("", "## Deliverable", "");
	if (i.deliverAs === "branch") {
		L.push(
			`Deliver as: branch${i.workBranch ? ` (${i.workBranch})` : ""}.`,
			"CL Agent Mesh commits and pushes your changes when you finish — do NOT run git commit/push or switch branches yourself. Just edit the files in the working tree.",
		);
	} else if (i.deliverAs === "files") {
		L.push(
			"Deliver as: files. Leave the result files in the working folder (create or edit them there); CL Agent Mesh returns the files you created or changed to the delegator when you finish — do NOT run git commands and do not try to send the files yourself. Mention what you produced in your summary.",
		);
	} else {
		L.push("Deliver as: summary. No git changes expected; answer in your summary.");
	}
	const c: string[] = [];
	if (i.constraints.maxCostUsd !== undefined) c.push(`- Max cost: $${i.constraints.maxCostUsd}`);
	if (i.constraints.deadline) c.push(`- Deadline: ${i.constraints.deadline}`);
	if (i.constraints.approvalMode) c.push(`- Approval mode: ${i.constraints.approvalMode}`);
	if (c.length) L.push("", "## Constraints", "", ...c);
	if (i.priorMessages.length) {
		L.push("", "## Prior discussion", "");
		for (const m of i.priorMessages) L.push(`- ${m.author} (${m.kind}): ${m.text}`);
	}
	L.push("", "## Working with CL Agent Mesh", "");
	if (i.canAskDelegator) {
		L.push(
			`- If you need clarification, ask the delegator with \`mesh_message\` (taskId "${i.taskId}", kind "question") and END YOUR TURN to wait. The answer arrives as a new message beginning \`[CL Agent Mesh]\`.`,
		);
	} else {
		L.push("- You cannot ask the delegator questions right now; make reasonable assumptions and state them in your summary.");
	}
	L.push(
		`- When finished, call \`mesh_complete\` (taskId "${i.taskId}", outcome succeeded|failed|blocked, and a summary of what you did or why you could not).`,
		"- Use `mesh_task` to inspect this task's state and `mesh_agents` to see other nodes.",
	);
	return L.join("\n");
}

export function buildResumePrompt(i: { taskId: string; title: string }): string {
	return `[CL Agent Mesh] The node restarted while you were working on task ${i.taskId} · "${i.title}". Continue the task where you left off and finish with \`mesh_complete\` (taskId "${i.taskId}").`;
}

export function buildCompletionReminder(i: { taskId: string }): string {
	return `[CL Agent Mesh] Your turn ended but task ${i.taskId} is not completed. If the work is done, call \`mesh_complete\` now (taskId "${i.taskId}", outcome and summary). If you are waiting for an answer, ask with \`mesh_message\` kind question and end your turn.`;
}
