import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ModelInfo, ModelRoles, ModelTestResult, OmpInstall } from "@clam/contracts";
import { z } from "zod";
import { AgentRuntimeError, type RuntimeLogger } from "../types.ts";
import type { OmpCli } from "./api.ts";
import { standardizeProjectDir } from "./session-transfer.ts";

export interface OmpCliOptions {
	/** Current binary path (re-evaluated on every call so settings changes apply immediately). */
	binary: () => string | null;
	/** Isolated OMP profile (`--profile <p>` is prepended to every invocation). */
	profile?: string | null;
	log?: RuntimeLogger;
	env?: NodeJS.ProcessEnv;
}

const MODELS_CACHE_MS = 60_000;
const QUICK_TIMEOUT_MS = 15_000;
const MODELS_TIMEOUT_MS = 60_000;
const DEFAULT_TEST_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TEST_PROMPT = "Reply with exactly: OK";
const TEST_SYSTEM_PROMPT = "You are a connectivity probe. Answer as briefly as possible.";
const MAX_ERROR_CHARS = 1000;

const ROLE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** `provider/id[:thinking]`; model ids may contain `.`, `-`, `_`, `@`, `+`, `:`, `/` but never whitespace or shell metacharacters. */
const SELECTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]*\/[A-Za-z0-9][A-Za-z0-9._@+:/-]*$/;
const MAX_SELECTOR_LENGTH = 200;

const SESSION_TRANSFER_TIMEOUT_MS = 120_000;
const SESSION_MOVED_TIMEOUT_MS = 30_000;
const ARCHIVE_PROBLEM_PATTERN = /archive|manifest|sha256|invalid|not a session archive|no such file|ENOENT|not found/i;
const LEASE_PATTERN = /another live omp process/i;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escape sequences
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function clip(text: string, max = MAX_ERROR_CHARS): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function isValidModelRole(role: string): boolean {
	return ROLE_PATTERN.test(role);
}

export function isValidModelSelector(selector: string): boolean {
	return selector.length <= MAX_SELECTOR_LENGTH && SELECTOR_PATTERN.test(selector);
}

interface RunResult {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
	/** Spawn failure (ENOENT, EACCES, ...). */
	spawnError?: string;
}

const RawModel = z.object({
	provider: z.string().min(1),
	id: z.string().min(1),
	kind: z.string().optional(),
	selector: z.string().optional(),
	name: z.string().optional(),
	contextWindow: z.number().nullish(),
	maxTokens: z.number().nullish(),
	reasoning: z.boolean().optional(),
	thinking: z.array(z.string()).optional(),
	input: z.array(z.string()).optional(),
	cost: z
		.object({
			input: z.number(),
			output: z.number(),
			cacheRead: z.number().optional(),
			cacheWrite: z.number().optional(),
		})
		.nullish(),
	pricingStatus: z.string().optional(),
});

export function parseModels(stdout: string, log?: RuntimeLogger): ModelInfo[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (cause) {
		throw new AgentRuntimeError("protocol", "`omp models --json` did not return JSON", { cause: String(cause) });
	}
	const rows = (parsed as { models?: unknown } | null)?.models;
	if (!Array.isArray(rows)) {
		throw new AgentRuntimeError("protocol", "`omp models --json` returned no `models` array");
	}
	const models: ModelInfo[] = [];
	let dropped = 0;
	for (const row of rows) {
		const result = RawModel.safeParse(row);
		if (!result.success) {
			dropped++;
			continue;
		}
		const raw = result.data;
		if (raw.kind !== undefined && raw.kind !== "chat") continue;
		const costKnown = raw.cost != null && raw.pricingStatus !== "unknown";
		models.push({
			provider: raw.provider,
			id: raw.id,
			selector: raw.selector ?? `${raw.provider}/${raw.id}`,
			name: raw.name ?? raw.id,
			contextWindow: raw.contextWindow ?? null,
			maxTokens: raw.maxTokens ?? null,
			reasoning: raw.reasoning ?? (raw.thinking?.length ?? 0) > 0,
			thinking: raw.thinking ?? [],
			input: raw.input ?? [],
			cost:
				costKnown && raw.cost
					? {
							input: raw.cost.input,
							output: raw.cost.output,
							cacheRead: raw.cost.cacheRead ?? 0,
							cacheWrite: raw.cost.cacheWrite ?? 0,
						}
					: null,
		});
	}
	if (dropped > 0) log?.warn({ dropped }, "omp models: dropped malformed rows");
	return models;
}

/** `omp` has no `--` separator, so a value that could parse as a flag is refused up front. */
function requireArgvValue(name: string, value: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new AgentRuntimeError("invalid_argument", `${name} must not be empty`);
	}
	if (value.startsWith("-")) {
		throw new AgentRuntimeError("invalid_argument", `${name} must not start with "-": ${JSON.stringify(value)}`);
	}
	return value;
}

async function requireFile(name: string, path: string, code: "invalid_argument" | "invalid_archive"): Promise<void> {
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) throw new AgentRuntimeError(code, `${name} does not exist or is not a file: ${path}`);
}

function lastLine(text: string): string {
	const lines = stripAnsi(text)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.at(-1) ?? "";
}

/** Roles whose raw value is a record; non-string values are kept in `raw` only (so a write never loses them). */
function parseRolesRaw(stdout: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (cause) {
		throw new AgentRuntimeError("protocol", "`omp config get modelRoles --json` did not return JSON", {
			cause: String(cause),
		});
	}
	const value = (parsed as { value?: unknown } | null)?.value;
	if (value === null || value === undefined) return {};
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new AgentRuntimeError("protocol", "`modelRoles` is not a record");
	}
	return value as Record<string, unknown>;
}

function onlyStrings(raw: Record<string, unknown>): ModelRoles {
	const roles: ModelRoles = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string") roles[key] = value;
	}
	return roles;
}

/** Pull the human-readable failure out of omp's stderr (a Bun stack dump ending in `error: <message>`). */
export function extractErrorText(stderr: string): string {
	const lines = stripAnsi(stderr).split(/\r?\n/);
	const start = lines.findIndex((line) => /^\s*(error|Error)\b.*:/.test(line));
	if (start === -1) return clip(lines.filter((line) => line.trim() && !/^\s+at\s/.test(line)).join("\n"));
	const collected: string[] = [];
	for (let i = start; i < lines.length; i++) {
		const line = lines[i] as string;
		if (/^\s+at\s/.test(line)) break;
		collected.push(i === start ? line.replace(/^\s*[Ee]rror:\s*/, "") : line);
	}
	return clip(collected.join("\n").replace(/\n{3,}/g, "\n\n"));
}

interface PrintOutcome {
	text: string;
	error?: string;
}

/** Interpret `omp -p --mode json` output: the last assistant message's text, or its error. */
const PrintFrame = z.object({
	type: z.string(),
	message: z
		.object({
			role: z.string(),
			content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
			stopReason: z.string().optional(),
			errorMessage: z.string().optional(),
		})
		.optional(),
});
type PrintMessage = NonNullable<z.infer<typeof PrintFrame>["message"]>;

function readPrintOutput(stdout: string): PrintOutcome | null {
	let last: PrintMessage | null = null;
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		let json: unknown;
		try {
			json = JSON.parse(line);
		} catch {
			continue;
		}
		const frame = PrintFrame.safeParse(json);
		if (!frame.success) continue;
		const { type, message } = frame.data;
		if ((type === "message_end" || type === "turn_end") && message?.role === "assistant") last = message;
	}
	if (!last) return null;
	const text = (last.content ?? [])
		.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
		.join("")
		.trim();
	const failed = last.stopReason === "error" || last.stopReason === "aborted";
	if (failed || last.errorMessage) {
		return { text, error: clip(stripAnsi(last.errorMessage ?? `Model call ${last.stopReason}`)) };
	}
	return { text };
}

export function createOmpCli(options: OmpCliOptions): OmpCli {
	const log = options.log;
	const profile = options.profile?.trim() || null;
	let modelsCache: { at: number; value: ModelInfo[] } | null = null;
	let modelsInFlight: Promise<ModelInfo[]> | null = null;
	let generation = 0;
	/** Serialises read-modify-write of `modelRoles`. */
	let rolesQueue: Promise<unknown> = Promise.resolve();

	function requireBinary(): string {
		const binary = options.binary();
		if (!binary) throw new AgentRuntimeError("not_installed", "omp not found: install oh-my-pi or set its path in settings");
		return binary;
	}

	function run(binary: string, args: string[], opts: { timeoutMs: number; input?: boolean }): Promise<RunResult> {
		const fullArgs = profile ? ["--profile", profile, ...args] : args;
		const { promise, resolve } = Promise.withResolvers<RunResult>();
		{
			const child = execFile(
				binary,
				fullArgs,
				{
					cwd: tmpdir(),
					env: { ...process.env, ...options.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
					timeout: opts.timeoutMs,
					killSignal: "SIGKILL",
					maxBuffer: MAX_OUTPUT_BYTES,
					windowsHide: true,
					encoding: "utf8",
				},
				(error, stdout, stderr) => {
					if (!error) {
						resolve({ stdout, stderr, code: 0, timedOut: false });
						return;
					}
					const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string; signal?: string };
					const timedOut = e.killed === true && e.signal === "SIGKILL";
					const numeric = typeof e.code === "number" ? e.code : null;
					const spawnError = typeof e.code === "string" ? `${e.code}: ${e.message}` : undefined;
					resolve({
						stdout: stdout ?? "",
						stderr: stderr ?? "",
						code: numeric,
						timedOut,
						...(spawnError && !timedOut ? { spawnError } : {}),
					});
				},
			);
			child.stdin?.end();
		}
		return promise;
	}

	async function runChecked(args: string[], timeoutMs: number, what: string): Promise<string> {
		const binary = requireBinary();
		const result = await run(binary, args, { timeoutMs });
		if (result.timedOut) throw new AgentRuntimeError("timeout", `${what} timed out after ${timeoutMs} ms`);
		if (result.spawnError) throw new AgentRuntimeError("start_failed", `${what} failed to start: ${result.spawnError}`);
		if (result.code !== 0) {
			const detail = clip(stripAnsi(result.stderr) || stripAnsi(result.stdout));
			throw new AgentRuntimeError("rejected", `${what} failed (exit ${result.code ?? "?"}): ${detail}`, {
				exitCode: result.code,
			});
		}
		return result.stdout;
	}

	/** Run an `omp session …` subcommand and map its failures onto `AgentRuntimeError` codes (see `OmpCli.session*`). */
	async function runSession(args: string[], timeoutMs: number, what: string, archiveProblems: boolean): Promise<RunResult> {
		const binary = requireBinary();
		const result = await run(binary, args, { timeoutMs });
		if (result.timedOut) throw new AgentRuntimeError("timeout", `${what} timed out after ${timeoutMs} ms`);
		if (result.spawnError) throw new AgentRuntimeError("start_failed", `${what} failed to start: ${result.spawnError}`);
		if (result.code === 0) return result;
		const detail = extractErrorText(result.stderr) || clip(stripAnsi(result.stdout)) || `exit ${result.code ?? "?"}`;
		const details = { exitCode: result.code };
		if (LEASE_PATTERN.test(detail)) throw new AgentRuntimeError("session_locked", `${what} refused: ${detail}`, details);
		if (archiveProblems && ARCHIVE_PROBLEM_PATTERN.test(detail)) {
			throw new AgentRuntimeError("invalid_archive", `${what} failed: ${detail}`, details);
		}
		throw new AgentRuntimeError("rejected", `${what} failed: ${detail}`, details);
	}

	async function readRolesRaw(): Promise<Record<string, unknown>> {
		return parseRolesRaw(await runChecked(["config", "get", "modelRoles", "--json"], QUICK_TIMEOUT_MS, "omp config get"));
	}

	const cli: OmpCli = {
		async detect(): Promise<OmpInstall> {
			const binary = options.binary();
			if (!binary) {
				return {
					installed: false,
					version: null,
					binaryPath: null,
					configPath: null,
					error: "omp not found: install oh-my-pi (https://github.com/can1357/oh-my-pi) or set its path in settings",
				};
			}
			const version = await run(binary, ["--version"], { timeoutMs: QUICK_TIMEOUT_MS });
			if (version.code !== 0 || version.spawnError || version.timedOut) {
				const reason = version.timedOut
					? "`omp --version` timed out"
					: (version.spawnError ?? clip(stripAnsi(version.stderr) || `exit ${version.code}`));
				return { installed: false, version: null, binaryPath: binary, configPath: null, error: `omp at ${binary} is not usable: ${reason}` };
			}
			const configResult = await run(binary, ["config", "path"], { timeoutMs: QUICK_TIMEOUT_MS });
			const configPath = configResult.code === 0 ? configResult.stdout.trim() || null : null;
			return {
				installed: true,
				version: version.stdout.trim() || null,
				binaryPath: binary,
				configPath,
				...(configResult.code === 0
					? {}
					: { error: `omp config path failed: ${clip(stripAnsi(configResult.stderr) || `exit ${configResult.code}`)}` }),
			};
		},

		async models(opts): Promise<ModelInfo[]> {
			if (opts?.refresh) {
				modelsCache = null;
			} else if (modelsCache && Date.now() - modelsCache.at < MODELS_CACHE_MS) {
				return modelsCache.value;
			}
			if (modelsInFlight && !opts?.refresh) return modelsInFlight;
			const startedGeneration = ++generation;
			const promise = (async () => {
				const stdout = await runChecked(["models", "--json"], MODELS_TIMEOUT_MS, "omp models");
				const value = parseModels(stdout, log);
				// An `invalidate()` or newer refresh while we ran supersedes this result.
				if (startedGeneration === generation) modelsCache = { at: Date.now(), value };
				return value;
			})();
			modelsInFlight = promise;
			try {
				return await promise;
			} finally {
				if (modelsInFlight === promise) modelsInFlight = null;
			}
		},

		async modelRoles(): Promise<ModelRoles> {
			return onlyStrings(await readRolesRaw());
		},

		setModelRole(role, selector): Promise<ModelRoles> {
			if (!ROLE_PATTERN.test(role)) {
				return Promise.reject(new AgentRuntimeError("invalid_argument", `Invalid model role name: ${JSON.stringify(role)}`));
			}
			if (selector !== null && !isValidModelSelector(selector)) {
				return Promise.reject(
					new AgentRuntimeError("invalid_argument", `Invalid model selector: ${JSON.stringify(selector)} (expected provider/id[:thinking])`),
				);
			}
			const task = rolesQueue.then(async () => {
				// `omp config set modelRoles.<role> X` is "Unknown setting"; a record is replaced as a whole by a JSON value
				// (one argv element, never a shell string), so read-modify-write. An empty record is written with `reset`.
				const next = { ...(await readRolesRaw()) };
				for (const [key, value] of Object.entries(next)) {
					if (typeof value !== "string") continue; // preserved untouched
					if (!ROLE_PATTERN.test(key) || !isValidModelSelector(value)) {
						throw new AgentRuntimeError("rejected", `Existing model role ${JSON.stringify(key)} has an unexpected value; edit it with \`omp config\``, {
							role: key,
						});
					}
				}
				if (selector === null) delete next[role];
				else next[role] = selector;
				const args =
					Object.keys(next).length === 0
						? ["config", "reset", "modelRoles"]
						: ["config", "set", "modelRoles", JSON.stringify(next)];
				await runChecked(args, QUICK_TIMEOUT_MS, "omp config set");
				cli.invalidate();
				return onlyStrings(await readRolesRaw());
			});
			rolesQueue = task.catch(() => undefined);
			return task;
		},

		async testModel(selector, opts): Promise<ModelTestResult> {
			const started = Date.now();
			const fail = (error: string, output?: string): ModelTestResult => ({
				ok: false,
				selector,
				latencyMs: Date.now() - started,
				...(output ? { output } : {}),
				error,
			});
			if (!isValidModelSelector(selector)) return fail(`Invalid model selector: ${JSON.stringify(selector)}`);
			const binary = options.binary();
			if (!binary) return fail("omp not found");
			const timeoutMs = opts?.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
			// Smallest possible, non-persisted call: no session file, tools, extensions, skills, rules, context files,
			// LSP or title generation, a one-line system prompt and thinking off unless the selector pins a level.
			const args = [
				"-p",
				"--mode",
				"json",
				"--no-session",
				"--no-tools",
				"--no-lsp",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--no-context-files",
				"--no-title",
				"--system-prompt",
				TEST_SYSTEM_PROMPT,
				...(selector.includes(":") && /:(off|minimal|low|medium|high|xhigh|max)$/.test(selector) ? [] : ["--thinking", "off"]),
				"--model",
				selector,
				TEST_PROMPT,
			];
			const result = await run(binary, args, { timeoutMs });
			const latencyMs = Date.now() - started;
			if (result.timedOut) return fail(`Model did not answer within ${Math.round(timeoutMs / 1000)} s`);
			if (result.spawnError) return fail(`Failed to start omp: ${result.spawnError}`);
			const outcome = readPrintOutput(result.stdout);
			if (result.code === 0 && outcome && !outcome.error) {
				if (!outcome.text) return { ok: false, selector, latencyMs, error: "Model returned an empty answer" };
				return { ok: true, selector, latencyMs, output: clip(outcome.text, 500) };
			}
			const stderrText = extractErrorText(result.stderr);
			const error = outcome?.error ?? (stderrText || `omp exited with code ${result.code ?? "?"}`);
			return { ok: false, selector, latencyMs, ...(outcome?.text ? { output: clip(outcome.text, 500) } : {}), error };
		},

		async sessionPack(sessionFile, outPath, opts) {
			requireArgvValue("sessionFile", sessionFile);
			requireArgvValue("outPath", outPath);
			const source = resolve(sessionFile);
			const target = resolve(outPath);
			await requireFile("Session file", source, "invalid_argument");
			const result = await runSession(["session", "pack", source, target], opts?.timeoutMs ?? SESSION_TRANSFER_TIMEOUT_MS, "omp session pack", true);
			return { archivePath: lastLine(result.stdout) || target };
		},

		async sessionUnpack(archivePath, cwd, opts) {
			requireArgvValue("archivePath", archivePath);
			requireArgvValue("cwd", cwd);
			const archive = resolve(archivePath);
			// OMP resumes a session only when its header cwd equals OMP's own spelling of the process cwd.
			const dir = standardizeProjectDir(resolve(cwd));
			await requireFile("Archive", archive, "invalid_archive");
			const result = await runSession(["session", "unpack", archive, "--cwd", dir], opts?.timeoutMs ?? SESSION_TRANSFER_TIMEOUT_MS, "omp session unpack", true);
			const sessionFile = lastLine(result.stdout);
			if (!sessionFile || !isAbsolute(sessionFile) || !sessionFile.endsWith(".jsonl")) {
				throw new AgentRuntimeError("protocol", "`omp session unpack` did not print an absolute .jsonl session path", {
					stdout: clip(stripAnsi(result.stdout), 200),
				});
			}
			const note = stripAnsi(result.stderr);
			const mode = /diverged|fork/i.test(note)
				? "forked"
				: /replaced the local copy/i.test(note)
					? "replaced"
					: /unpacked session/i.test(note)
						? "created"
						: "unknown";
			return { sessionFile, mode };
		},

		async sessionMoved(sessionFile, to, opts) {
			requireArgvValue("sessionFile", sessionFile);
			requireArgvValue("to", to);
			const source = resolve(sessionFile);
			await requireFile("Session file", source, "invalid_argument");
			await runSession(["session", "moved", source, "--to", to], opts?.timeoutMs ?? SESSION_MOVED_TIMEOUT_MS, "omp session moved", false);
		},

		invalidate(): void {
			generation++;
			modelsCache = null;
		},
	};
	return cli;
}
