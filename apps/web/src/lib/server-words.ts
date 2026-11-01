import { msg } from "@/i18n";

/**
 * Enum words the server interpolates into its sentences (`"Handoff is {state}"`, `"{fromStatus} → {toStatus}"`): task statuses,
 * handoff states, pairing/invitation/setup states, handoff sides and restore step ids. The server sends the raw English word
 * as a param; `renderServerText` (src/i18n/index.tsx) looks the value up in the catalog when the param is named `state`,
 * `status`, `fromStatus`, `toStatus`, `reported`, `side`, `role` or `step`. This list only declares the literals so they are
 * extracted and translated — add a word here (and to the shell/lib catalog) when the server starts interpolating a new one.
 */
export const SERVER_WORDS = [
	// task statuses
	msg("offered"),
	msg("accepted"),
	msg("rejected"),
	msg("running"),
	msg("blocked"),
	msg("succeeded"),
	msg("failed"),
	msg("cancelled"),
	msg("handed_off"),
	// handoff states (source side, then target side)
	msg("draft"),
	msg("preparing"),
	msg("prepare_failed"),
	msg("awaiting_ack"),
	msg("ack_timeout"),
	msg("acked"),
	msg("released"),
	msg("completed"),
	msg("expired"),
	msg("reclaimed"),
	msg("received"),
	msg("persisted"),
	msg("files_restored"),
	msg("context_restored"),
	msg("deps_ready"),
	msg("validated"),
	msg("session_created"),
	msg("owner"),
	msg("resumed"),
	// setup commands, pairing requests, invitations
	msg("pending"),
	msg("pending_approval"),
	msg("approved"),
	msg("denied"),
	msg("skipped"),
	msg("awaiting_approval"),
	msg("confirming"),
	msg("paired"),
	msg("consumed"),
	msg("revoked"),
	msg("locked"),
	msg("declined"),
	// handoff sides
	msg("source"),
	msg("target"),
	// restore step ids (`TARGET_STEPS` in handoff-engine)
	msg("receive"),
	msg("persist"),
	msg("restore_files"),
	msg("restore_context"),
	msg("setup_dependencies"),
	msg("validate_workspace"),
	msg("create_session"),
	msg("durable_ack"),
	msg("acquire_ownership"),
	msg("resume"),
] as const;
