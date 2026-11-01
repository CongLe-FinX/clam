import type { Handoff, HandoffFailureCode, HandoffState, HandoffStep } from "@clam/contracts";
import type { BadgeVariant } from "@/features/tasks/format.ts";
import { type Msg, msg, t, tr } from "@/i18n";
import { formatDuration } from "@/lib/utils";

export const STATE_META: Record<HandoffState, { label: Msg; variant: BadgeVariant }> = {
	draft: { label: msg("Draft"), variant: "neutral" },
	preparing: { label: msg("Preparing"), variant: "accent" },
	prepare_failed: { label: msg("Preparation failed"), variant: "danger" },
	offered: { label: msg("Offered"), variant: "warning" },
	accepted: { label: msg("Accepted"), variant: "accent" },
	awaiting_ack: { label: msg("Waiting for ack"), variant: "accent" },
	ack_timeout: { label: msg("Ack timed out"), variant: "danger" },
	acked: { label: msg("Acknowledged"), variant: "success" },
	released: { label: msg("Released"), variant: "success" },
	completed: { label: msg("Completed"), variant: "success" },
	rejected: { label: msg("Rejected"), variant: "danger" },
	expired: { label: msg("Expired"), variant: "neutral" },
	cancelled: { label: msg("Cancelled"), variant: "neutral" },
	reclaimed: { label: msg("Reclaimed"), variant: "neutral" },
	failed: { label: msg("Failed"), variant: "danger" },
	received: { label: msg("Received"), variant: "warning" },
	persisted: { label: msg("Saved"), variant: "accent" },
	files_restored: { label: msg("Files restored"), variant: "accent" },
	context_restored: { label: msg("Context restored"), variant: "accent" },
	deps_ready: { label: msg("Dependencies ready"), variant: "accent" },
	validated: { label: msg("Validated"), variant: "accent" },
	session_created: { label: msg("Session created"), variant: "accent" },
	owner: { label: msg("Owner"), variant: "success" },
	resumed: { label: msg("Resumed"), variant: "success" },
};

export const stateLabel = (s: HandoffState): string => tr(STATE_META[s].label);

/** Plain-English explanation and the recommended next move for each failure code. */
export const FAILURE_TEXT: Record<HandoffFailureCode, { title: Msg; body: Msg; advice: Msg }> = {
	git_unavailable: {
		title: msg("Git is not available"),
		body: msg("The target machine could not use Git, or could not reach the repository, so the files could not be restored."),
		advice: msg("Install Git and connect a GitHub account on the target machine, then retry."),
	},
	checkout_conflict: {
		title: msg("Local changes are in the way"),
		body: msg("The target checkout has uncommitted changes that conflict with the handed-over branch. Nothing was overwritten."),
		advice: msg("Commit or stash the changes on the target (or accept into a different project), then retry."),
	},
	patch_failed: {
		title: msg("The uncommitted work could not be applied"),
		body: msg("The branch was restored, but the attached patch with the source's uncommitted changes does not apply cleanly."),
		advice: msg("Retry after cleaning the target checkout, or cancel and hand off again once the source has committed its work."),
	},
	files_conflict: {
		title: msg("Files conflict with the target folder"),
		body: msg("The target folder already contains different versions of some files in the bundle. Nothing was overwritten."),
		advice: msg("Choose an empty project on the target, or move the conflicting files away, then retry."),
	},
	deps_failed: {
		title: msg("Dependency setup failed"),
		body: msg("An install or setup command failed on the target. The output is shown in the setup panel."),
		advice: msg("Fix the cause on the target (missing runtime, network, disk) and retry the step."),
	},
	deps_denied: {
		title: msg("Setup commands were denied"),
		body: msg("A setup command needed for this task was denied on the target, so the workspace cannot be prepared."),
		advice: msg("Retry and approve the commands, or cancel and hand off without them."),
	},
	validation_failed: {
		title: msg("The workspace did not validate"),
		body: msg("After restoring, the files did not match the manifest or the check command failed."),
		advice: msg("Review the check output, fix the target workspace, and retry validation."),
	},
	session_failed: {
		title: msg("The new agent session could not start"),
		body: msg("Everything was restored, but the target could not start its new agent session."),
		advice: msg("Check that the agent runtime and a model provider are working on the target, then retry."),
	},
	disk_full: {
		title: msg("The target is out of disk space"),
		body: msg("The target machine could not store the handoff files."),
		advice: msg("Free up space on the target and retry."),
	},
	timeout: {
		title: msg("The handoff ran out of time"),
		body: msg("The restore deadline passed before the target acknowledged the handoff. The source keeps ownership until an ack arrives."),
		advice: msg("Extend the deadline if the target is still working, or reclaim the task on the source."),
	},
	manifest_invalid: {
		title: msg("The handoff package is invalid"),
		body: msg("The manifest or one of its files failed a hash or schema check, so it was not trusted."),
		advice: msg("Cancel and start a new handoff from the source."),
	},
	secret_detected: {
		title: msg("A secret was found in the handoff"),
		body: msg("The package or conversation summary appeared to contain a secret (key, token or password), so it was blocked."),
		advice: msg("Remove the secret from the work folder or conversation on the source, then hand off again."),
	},
	superseded: {
		title: msg("Another handoff took over"),
		body: msg("A newer handoff for the same task won, so this one was stopped to keep exactly one owner."),
		advice: msg("Nothing to do. Follow the newer handoff."),
	},
	cancelled: {
		title: msg("The handoff was cancelled"),
		body: msg("It was cancelled before the target took ownership."),
		advice: msg("Start a new handoff if you still want to move the task."),
	},
	capacity: {
		title: msg("The target is at capacity"),
		body: msg("The target machine is running its maximum number of agent sessions."),
		advice: msg("Wait for a session to finish on the target (or raise its limit), then retry."),
	},
	policy_denied: {
		title: msg("This machine's policy refused the handoff"),
		body: msg("The target machine does not take this task over: the task's sender is not a paired member of the workspace here, or has not granted this machine what it needs to follow the task."),
		advice: msg("Pair with the task's sender and share the workspace on the target (or hand off to another machine), then offer the task again."),
	},
};

/** Risk text shown before reclaiming without proof that the target did not acknowledge (docs §6.4 / §8). */
export const RECLAIM_RISK =
	msg(
		"If the target already wrote its acknowledgement but the response never reached this machine, it may be running this task right now. Reclaiming here lets BOTH machines run it (duplicate execution). The ownership epoch still fences every shared resource once the machines can talk again, and the late result is kept for review, but work done in the meantime on one side may be thrown away.",
	);

/** Step the handoff is on now: running, else the first failed, else the first pending one. */
export function currentStep(h: Handoff): HandoffStep | undefined {
	const steps = h.steps.filter((s) => s.n >= 1);
	const started = steps.some((s) => s.state === "done");
	return steps.find((s) => s.state === "running") ?? steps.find((s) => s.state === "failed") ?? (started && isStepsOpen(h) ? steps.find((s) => s.state === "pending") : undefined);
}
const isStepsOpen = (h: Handoff): boolean => h.state !== "completed" && h.state !== "resumed" && h.state !== "owner";

/** The fixed ten steps of the target side (`TARGET_STEPS` in handoff-engine), keyed by their number; the server's `name` is a snake_case identifier. */
const STEP_NAME: Readonly<Record<number, Msg>> = {
	1: msg("Receive the offer"),
	2: msg("Store the task"),
	3: msg("Restore the files"),
	4: msg("Restore the context"),
	5: msg("Set up dependencies"),
	6: msg("Validate the workspace"),
	7: msg("Create the session"),
	8: msg("Acknowledge"),
	9: msg("Take ownership"),
	10: msg("Resume the work"),
};

/** Display name of a restore step: the one place a step id is turned into words (an unknown step keeps the server's id). */
export function stepName(s: Pick<HandoffStep, "n" | "name">): string {
	const name = STEP_NAME[s.n];
	return name === undefined ? s.name : tr(name);
}

/** One line: where this handoff is, from this machine's point of view. */
export function progressLine(h: Handoff): string {
	const step = currentStep(h);
	if (step) return t("Step {n}/10 · {name}", { n: step.n, name: stepName(step) });
	if (h.role === "source") {
		switch (h.state) {
			case "offered":
				return t("Waiting for {name} to accept", { name: h.target.nodeName });
			case "accepted":
			case "awaiting_ack":
				return t("{name} is restoring the work", { name: h.target.nodeName });
			case "ack_timeout":
				return t("{name} has not acknowledged in time", { name: h.target.nodeName });
			case "preparing":
				return t("Packing files and context");
			default:
				return stateLabel(h.state);
		}
	}
	return h.state === "received" ? t("Waiting for your decision") : stateLabel(h.state);
}

/** Which end of the clock applies: offers expire; accepted handoffs have a restore deadline. */
export function clockOf(h: Handoff): { at: string; label: Msg } | null {
	if (!isActiveForClock(h)) return null;
	if ((h.state === "offered" || h.state === "received") && h.expiresAt) return { at: h.expiresAt, label: msg("Offer expires") };
	if (h.deadlineAt) return { at: h.deadlineAt, label: msg("Restore deadline") };
	if (h.expiresAt) return { at: h.expiresAt, label: msg("Offer expires") };
	return null;
}
const CLOCK_OFF: Record<string, true> = { completed: true, rejected: true, expired: true, cancelled: true, reclaimed: true, failed: true, released: true, acked: true, owner: true, resumed: true };
const isActiveForClock = (h: Handoff): boolean => !CLOCK_OFF[h.state];

export function timeLeft(at: string, now: number): { text: string; overdue: boolean; soon: boolean } {
	const ms = Date.parse(at) - now;
	const overdue = ms <= 0;
	const s = Math.floor(Math.abs(ms) / 1000);
	const text = s >= 3600 ? formatDuration(s * 1000) : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
	return { text: overdue ? t("{time} overdue", { time: text }) : t("{time} left", { time: text }), overdue, soon: !overdue && ms < 5 * 60_000 };
}

/** The local session on this machine, if the handoff has one by now. */
export const ownSessionId = (h: Handoff): string | null => (h.role === "source" ? h.source.sessionId : h.target.sessionId);

export const ownNodeName = (h: Handoff): string => (h.role === "source" ? h.source.nodeName : h.target.nodeName);
export const otherNodeName = (h: Handoff): string => (h.role === "source" ? h.target.nodeName : h.source.nodeName);

export const partyText = (p: { nodeName: string; agentName: string | null }): string => (p.agentName ? `${p.agentName}@${p.nodeName}` : p.nodeName);
