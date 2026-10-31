import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitAuth {
	token(): Promise<string>;
	/** Default `x-access-token`. */
	username?: string;
}

const IS_WINDOWS = process.platform === "win32";
/** macOS limits AF_UNIX paths to 104 bytes, Linux to 108. */
const MAX_SOCKET_PATH = 100;

/** The helper git runs as GIT_ASKPASS. It only knows a one-time nonce and a socket path; it never sees the token until the broker hands it over. */
const HELPER_SOURCE = `import net from "node:net";
const socketPath = process.env.CLAM_ASKPASS_SOCKET;
const nonce = process.env.CLAM_ASKPASS_NONCE;
const prompt = process.argv[2] ?? "";
if (!socketPath || !nonce) process.exit(1);
const conn = net.connect(socketPath);
let buf = "";
conn.setTimeout(30000, () => process.exit(1));
conn.on("connect", () => conn.write(JSON.stringify({ nonce, prompt }) + "\\n"));
conn.on("data", (d) => { buf += d; });
conn.on("error", () => process.exit(1));
conn.on("close", () => {
	try {
		const r = JSON.parse(buf);
		if (r && r.ok === true && typeof r.value === "string") {
			process.stdout.write(r.value + "\\n", () => process.exit(0));
			return;
		}
	} catch {}
	process.exit(1);
});
`;

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface NonceEntry {
	auth: GitAuth;
	served: Set<"username" | "password">;
	secrets: Set<string>;
}

export interface AskpassLease {
	/** Environment to add to the git process (contains a nonce, never the token). */
	env: Record<string, string>;
	/** Values handed out so far, for scrubbing the command's output. */
	secrets: Set<string>;
	/** Invalidates the nonce; call when the git command has exited. */
	release(): void;
}

export interface AskpassBroker {
	lease(auth: GitAuth): AskpassLease;
	/** Number of live nonces (diagnostics/tests). */
	activeLeases(): number;
	close(): Promise<void>;
}

async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	await writeFile(tmp, content, { mode });
	await chmod(tmp, mode);
	await rename(tmp, path);
}

export async function createAskpassBroker(runtimeDir: string): Promise<AskpassBroker> {
	await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	await chmod(runtimeDir, 0o700);

	const helperJs = join(runtimeDir, "askpass.mjs");
	await writeAtomic(helperJs, HELPER_SOURCE, 0o600);
	const launcher = join(runtimeDir, IS_WINDOWS ? "askpass.cmd" : "askpass");
	if (IS_WINDOWS) {
		await writeAtomic(launcher, `@echo off\r\n"${process.execPath}" "${helperJs}" %*\r\n`, 0o700);
	} else {
		await writeAtomic(launcher, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helperJs)} "$@"\n`, 0o700);
	}

	const id = randomBytes(6).toString("hex");
	let socketDir: string | null = null;
	let socketPath: string;
	if (IS_WINDOWS) {
		socketPath = `\\\\.\\pipe\\clam-askpass-${id}`;
	} else {
		socketPath = join(runtimeDir, `ap-${id}.sock`);
		if (socketPath.length > MAX_SOCKET_PATH) {
			// Long data-dir paths cannot host a Unix socket; use a short private (0700) directory instead.
			socketDir = await mkdtemp(join(tmpdir(), "clam-ap-"));
			await chmod(socketDir, 0o700);
			socketPath = join(socketDir, `${id}.sock`);
		}
	}

	const nonces = new Map<string, NonceEntry>();

	const answer = async (raw: string): Promise<string> => {
		try {
			const req = JSON.parse(raw) as { nonce?: unknown; prompt?: unknown };
			if (typeof req.nonce !== "string" || typeof req.prompt !== "string") return JSON.stringify({ ok: false });
			const entry = nonces.get(req.nonce);
			if (!entry) return JSON.stringify({ ok: false });
			const kind = /^\s*username/i.test(req.prompt) ? "username" : /^\s*password/i.test(req.prompt) ? "password" : null;
			if (!kind || entry.served.has(kind)) return JSON.stringify({ ok: false });
			entry.served.add(kind);
			const value = kind === "username" ? (entry.auth.username ?? "x-access-token") : await entry.auth.token();
			if (kind === "password") entry.secrets.add(value);
			return JSON.stringify({ ok: true, value });
		} catch {
			return JSON.stringify({ ok: false });
		}
	};

	const server: Server = createServer((conn: Socket) => {
		let buf = "";
		let handled = false;
		conn.setEncoding("utf8");
		conn.setTimeout(30_000, () => conn.destroy());
		conn.on("error", () => conn.destroy());
		conn.on("data", (chunk: string) => {
			buf += chunk;
			if (buf.length > 4096) return void conn.destroy();
			const nl = buf.indexOf("\n");
			if (nl < 0 || handled) return;
			handled = true;
			void answer(buf.slice(0, nl)).then((reply) => conn.end(reply));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	if (!IS_WINDOWS) await chmod(socketPath, 0o600);
	server.unref();

	return {
		lease(auth) {
			const nonce = randomBytes(24).toString("base64url");
			const secrets = new Set<string>();
			nonces.set(nonce, { auth, served: new Set(), secrets });
			return {
				env: {
					GIT_ASKPASS: launcher,
					GIT_TERMINAL_PROMPT: "0",
					GCM_INTERACTIVE: "never",
					CLAM_ASKPASS_NONCE: nonce,
					CLAM_ASKPASS_SOCKET: socketPath,
				},
				secrets,
				release() {
					nonces.delete(nonce);
				},
			};
		},
		activeLeases: () => nonces.size,
		async close() {
			nonces.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			if (!IS_WINDOWS) await rm(socketPath, { force: true });
			if (socketDir) await rm(socketDir, { recursive: true, force: true });
		},
	};
}
