#!/usr/bin/env node
// Fake cloudflared for tests: mimics real stderr lines and the metrics /ready endpoint.
// Behavior is controlled with FAKE_CF_* env vars (cloudflared option vars are TUNNEL_*, which the manager strips).
import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
	console.log("cloudflared version 2026.10.5 (built 2026-10-27T13:05:40Z)");
	process.exit(0);
}

const dir = process.env.FAKE_CF_DIR;
const behavior = process.env.FAKE_CF_BEHAVIOR ?? "ok";
const crashes = Number(process.env.FAKE_CF_CRASHES ?? "0");
const arg = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};
const ts = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const log = (level, msg) => process.stderr.write(`${ts()} ${level} ${msg}\n`);

const countFile = join(dir, "count");
const n = (existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0) + 1;
writeFileSync(countFile, String(n));

const tokenFile = arg("--token-file");
let token = null;
let tokenMode = null;
if (tokenFile) {
	token = readFileSync(tokenFile, "utf8");
	tokenMode = (statSync(tokenFile).mode & 0o777).toString(8);
}
writeFileSync(
	join(dir, `capture-${n}.json`),
	JSON.stringify({ argv, env: process.env, tokenFile, tokenMode, token, pid: process.pid, spawnedAtMs: Date.now() }),
);

process.on("SIGTERM", () => {
	writeFileSync(join(dir, `term-${n}`), "1");
	if (process.env.FAKE_CF_IGNORE_TERM === "1") return;
	process.exit(0);
});

if (behavior === "bad-token") {
	process.stderr.write("Provided Tunnel token is not valid.\nSee 'cloudflared tunnel run --help'.\n");
	process.exit(255);
}

const quick = argv.includes("--url");
if (quick) {
	log("INF", "Thank you for trying Cloudflare Tunnel. See https://api.trycloudflare.com/docs for details.");
	log("INF", "Requesting new quick Tunnel on trycloudflare.com...");
} else {
	log("INF", `Starting tunnel tunnelID=11111111-2222-3333-4444-555555555555`);
	if (token) log("DBG", `loaded credentials token=${token}`);
}

const connFile = join(dir, "conns");
const conns = () => (existsSync(connFile) ? Number(readFileSync(connFile, "utf8")) : 4);

const metrics = arg("--metrics");
const [host, port] = metrics.split(":");
const server = createServer((req, res) => {
	if (req.url === "/ready") {
		const c = conns();
		res.statusCode = c > 0 ? 200 : 503;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ status: res.statusCode, readyConnections: c, connectorId: "a538ee6e-3200-4887-8411-a31783b37666" }));
		return;
	}
	res.statusCode = 404;
	res.end();
});
server.listen(Number(port), host, () => {
	log("INF", `Starting metrics server on ${metrics}/metrics`);
	if (behavior === "crash-early" && n <= crashes) {
		log("ERR", 'Failed to dial a quic connection error="timeout"');
		process.exit(1);
	}
	if (quick) {
		setTimeout(() => {
			log("INF", "+--------------------------------------------------------------------------------------------+");
			log("INF", "|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |");
			log("INF", `|  https://fake-quick-${n}.trycloudflare.com                                                 |`);
			log("INF", "+--------------------------------------------------------------------------------------------+");
		}, 50);
	}
	setTimeout(() => {
		log("INF", "Registered tunnel connection connIndex=0 connection=6bd8ce2f event=0 ip=198.41.192.107 location=sin09 protocol=quic");
		if (behavior === "crash" && n <= crashes) {
			setTimeout(() => {
				log("ERR", "Unexpected failure in connection loop");
				process.exit(1);
			}, 250);
		}
	}, 150);
});
