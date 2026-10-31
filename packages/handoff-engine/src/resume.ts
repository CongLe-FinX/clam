import type { HandoffManifest } from "./manifest.ts";

export interface SetupReport {
	/** Commands that ran, with their outcome. */
	ran: Array<{ command: string; exitCode: number | null; timedOut?: boolean }>;
	/** Commands that did not run (denied, already done, not needed) and why. */
	skipped: Array<{ command: string; reason: string }>;
	/** Runtime problems found by `checkRuntimes` (missing/mismatched tools), human-readable. */
	runtimeIssues?: string[];
	/** Result of workspace validation (step 6), e.g. "HEAD matches, 3 required files present". */
	validation?: string;
}

export interface ResumeLocalPaths {
	/** Folder the new session works in. */
	workDir: string;
	/** Where restored context files / the plan live, if different from `workDir`. */
	contextDir?: string;
	/** Unpacked old transcript (reference only), when the source opted in. */
	transcriptPath?: string;
}

const STATUS_MARK: Record<string, string> = { completed: "x", done: "x", in_progress: "~", pending: " " };

/**
 * First prompt of the NEW local session on the target (docs §4 step 10, §9). The old runtime session is
 * never continued; this prompt carries what the work needs: task, plan, remaining TODOs, summary, where the
 * files are, what setup ran or was skipped.
 */
export function buildResumePrompt(manifest: HandoffManifest, ctx: { localPaths: ResumeLocalPaths; setupReport: SetupReport }): string {
	const { task } = manifest;
	const out: string[] = [];
	out.push(
		`# Continuing handed-over work: ${task.title}`,
		"",
		`This is a NEW session on node "${manifest.target.name}". The task was in progress on node "${manifest.source.name}" and was handed over to you` +
			` (handoff ${manifest.handoffId}, ownership epoch ${manifest.fromEpoch} → ${manifest.toEpoch}). You now own it; the source node has released it.` +
			" You do NOT have the previous session's conversation or tool history — rely on this brief and the files on disk, and verify before assuming.",
		"",
		"## Task",
		task.description.trim() === "" ? "(no description)" : task.description.trim(),
		"",
		`Deliver as: ${task.deliverAs}.`,
	);

	if (task.acceptanceCriteria.length > 0) {
		out.push("", "### Acceptance criteria", ...task.acceptanceCriteria.map((c) => `- ${c}`));
	}

	const plan = [task.plan.text?.trim(), task.plan.planPath ? `Plan file: ${task.plan.planPath}` : null].filter((p): p is string => !!p);
	if (plan.length > 0) out.push("", "## Plan", ...plan);

	out.push("", "## Remaining work");
	if (task.remaining.length > 0) out.push(...task.remaining.map((r) => `- [ ] ${r}`));
	else if (task.todos.length === 0) out.push("(none recorded — review the files and the summary to decide what is left)");
	if (task.todos.length > 0) {
		out.push("", "### TODO list at handoff time");
		let phase: string | undefined;
		for (const todo of task.todos) {
			if (todo.phase !== undefined && todo.phase !== phase) {
				phase = todo.phase;
				out.push(`**${phase}**`);
			}
			out.push(`- [${STATUS_MARK[todo.status] ?? " "}] ${todo.content}`);
		}
	}

	const summary = manifest.conversationSummary.text.trim();
	out.push("", "## Summary of the work so far", summary === "" ? "(no summary provided)" : summary);
	if (manifest.execution?.lastToolSummary) out.push("", `Last tool activity on the source: ${manifest.execution.lastToolSummary}`);

	out.push("", "## Where things are", `- Work folder: ${ctx.localPaths.workDir}`);
	if (ctx.localPaths.contextDir) out.push(`- Restored context: ${ctx.localPaths.contextDir}`);
	if (manifest.vcs === "git" && manifest.git) {
		out.push(`- Files came from git: branch ${manifest.git.branch} at commit ${manifest.git.commit}${manifest.git.patchArtifact ? " plus the uncommitted patch of the source" : ""}.`);
	} else if (manifest.vcs === "files" && manifest.files) {
		out.push(`- Files were restored from a folder bundle (${manifest.files.fileCount} files); this folder is not a git repository.`);
	} else {
		out.push("- No project files were handed over (nothing to restore).");
	}
	if (ctx.localPaths.transcriptPath) out.push(`- Old transcript (read-only reference, never continue it): ${ctx.localPaths.transcriptPath}`);
	if (manifest.contexts.length > 0) out.push(`- Shared context documents restored: ${manifest.contexts.map((c) => `${c.id}@v${c.version}`).join(", ")}`);

	const { setupReport: report } = ctx;
	out.push("", "## Environment setup on this node");
	if (report.ran.length === 0 && report.skipped.length === 0) out.push("- No setup commands were needed.");
	for (const r of report.ran) {
		const outcome = r.timedOut ? "timed out" : r.exitCode === 0 ? "succeeded" : `exited with ${r.exitCode ?? "no exit code"}`;
		out.push(`- Ran \`${r.command}\`: ${outcome}`);
	}
	for (const s of report.skipped) out.push(`- Skipped \`${s.command}\`: ${s.reason}`);
	for (const issue of report.runtimeIssues ?? []) out.push(`- Runtime issue: ${issue}`);
	if (report.validation) out.push(`- Validation: ${report.validation}`);
	if (manifest.environment.requiredEnvVars.length > 0) {
		out.push(`- Environment variables the project expects (names only; set them locally if needed): ${manifest.environment.requiredEnvVars.join(", ")}`);
	}

	out.push(
		"",
		"## How to proceed",
		"Start by checking the current state of the work folder, then continue with the remaining work above. Do not redo completed items. Report progress and results as usual for this task.",
	);
	return out.join("\n");
}
