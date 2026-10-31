import type { Handoff, HandoffFailureCode, HandoffState, HandoffStep } from "@clam/contracts";
import type { BadgeVariant } from "@/features/tasks/format.ts";

export const STATE_META: Record<HandoffState, { label: string; variant: BadgeVariant }> = {
	draft: { label: "Draft", variant: "neutral" },
	preparing: { label: "Preparing", variant: "accent" },
	prepare_failed: { label: "Preparation failed", variant: "danger" },
	offered: { label: "Offered", variant: "warning" },
	accepted: { label: "Accepted", variant: "accent" },
	awaiting_ack: { label: "Waiting for ack", variant: "accent" },
	ack_timeout: { label: "Ack timed out", variant: "danger" },
	acked: { label: "Acknowledged", variant: "success" },
	released: { label: "Released", variant: "success" },
	completed: { label: "Completed", variant: "success" },
	rejected: { label: "Rejected", variant: "danger" },
	expired: { label: "Expired", variant: "neutral" },
	cancelled: { label: "Cancelled", variant: "neutral" },
	reclaimed: { label: "Reclaimed", variant: "neutral" },
	failed: { label: "Failed", variant: "danger" },
	received: { label: "Received", variant: "warning" },
	persisted: { label: "Saved", variant: "accent" },
	files_restored: { label: "Files restored", variant: "accent" },
	context_restored: { label: "Context restored", variant: "accent" },
	deps_ready: { label: "Dependencies ready", variant: "accent" },
	validated: { label: "Validated", variant: "accent" },
	session_created: { label: "Session created", variant: "accent" },
	owner: { label: "Owner", variant: "success" },
	resumed: { label: "Resumed", variant: "success" },
};

export const stateLabel = (s: HandoffState): string => STATE_META[s].label;

/** Plain-English explanation and the recommended next move for each failure code. */
export const FAILURE_TEXT: Record<HandoffFailureCode, { title: string; body: string; advice: string }> = {
	git_unavailable: {
		title: "Git is not available",
		body: "The target machine could not use Git, or could not reach the repository, so the files could not be restored.",
		advice: "Install Git and connect a GitHub account on the target machine, then retry.",
	},
	checkout_conflict: {
		title: "Local changes are in the way",
		body: "The target checkout has uncommitted changes that conflict with the handed-over branch. Nothing was overwritten.",
		advice: "Commit or stash the changes on the target (or accept into a different project), then retry.",
	},
	patch_failed: {
		title: "The uncommitted work could not be applied",
		body: "The branch was restored, but the attached patch with the source's uncommitted changes does not apply cleanly.",
		advice: "Retry after cleaning the target checkout, or cancel and hand off again once the source has committed its work.",
	},
	files_conflict: {
		title: "Files conflict with the target folder",
		body: "The target folder already contains different versions of some files in the bundle. Nothing was overwritten.",
		advice: "Choose an empty project on the target, or move the conflicting files away, then retry.",
	},
	deps_failed: {
		title: "Dependency setup failed",
		body: "An install or setup command failed on the target. The output is shown in the setup panel.",
		advice: "Fix the cause on the target (missing runtime, network, disk) and retry the step.",
	},
	deps_denied: {
		title: "Setup commands were denied",
		body: "A setup command needed for this task was denied on the target, so the workspace cannot be prepared.",
		advice: "Retry and approve the commands, or cancel and hand off without them.",
	},
	validation_failed: {
		title: "The workspace did not validate",
		body: "After restoring, the files did not match the manifest or the check command failed.",
		advice: "Review the check output, fix the target workspace, and retry validation.",
	},
	session_failed: {
		title: "The new agent session could not start",
		body: "Everything was restored, but the target could not start its new agent session.",
		advice: "Check that the agent runtime and a model provider are working on the target, then retry.",
	},
	disk_full: {
		title: "The target is out of disk space",
		body: "The target machine could not store the handoff files.",
		advice: "Free up space on the target and retry.",
	},
	timeout: {
		title: "The handoff ran out of time",
		body: "The restore deadline passed before the target acknowledged the handoff. The source keeps ownership until an ack arrives.",
		advice: "Extend the deadline if the target is still working, or reclaim the task on the source.",
	},
	manifest_invalid: {
		title: "The handoff package is invalid",
		body: "The manifest or one of its files failed a hash or schema check, so it was not trusted.",
		advice: "Cancel and start a new handoff from the source.",
	},
	secret_detected: {
		title: "A secret was found in the handoff",
		body: "The package or conversation summary appeared to contain a secret (key, token or password), so it was blocked.",
		advice: "Remove the secret from the work folder or conversation on the source, then hand off again.",
	},
	superseded: {
		title: "Another handoff took over",
		body: "A newer handoff for the same task won, so this one was stopped to keep exactly one owner.",
		advice: "Nothing to do. Follow the newer handoff.",
	},
	cancelled: {
		title: "The handoff was cancelled",
		body: "It was cancelled before the target took ownership.",
		advice: "Start a new handoff if you still want to move the task.",
	},
	capacity: {
		title: "The target is at capacity",
		body: "The target machine is running its maximum number of agent sessions.",
		advice: "Wait for a session to finish on the target (or raise its limit), then retry.",
	},
	policy_denied: {
		title: "This machine's policy refused the handoff",
		body: "The target machine does not take this task over: the task's sender is not a paired member of the workspace here, or has not granted this machine what it needs to follow the task.",
		advice: "Pair with the task's sender and share the workspace on the target (or hand off to another machine), then offer the task again.",
	},
};

/** Risk text shown before reclaiming without proof that the target did not acknowledge (docs §6.4 / §8). */
export const RECLAIM_RISK =
	"If the target already wrote its acknowledgement but the response never reached this machine, it may be running this task right now. Reclaiming here lets BOTH machines run it (duplicate execution). The ownership epoch still fences every shared resource once the machines can talk again, and the late result is kept for review, but work done in the meantime on one side may be thrown away.";

/** Step the handoff is on now: running, else the first failed, else the first pending one. */
export function currentStep(h: Handoff): HandoffStep | undefined {
	const steps = h.steps.filter((s) => s.n >= 1);
	const started = steps.some((s) => s.state === "done");
	return steps.find((s) => s.state === "running") ?? steps.find((s) => s.state === "failed") ?? (started && isStepsOpen(h) ? steps.find((s) => s.state === "pending") : undefined);
}
const isStepsOpen = (h: Handoff): boolean => h.state !== "completed" && h.state !== "resumed" && h.state !== "owner";

/** One line: where this handoff is, from this machine's point of view. */
export function progressLine(h: Handoff): string {
	const step = currentStep(h);
	if (step) return `Step ${step.n}/10 · ${step.name}`;
	if (h.role === "source") {
		switch (h.state) {
			case "offered":
				return `Waiting for ${h.target.nodeName} to accept`;
			case "accepted":
			case "awaiting_ack":
				return `${h.target.nodeName} is restoring the work`;
			case "ack_timeout":
				return `${h.target.nodeName} has not acknowledged in time`;
			case "preparing":
				return "Packing files and context";
			default:
				return stateLabel(h.state);
		}
	}
	return h.state === "received" ? "Waiting for your decision" : stateLabel(h.state);
}

/** Which end of the clock applies: offers expire; accepted handoffs have a restore deadline. */
export function clockOf(h: Handoff): { at: string; label: string } | null {
	if (!isActiveForClock(h)) return null;
	if ((h.state === "offered" || h.state === "received") && h.expiresAt) return { at: h.expiresAt, label: "Offer expires" };
	if (h.deadlineAt) return { at: h.deadlineAt, label: "Restore deadline" };
	if (h.expiresAt) return { at: h.expiresAt, label: "Offer expires" };
	return null;
}
const CLOCK_OFF: Record<string, true> = { completed: true, rejected: true, expired: true, cancelled: true, reclaimed: true, failed: true, released: true, acked: true, owner: true, resumed: true };
const isActiveForClock = (h: Handoff): boolean => !CLOCK_OFF[h.state];

export function timeLeft(at: string, now: number): { text: string; overdue: boolean; soon: boolean } {
	const ms = Date.parse(at) - now;
	const overdue = ms <= 0;
	const s = Math.floor(Math.abs(ms) / 1000);
	const text = s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
	return { text: overdue ? `${text} overdue` : `${text} left`, overdue, soon: !overdue && ms < 5 * 60_000 };
}

/** The local session on this machine, if the handoff has one by now. */
export const ownSessionId = (h: Handoff): string | null => (h.role === "source" ? h.source.sessionId : h.target.sessionId);

export const ownNodeName = (h: Handoff): string => (h.role === "source" ? h.source.nodeName : h.target.nodeName);
export const otherNodeName = (h: Handoff): string => (h.role === "source" ? h.target.nodeName : h.source.nodeName);

export const partyText = (p: { nodeName: string; agentName: string | null }): string => (p.agentName ? `${p.agentName}@${p.nodeName}` : p.nodeName);
