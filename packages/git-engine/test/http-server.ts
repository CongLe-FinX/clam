import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface SeenRequest {
	method: string;
	url: string;
	user: string | null;
	status: number;
}

export interface GitHttpServer {
	url: string;
	requests: SeenRequest[];
	close(): Promise<void>;
}

export interface GitHttpServerOptions {
	root: string;
	/** token → capabilities. Unknown/missing credentials get 401. */
	tokens: Record<string, { write: boolean }>;
}

function collect(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/** A real Smart-HTTP git server: `git http-backend` behind HTTP Basic auth. */
export async function startGitHttpServer(opts: GitHttpServerOptions): Promise<GitHttpServer> {
	const requests: SeenRequest[] = [];
	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const header = req.headers.authorization ?? "";
		let user: string | null = null;
		let cred: { write: boolean } | undefined;
		if (header.startsWith("Basic ")) {
			const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
			const idx = decoded.indexOf(":");
			user = decoded.slice(0, idx);
			cred = opts.tokens[decoded.slice(idx + 1)];
		}
		const body = await collect(req);
		const record = (status: number) => requests.push({ method: req.method ?? "GET", url: req.url ?? "", user, status });
		if (!cred) {
			record(401);
			res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"', "Content-Type": "text/plain" }).end("Authentication required\n");
			return;
		}
		const isPush = url.pathname.endsWith("/git-receive-pack") || url.searchParams.get("service") === "git-receive-pack";
		if (isPush && !cred.write) {
			record(403);
			res.writeHead(403, { "Content-Type": "text/plain" }).end(`Permission to demo/repo.git denied to ${user}.\n`);
			return;
		}
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			GIT_PROJECT_ROOT: opts.root,
			GIT_HTTP_EXPORT_ALL: "1",
			REQUEST_METHOD: req.method ?? "GET",
			PATH_INFO: url.pathname,
			QUERY_STRING: url.search.slice(1),
			CONTENT_TYPE: req.headers["content-type"] ?? "",
			CONTENT_LENGTH: String(body.length),
			REMOTE_USER: user ?? "anonymous",
			REMOTE_ADDR: "127.0.0.1",
		};
		if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = String(req.headers["content-encoding"]);
		if (req.headers["git-protocol"]) env.HTTP_GIT_PROTOCOL = String(req.headers["git-protocol"]);
		const cgi = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "ignore"] });
		cgi.stdin.on("error", () => {});
		cgi.stdin.end(body);
		const out: Buffer[] = [];
		cgi.stdout.on("data", (c: Buffer) => out.push(c));
		await new Promise<void>((resolve) => cgi.on("close", () => resolve()));
		const raw = Buffer.concat(out);
		const sep = raw.indexOf("\r\n\r\n");
		const head = raw.subarray(0, sep < 0 ? 0 : sep).toString("utf8");
		const payload = raw.subarray(sep < 0 ? 0 : sep + 4);
		let status = 200;
		const headers: Record<string, string> = {};
		for (const line of head.split("\r\n")) {
			const i = line.indexOf(":");
			if (i < 0) continue;
			const k = line.slice(0, i).trim();
			const v = line.slice(i + 1).trim();
			if (k.toLowerCase() === "status") status = Number.parseInt(v, 10);
			else headers[k] = v;
		}
		record(status);
		res.writeHead(status, headers).end(payload);
	};
	const server: Server = createServer((req, res) => {
		handle(req, res).catch(() => {
			res.writeHead(500).end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
