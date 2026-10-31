import { z } from "zod";
import { IsoDate } from "./common.ts";

/**
 * The machine's own Terminal: real shells (PTYs) on THIS machine, shown in this machine's web UI.
 *
 * - Loopback UI: always available. Through the machine's domain: off by default, switched on from the loopback UI
 *   (`AccessStatus.remoteTerminalEnabled`), and opening or attaching a terminal needs a recent password re-entry (step-up).
 * - Terminals are never relayed through the mesh (`/api/v1`): another machine's owner opens THIS machine's own UI.
 * - Sessions live in the server process: they survive a browser disconnect (reattach replays the scrollback) but not a server stop.
 */

/** Hard limits shared by the server and the UI. */
export const TERMINAL_LIMITS = {
	maxSessions: 12,
	minCols: 2,
	maxCols: 500,
	minRows: 1,
	maxRows: 200,
	/** Scrollback kept per terminal for replay on attach. */
	scrollbackBytes: 2 * 1024 * 1024,
	titleMax: 80,
} as const;

export const TerminalSession = z.object({
	id: z.string(),
	/** User-chosen name; defaults to the shell's name (`zsh`, `bash`). */
	title: z.string(),
	shell: z.string(),
	cwd: z.string(),
	/** Set when the terminal was opened in a project (or chat) folder. */
	projectId: z.string().nullable(),
	cols: z.number().int(),
	rows: z.number().int(),
	status: z.enum(["running", "exited"]),
	exitCode: z.number().int().nullable(),
	/** Signal number that ended the shell, if any. */
	signal: z.number().int().nullable(),
	/** Browsers currently attached to it. */
	attached: z.number().int(),
	createdAt: IsoDate,
	lastActivityAt: IsoDate,
	exitedAt: IsoDate.nullable(),
});
export type TerminalSession = z.infer<typeof TerminalSession>;

/** What the New Terminal dialog needs. */
export const TerminalInfo = z.object({
	/** False when no PTY can be started on this machine (the reason says why). */
	available: z.boolean(),
	reason: z.string().nullable(),
	/** The OS account the shells run as. */
	user: z.string(),
	home: z.string(),
	defaultShell: z.string(),
	/** Installed login shells the user may pick (from `/etc/shells`, only those that exist). */
	shells: z.array(z.string()),
	maxSessions: z.number().int(),
	sessionCount: z.number().int(),
});
export type TerminalInfo = z.infer<typeof TerminalInfo>;

export const CreateTerminalBody = z.object({
	/** Working directory = the project's (or chat's) folder; default is the user's home. */
	projectId: z.string().min(1).optional(),
	/** One of `TerminalInfo.shells`; default is the user's login shell. */
	shell: z.string().min(1).max(512).optional(),
	title: z.string().trim().min(1).max(TERMINAL_LIMITS.titleMax).optional(),
	cols: z.number().int().min(TERMINAL_LIMITS.minCols).max(TERMINAL_LIMITS.maxCols).default(80),
	rows: z.number().int().min(TERMINAL_LIMITS.minRows).max(TERMINAL_LIMITS.maxRows).default(24),
});
export type CreateTerminalBody = z.input<typeof CreateTerminalBody>;

export const UpdateTerminalBody = z.object({ title: z.string().trim().min(1).max(TERMINAL_LIMITS.titleMax) });
export type UpdateTerminalBody = z.infer<typeof UpdateTerminalBody>;

/**
 * Terminal socket: `GET /ws/terminal/:id` (WebSocket). Terminal bytes travel as BINARY frames in both directions
 * (client → server: keystrokes/paste; server → client: PTY output, first the scrollback replay, then live output).
 * Control travels as small JSON TEXT frames.
 */
export const TERMINAL_WS_PATH = (id: string): string => `/ws/terminal/${id}`;
/** Close codes the server uses on the terminal socket. */
export const TERMINAL_CLOSE = {
	/** The owner session ended, or the machine's remote Terminal was switched off. */
	sessionEnded: 4401,
	/** The terminal was killed or removed. */
	removed: 4404,
	/** The server stalled this client (it did not read fast enough). */
	tooSlow: 4408,
	/** The server is stopping. */
	shuttingDown: 1001,
} as const;

export const TerminalClientMessage = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("resize"),
		cols: z.number().int().min(TERMINAL_LIMITS.minCols).max(TERMINAL_LIMITS.maxCols),
		rows: z.number().int().min(TERMINAL_LIMITS.minRows).max(TERMINAL_LIMITS.maxRows),
	}),
	z.object({ type: z.literal("ping"), t: z.number() }),
]);
export type TerminalClientMessage = z.infer<typeof TerminalClientMessage>;

export type TerminalServerMessage =
	/** First frame after the upgrade: the session, and how many replay bytes follow (as binary frames) before live output. */
	| { type: "attached"; session: TerminalSession; replayBytes: number }
	/** The replay has been sent in full; everything after is live. */
	| { type: "live" }
	/** The shell ended. The terminal stays (read-only) for a while so the reload still shows its last output. */
	| { type: "exit"; exitCode: number | null; signal: number | null }
	/** Session metadata changed (renamed, resized by another browser, attached count). */
	| { type: "session"; session: TerminalSession }
	| { type: "pong"; t: number }
	| { type: "error"; message: string };
