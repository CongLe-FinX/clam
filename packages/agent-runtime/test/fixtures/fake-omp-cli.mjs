// Test fixture: non-RPC half of the fake `omp` binary (see fake-omp.mjs).
// State lives under env FAKE_OMP_HOME: config.json (settings), calls.jsonl (one argv per invocation).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

const MODELS = [
	{
		provider: "fake",
		kind: "chat",
		id: "alpha",
		selector: "fake/alpha",
		name: "Alpha",
		contextWindow: 200000,
		maxTokens: 8000,
		reasoning: true,
		thinking: ["low", "high"],
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		pricingStatus: "fixed",
	},
	{
		provider: "fake",
		kind: "chat",
		id: "unpriced",
		selector: "fake/unpriced",
		name: "Unpriced",
		contextWindow: 1000,
		maxTokens: null,
		reasoning: false,
		thinking: [],
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		pricingStatus: "unknown",
	},
	{ provider: "fake", kind: "chat", selector: "fake/no-id-malformed", name: "Broken" },
	{ provider: "fake", kind: "embedding", id: "embed", selector: "fake/embed", name: "Embedding" },
	"not-an-object",
];

function home(env) {
	const dir = env.FAKE_OMP_HOME;
	if (!dir) throw new Error("FAKE_OMP_HOME is not set");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function readConfig(dir) {
	const file = join(dir, "config.json");
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function writeConfig(dir, config) {
	writeFileSync(join(dir, "config.json"), JSON.stringify(config));
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const LEASE_REFUSAL = "error: Cannot pack <FILE>: another live omp process writes this session. Exit it first. Nothing was changed.";
const ARCHIVE_FORMAT = "fake-omp-session-archive";

/** pid recorded in the session's ownership lock when that process is still alive, else null (missing or stale lock). */
function liveLockPid(sessionFile) {
	const lock = join(dirname(sessionFile), `.${basename(sessionFile)}.lock.os`);
	if (!existsSync(lock)) return null;
	const pid = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		process.kill(pid, 0);
		return pid;
	} catch (error) {
		return error.code === "EPERM" ? pid : null;
	}
}

function fail(message) {
	process.stderr.write(`${message}\n`);
	return 1;
}

function refuseIfLocked(file) {
	return liveLockPid(file) === null ? null : fail(LEASE_REFUSAL.replace("<FILE>", file));
}

function customLine(customType, content) {
	return `${JSON.stringify({ type: "message", message: { role: "custom", customType, content, display: true, timestamp: 1 } })}\n`;
}

/** Deterministic padding so archives are not trivially small (a real archive is a tar with manifest + blobs). */
function padding(seed) {
	return createHash("sha256").update(seed).digest("hex").repeat(32);
}

async function runSession(args, env, dir) {
	if (env.FAKE_OMP_SESSION_SLOW_MS) await sleep(Number(env.FAKE_OMP_SESSION_SLOW_MS));
	const [, action] = args;
	if (action === "pack") {
		const [, , file, out] = args;
		if (!file || !out) return fail("error: usage: omp session pack <session.jsonl> <out.tar>");
		if (!existsSync(file)) return fail(`error: Session file not found: ${file}`);
		const refused = refuseIfLocked(file);
		if (refused !== null) return refused;
		const journal = readFileSync(file, "utf8");
		const header = JSON.parse(journal.split("\n")[0]);
		const envelope = {
			format: ARCHIVE_FORMAT,
			manifest: { version: 1, id: header.id, cwd: header.cwd, omp: "18.14.0" },
			sha256: createHash("sha256").update(journal).digest("hex"),
			session: journal,
			pad: padding(journal),
		};
		mkdirSync(dirname(resolve(out)), { recursive: true });
		writeFileSync(out, JSON.stringify(envelope));
		process.stdout.write(`${resolve(out)}\n`);
		return 0;
	}
	if (action === "unpack") {
		const [, , archive] = args;
		const cwdIndex = args.indexOf("--cwd");
		const cwd = cwdIndex === -1 ? undefined : args[cwdIndex + 1];
		if (!archive || !cwd) return fail("error: usage: omp session unpack <archive.tar> --cwd <dir>");
		if (!existsSync(archive)) return fail(`error: Archive not found: ${archive}`);
		let envelope;
		try {
			envelope = JSON.parse(readFileSync(archive, "utf8"));
		} catch {
			return fail(`error: Not a session archive: ${archive}`);
		}
		if (envelope?.format !== ARCHIVE_FORMAT || typeof envelope.session !== "string" || typeof envelope.manifest?.id !== "string") {
			return fail(`error: Not a session archive: ${archive} (bad manifest)`);
		}
		if (createHash("sha256").update(envelope.session).digest("hex") !== envelope.sha256) {
			return fail("error: Archive integrity check failed: sha256 mismatch for session.jsonl");
		}
		const lines = envelope.session.split("\n").filter(Boolean);
		const header = { ...JSON.parse(lines[0]), cwd: resolve(cwd) };
		const stamp = new Date(0).toISOString().replace(/[:.]/g, "-");
		const target = join(dir, "sessions", resolve(cwd).replaceAll("/", "-"), `${stamp}_${header.id}.jsonl`);
		mkdirSync(dirname(target), { recursive: true });
		const body = [JSON.stringify(header), ...lines.slice(1)].map((line) => `${line}\n`).join("");
		writeFileSync(target, body + customLine("arrived", `This session arrived from another node (${envelope.manifest.cwd}).`));
		process.stderr.write(`Unpacked session (${header.id}).\n`);
		process.stdout.write(`${target}\n`);
		return 0;
	}
	if (action === "moved") {
		const [, , file] = args;
		const toIndex = args.indexOf("--to");
		const label = toIndex === -1 ? undefined : args[toIndex + 1];
		if (!file || !label) return fail("error: usage: omp session moved <session.jsonl> --to <label>");
		if (!existsSync(file)) return fail(`error: Session file not found: ${file}`);
		const refused = refuseIfLocked(file);
		if (refused !== null) return refused;
		appendFileSync(file, customLine("departed", `This session moved to ${label}.`));
		return 0;
	}
	return fail(`error: Unknown session command: ${action ?? ""}`);
}

export async function runCli(argv, env) {
	const dir = home(env);
	appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify(argv)}\n`);
	let args = [...argv];
	if (args[0] === "--profile") args = args.slice(2);

	if (args[0] === "session") return runSession(args, env, dir);
	if (args[0] === "--version") {
		process.stdout.write("omp/18.14.0\n");
		return 0;
	}
	if (args[0] === "config") {
		const [, action, key, value] = args;
		if (action === "path") {
			process.stdout.write(`${dir}\n`);
			return 0;
		}
		const config = readConfig(dir);
		if (action === "get") {
			if (key !== "modelRoles") {
				process.stderr.write(`Unknown setting: ${key}\n`);
				return 1;
			}
			process.stdout.write(`${JSON.stringify({ key, value: config.modelRoles ?? {}, type: "record", description: "" }, null, 2)}\n`);
			return 0;
		}
		if (action === "set") {
			if (key !== "modelRoles") {
				process.stderr.write(`Unknown setting: ${key}\n\nRun 'omp config list' to see available keys\n`);
				return 1;
			}
			try {
				config.modelRoles = JSON.parse(value);
			} catch {
				process.stderr.write("Invalid value\n");
				return 1;
			}
			writeConfig(dir, config);
			process.stdout.write(`Set ${key} = ${value}\n`);
			return 0;
		}
		if (action === "reset") {
			delete config[key];
			writeConfig(dir, config);
			process.stdout.write(`Reset ${key} to {}\n`);
			return 0;
		}
		process.stderr.write(`Unknown action ${action}\n`);
		return 1;
	}
	if (args[0] === "models") {
		process.stdout.write(`${JSON.stringify({ models: MODELS })}\n`);
		return 0;
	}
	if (args.includes("-p") || args.includes("--print")) {
		const model = args[args.indexOf("--model") + 1] ?? "";
		if (model.includes("slow") || env.FAKE_OMP_SLOW_MS) {
			await sleep(Number(env.FAKE_OMP_SLOW_MS ?? 60000));
		}
		if (model.includes("bad")) {
			process.stderr.write(
				`16338 | stack\n          ^\nerror: No API key found for ${model.split("/")[0]}.\n\nUse /login, set an API key environment variable\n      at #Bn (/$bunfs/root/chunks/cli.js:1:1)\n`,
			);
			process.stdout.write(`${JSON.stringify({ type: "session", version: 3 })}\n`);
			return 1;
		}
		const assistant = { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop" };
		process.stdout.write(`${JSON.stringify({ type: "session", version: 3 })}\n`);
		process.stdout.write(`${JSON.stringify({ type: "message_end", message: assistant })}\n`);
		return 0;
	}
	process.stderr.write(`fake omp: unsupported invocation ${JSON.stringify(args)}\n`);
	return 2;
}
