import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { i18nMsg, plainMsg, type SetupDecisionBody } from "@clam/contracts";
import { checkRuntimes, runSetupCommand, type SetupReport, setupFingerprint } from "@clam/handoff-engine";
import type { z } from "zod";
import { ApiError } from "../http/errors.ts";
import { errorText } from "../network/util.ts";
import { readNodeSettings } from "../services/settings.ts";
import { type HandoffHub, HandoffStepError, type SetupApi, type SetupInput, type SetupOutcome } from "./hub.ts";
import { type HandoffSetupRow, newSetupId } from "./store.ts";

type Purpose = "install" | "setup" | "check";
interface Planned {
	command: string;
	purpose: Purpose;
	cwd: string;
}

/** Tail of a command's output kept on its row (the runner already scrubbed secret-looking lines). */
const TAIL_CHARS = 16_000;
/** While a command runs, its row shows the last lines at most this often. */
const LIVE_FLUSH_MS = 500;
const LIVE_LINES = 40;
const DONE_STATES: Record<string, true> = { succeeded: true, skipped: true, denied: true };
const RUNNABLE_STATES: Record<string, true> = { approved: true, failed: true, running: true };

const nowIso = (): string => new Date().toISOString();
const tail = (text: string): string => (text.length > TAIL_CHARS ? text.slice(text.length - TAIL_CHARS) : text);

/**
 * Install command of the work folder, then those of its nested projects (each in its own folder), then the declared setup
 * commands, then the check command: each once per folder, in that order. A nested project's folder comes from the manifest of a
 * peer: it is only used when it stays inside the work folder.
 */
function planCommands(input: SetupInput): Planned[] {
	const planned: Planned[] = [];
	const seen = new Set<string>();
	const add = (command: string | null | undefined, purpose: Purpose, cwd: string = input.dir): void => {
		const text = command?.trim();
		if (!text || seen.has(`${cwd}\0${text}`)) return;
		seen.add(`${cwd}\0${text}`);
		planned.push({ command: text, purpose, cwd });
	};
	add(input.environment.packageManager?.installCommand, "install");
	for (const project of input.environment.projects ?? []) {
		const cwd = path.resolve(input.dir, project.path);
		const rel = path.relative(path.resolve(input.dir), cwd);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
		add(project.packageManager.installCommand, "install", cwd);
	}
	for (const command of input.environment.setupCommands) add(command, "setup");
	add(input.checkCommand ?? input.environment.checkCommand, "check");
	return planned;
}

function git(dir: string, args: string[]): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile("git", ["-C", dir, ...args], { timeout: 30_000, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout) => resolve(error ? null : stdout.trim()));
	return promise;
}

/**
 * Dependency setup (step 5) and workspace validation (step 6) for a handoff of any kind. Everything the steps need arrives in
 * `SetupInput`, and everything they decide is kept in `handoff_setup` rows, so a crash, a restart or a user answer re-enters the
 * same work: a command that already succeeded is never run again, a denied one stays denied, and a `setupFingerprint` equal to the
 * one recorded after the last successful setup means the dependencies are already in place for exactly this input.
 */
export class DependencySetup implements SetupApi {
	constructor(private readonly hub: HandoffHub) {}

	async setupAndValidate(handoffId: string, input: SetupInput): Promise<SetupOutcome> {
		const phase = input.phase ?? "both";
		this.hub.store.get(handoffId);
		const rows = this.ensureRows(handoffId, input);
		const pending = rows.filter((r) => r.state === "pending_approval").map((r) => r.command);
		if (pending.length > 0) return { status: "waiting", pending };

		const report: SetupReport = { ran: [], skipped: [] };
		if (phase !== "validate") await this.dependencies(handoffId, input);
		const issues = await this.runtimeIssues(input);
		if (issues.length > 0) report.runtimeIssues = issues;
		if (phase === "validate" || phase === "both") report.validation = await this.validate(handoffId, input);
		this.fillRanSkipped(report, this.hub.store.setupRows(handoffId));
		return { status: "ready", report };
	}

	decide(handoffId: string, body: z.infer<typeof SetupDecisionBody>): void {
		const { store } = this.hub;
		store.get(handoffId);
		const rows = new Map(store.setupRows(handoffId).map((r) => [r.id, r]));
		const wanted = new Map<string, "approved" | "denied">();
		for (const id of body.approve) wanted.set(id, "approved");
		for (const id of body.deny) {
			if (wanted.has(id)) throw ApiError.badRequest(i18nMsg("Setup command {id} is both approved and denied", { id }));
			wanted.set(id, "denied");
		}
		for (const [id, state] of wanted) {
			const row = rows.get(id);
			if (!row) throw ApiError.notFound("Setup command");
			if (row.state !== "pending_approval" && row.state !== state) throw ApiError.conflict(i18nMsg("Setup command is {state} already", { state: row.state }), { state: row.state });
		}
		const at = nowIso();
		store.transaction(() => {
			for (const [id, state] of wanted) {
				if (rows.get(id)?.state !== "pending_approval") continue;
				store.updateSetup(id, state === "denied" ? { state, outputTail: "Denied on this node: not run", finishedAt: at } : { state });
			}
		});
		if (wanted.size > 0) {
			const approved = [...wanted].filter(([, s]) => s === "approved").length;
			const denied = wanted.size - approved;
			this.hub.note(handoffId, i18nMsg("Setup commands: {approved} approved, {denied} denied", { approved, denied }));
		}
		this.hub.changed(handoffId);
	}

	// ------------------------------------------------------------------ rows

	/** Create the rows once (state by node policy); a re-run finds them and keeps every decision and result. */
	private ensureRows(handoffId: string, input: SetupInput): HandoffSetupRow[] {
		const { store } = this.hub;
		const existing = store.setupRows(handoffId);
		if (existing.length > 0) return existing;
		const planned = planCommands(input);
		if (planned.length === 0) return [];
		const policy = readNodeSettings(this.hub.ctx.db).dependencySetup;
		const rows = store.transaction(() =>
			planned.map((p, ord) =>
				store.insertSetup({
					id: newSetupId(),
					handoffId,
					ord,
					command: p.command,
					cwd: p.cwd,
					purpose: p.purpose,
					state: policy === "ask" ? "pending_approval" : policy === "auto" ? "approved" : "skipped",
					outputTail: policy === "skip" ? "Skipped: dependency setup is switched off on this node" : "",
				}),
			),
		);
		this.hub.changed(handoffId);
		return rows;
	}

	private fillRanSkipped(report: SetupReport, rows: readonly HandoffSetupRow[]): void {
		for (const row of rows) {
			if (row.state === "succeeded" || row.state === "failed") {
				report.ran.push({ command: row.command, exitCode: row.exitCode });
			} else if (row.state === "skipped" || row.state === "denied") {
				report.skipped.push({ command: row.command, reason: row.state === "denied" ? "denied by the user on this node" : row.outputTail.replace(/^Skipped: /, "") || "skipped" });
			}
		}
	}

	// ------------------------------------------------------------------ step 5

	private async dependencies(handoffId: string, input: SetupInput): Promise<void> {
		const { store } = this.hub;
		const deps = store.setupRows(handoffId).filter((r) => r.purpose !== "check");
		if (deps.length === 0) return;
		const fingerprint = await setupFingerprint(input.dir, input.environment);
		if (store.get(handoffId).setupFingerprint === fingerprint) {
			// Done before for exactly this input (a retry after a later step failed, a restart after step 5 finished).
			const at = nowIso();
			for (const row of deps) {
				if (!DONE_STATES[row.state]) store.updateSetup(row.id, { state: "skipped", outputTail: "Skipped: already set up for this exact input (unchanged since the last successful run)", finishedAt: at });
			}
			this.hub.changed(handoffId);
			return;
		}
		for (const row of deps) {
			if (!RUNNABLE_STATES[row.state]) continue;
			const outcome = await this.execute(handoffId, row);
			if (!outcome.ok) throw new HandoffStepError("deps_failed", plainMsg(outcome.detail), 5);
		}
		if (store.setupRows(handoffId).filter((r) => r.purpose !== "check").every((r) => r.state === "succeeded")) {
			store.update(handoffId, { setupFingerprint: fingerprint });
		}
	}

	private async runtimeIssues(input: SetupInput): Promise<string[]> {
		const report = await checkRuntimes(input.environment);
		return report.checks.filter((c) => c.status === "missing" || c.status === "mismatch").map((c) => c.detail);
	}

	// ------------------------------------------------------------------ step 6

	/** Returns the one-line validation result for the resume prompt; throws `validation_failed` listing what does not hold. */
	private async validate(handoffId: string, input: SetupInput): Promise<string> {
		const issues: string[] = [];
		const facts: string[] = [];

		if (input.requiredFiles.length > 0) {
			const missing: string[] = [];
			for (const rel of input.requiredFiles) if (!(await this.exists(input.dir, rel))) missing.push(rel);
			if (missing.length > 0) issues.push(`required files are missing: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ` and ${missing.length - 10} more` : ""}`);
			else facts.push(`${input.requiredFiles.length} required file${input.requiredFiles.length === 1 ? "" : "s"} present`);
		}

		if (input.gitCommit) {
			const head = await git(input.dir, ["rev-parse", "HEAD"]);
			if (head === null) issues.push("the work folder is not a git repository (or HEAD cannot be read)");
			else if (head.toLowerCase() !== input.gitCommit.toLowerCase()) issues.push(`HEAD is ${head.slice(0, 12)}, expected ${input.gitCommit.slice(0, 12)}`);
			else facts.push(`HEAD matches ${head.slice(0, 12)}`);
		}

		if (issues.length === 0) {
			const row = this.hub.store.setupRows(handoffId).find((r) => r.purpose === "check");
			if (row && RUNNABLE_STATES[row.state]) {
				const outcome = await this.execute(handoffId, row);
				if (!outcome.ok) issues.push(`the check command failed: ${outcome.detail}`);
				else facts.push(`\`${row.command}\` passed`);
			} else if (row?.state === "succeeded") {
				facts.push(`\`${row.command}\` passed`);
			} else if (row) {
				facts.push(`\`${row.command}\` was not run (${row.state === "denied" ? "denied on this node" : "skipped"})`);
			}
		}

		if (issues.length > 0) throw new HandoffStepError("validation_failed", i18nMsg("Workspace validation failed: {issues}", { issues: issues.join("; ") }), 6);
		return facts.length > 0 ? facts.join(", ") : "nothing to validate";
	}

	private async exists(dir: string, relative: string): Promise<boolean> {
		const target = path.resolve(dir, relative);
		const rel = path.relative(path.resolve(dir), target);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
		try {
			await lstat(target);
			return true;
		} catch {
			return false;
		}
	}

	// ------------------------------------------------------------------ running a command

	private async execute(handoffId: string, row: HandoffSetupRow): Promise<{ ok: true } | { ok: false; detail: string }> {
		const { store, timings } = this.hub;
		store.updateSetup(row.id, { state: "running", startedAt: nowIso(), finishedAt: null, exitCode: null, outputTail: "" });
		this.hub.changed(handoffId);

		const live: string[] = [];
		let flushedAt = 0;
		const result = await runSetupCommand({
			command: row.command,
			cwd: row.cwd,
			timeoutMs: timings.stepTimeoutMs,
			onOutput: (line) => {
				live.push(line);
				if (live.length > LIVE_LINES) live.shift();
				const at = Date.now();
				if (at - flushedAt < LIVE_FLUSH_MS) return;
				flushedAt = at;
				try {
					store.updateSetup(row.id, { outputTail: tail(live.join("\n")) });
					this.hub.changed(handoffId);
				} catch (error) {
					this.hub.log.debug({ handoffId, err: errorText(error) }, "live setup output could not be stored");
				}
			},
		});

		const ok = result.exitCode === 0 && !result.timedOut && !result.aborted && result.error === null;
		store.updateSetup(row.id, {
			state: ok ? "succeeded" : "failed",
			exitCode: result.exitCode,
			outputTail: tail(result.outputTail !== "" ? result.outputTail : (result.error ?? "")),
			finishedAt: nowIso(),
		});
		this.hub.changed(handoffId);
		if (ok) {
			this.hub.note(handoffId, i18nMsg("Ran `{command}`: succeeded", { command: row.command }));
			return { ok: true };
		}
		const seconds = Math.max(1, Math.round(timings.stepTimeoutMs / 1000));
		const why = result.timedOut
			? `timed out after ${seconds} s`
			: result.error !== null
				? `could not be started (${result.error})`
				: result.aborted
					? "was aborted"
					: `exited with code ${result.exitCode ?? "none"}${result.signal ? ` (${result.signal})` : ""}`;
		const lastLines = result.outputTail.split("\n").filter((l) => l.trim() !== "").slice(-3).join(" | ");
		const detail = `\`${row.command}\` ${why}${lastLines ? `: ${lastLines}` : ""}`.slice(0, 1500);
		const command = row.command;
		this.hub.note(
			handoffId,
			result.timedOut
				? i18nMsg("Ran `{command}`: failed (timed out after {seconds} s)", { command, seconds })
				: result.error !== null
					? i18nMsg("Ran `{command}`: failed (could not be started ({error}))", { command, error: result.error })
					: result.aborted
						? i18nMsg("Ran `{command}`: failed (was aborted)", { command })
						: result.signal
							? i18nMsg("Ran `{command}`: failed (exited with code {code} ({signal}))", { command, code: result.exitCode ?? "none", signal: result.signal })
							: i18nMsg("Ran `{command}`: failed (exited with code {code})", { command, code: result.exitCode ?? "none" }),
		);
		return { ok: false, detail };
	}
}
