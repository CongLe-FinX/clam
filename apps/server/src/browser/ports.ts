import { execFile } from "node:child_process";
import { request } from "node:http";
import type { ListeningPort } from "@clam/contracts";

/** One listening TCP socket as an OS tool reports it. */
export interface RawListener {
	port: number;
	address: string;
	pid: number | null;
	process: string | null;
}

const unescapeLsof = (name: string): string => name.replace(/\\x([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

/** Split `host:port` where host may be `*`, an IPv4, `[::1]` or an unbracketed IPv6 (`::1`). */
function splitAddress(local: string): { address: string; port: number } | null {
	const cut = local.lastIndexOf(":");
	if (cut === -1) return null;
	const port = Number(local.slice(cut + 1));
	if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
	let address = local.slice(0, cut).replace(/^\[|\]$/g, "").replace(/%.+$/, "");
	if (address === "" || address === "0.0.0.0" || address === "::") address = "*";
	return { address, port };
}

/** `lsof -iTCP -sTCP:LISTEN -nP` (macOS, Linux). */
export function parseLsof(output: string): RawListener[] {
	const found: RawListener[] = [];
	for (const line of output.split("\n")) {
		const match = /^(\S+)\s+(\d+)\s+.*?\s(\S+)\s+\(LISTEN\)\s*$/.exec(line);
		if (!match) continue;
		const split = splitAddress(match[3]!);
		if (split) found.push({ ...split, pid: Number(match[2]), process: unescapeLsof(match[1]!) });
	}
	return found;
}

/** `ss -ltnpH` (Linux; `-H` = no header, but a header line is skipped anyway). */
export function parseSs(output: string): RawListener[] {
	const found: RawListener[] = [];
	for (const line of output.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields[0] !== "LISTEN" || fields.length < 5) continue;
		const split = splitAddress(fields[3]!);
		if (!split) continue;
		const users = /users:\(\("([^"]*)",pid=(\d+)/.exec(line);
		found.push({ ...split, pid: users ? Number(users[2]) : null, process: users?.[1] ?? null });
	}
	return found;
}

/** `netstat -ano` (Windows; also accepts the BSD/Linux layout's `LISTEN`). */
export function parseNetstat(output: string): RawListener[] {
	const found: RawListener[] = [];
	for (const line of output.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields[0]?.toUpperCase() !== "TCP" || !/^(LISTENING|LISTEN)$/i.test(fields[3] ?? "")) continue;
		const split = splitAddress(fields[1]!);
		if (split) found.push({ ...split, pid: Number(fields[4]) || null, process: null });
	}
	return found;
}

/** Tools worth naming in a chip, matched against the process's command line (first hit wins). */
const HINTS: Array<[RegExp, string]> = [
	[/\bvite\b/, "vite"],
	[/\bnext(?:-server|\s+(?:dev|start))\b|next\/dist/, "next"],
	[/\bnuxt/, "nuxt"],
	[/\bastro\b/, "astro"],
	[/webpack(?:-dev-server|\s+serve)|webpack\/bin/, "webpack"],
	[/\bparcel\b/, "parcel"],
	[/react-scripts/, "react-scripts"],
	[/\bremix\b/, "remix"],
	[/svelte-kit|sveltekit/, "svelte-kit"],
	[/storybook/, "storybook"],
	[/\bng\s+serve\b/, "angular"],
	[/\bexpo\b/, "expo"],
	[/http\.server/, "http.server"],
	[/\bhttp-server\b/, "http-server"],
	[/live-server/, "live-server"],
	[/\buvicorn\b/, "uvicorn"],
	[/\bflask\b/, "flask"],
	[/runserver/, "django"],
	[/\bgunicorn\b/, "gunicorn"],
	[/\b(?:puma|rails)\b/, "rails"],
	[/php\s+-S/, "php"],
	[/\bjekyll\b/, "jekyll"],
	[/\bhugo\b/, "hugo"],
	[/\bserve\b/, "serve"],
];

export function hintFromCommand(command: string): string | null {
	for (const [pattern, hint] of HINTS) if (pattern.test(command)) return hint;
	return null;
}

/** Ports that speak something other than HTTP by convention; they are listed (greyed out) but never probed. */
const NON_HTTP_PORTS = new Set([22, 25, 53, 110, 143, 389, 445, 465, 587, 993, 995, 1433, 3306, 5432, 5900, 6379, 11211, 27017]);

const isLoopback = (address: string): boolean => address === "127.0.0.1" || address === "::1" || address.startsWith("127.");

/** Collapse IPv4/IPv6 twins and several sockets of one port into one entry, preferring one reachable as `localhost`. */
export function mergeListeners(listeners: RawListener[]): RawListener[] {
	const rank = (l: RawListener): number => (l.address === "127.0.0.1" ? 0 : l.address === "*" ? 1 : l.address === "::1" ? 2 : 3);
	const byPort = new Map<number, RawListener>();
	for (const l of listeners) {
		const current = byPort.get(l.port);
		if (!current || rank(l) < rank(current) || (current.pid === null && l.pid !== null)) byPort.set(l.port, { ...l, pid: l.pid ?? current?.pid ?? null, process: l.process ?? current?.process ?? null });
	}
	return [...byPort.values()];
}

/** What to type to reach the listener from this machine: `localhost` when it accepts loopback connections, else its own address. */
export function urlFor(listener: RawListener): string {
	if (listener.address === "*" || isLoopback(listener.address)) return `localhost:${listener.port}`;
	return `${listener.address.includes(":") ? `[${listener.address}]` : listener.address}:${listener.port}`;
}

function run(file: string, args: string[], timeoutMs: number): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 << 20, windowsHide: true }, (error, stdout) => {
		// lsof exits 1 when it lists nothing; real failures (missing binary, timeout) have no useful stdout.
		resolve(error && !stdout ? null : stdout);
	});
	return promise;
}

/** Listening TCP sockets of this machine: lsof (macOS/Linux), ss, netstat as fallbacks. */
export async function readListeners(platform: NodeJS.Platform = process.platform): Promise<RawListener[]> {
	if (platform === "win32") return parseNetstat((await run("netstat", ["-ano", "-p", "TCP"], 5_000)) ?? "");
	// `+c 0`: the whole command name instead of lsof's 9-character cut.
	const lsof = await run("lsof", ["-iTCP", "-sTCP:LISTEN", "-nP", "+c", "0"], 5_000);
	if (lsof !== null && parseLsof(lsof).length > 0) return parseLsof(lsof);
	const ss = await run("ss", ["-ltnpH"], 5_000);
	if (ss !== null && parseSs(ss).length > 0) return parseSs(ss);
	return parseNetstat((await run("netstat", ["-an", "-p", "tcp"], 5_000)) ?? "");
}

export interface ProcessInfo {
	command: string;
	/** ISO start time of the process, when `ps` reported it. */
	startedAt: string | null;
	/** What the program is called (`node`, `python3`): the executable's name, never a thread name or a cut one. Null when `ps` did not say. */
	executable: string | null;
}

const baseName = (path: string): string => path.trim().replace(/\\+/g, "/").replace(/\/+$/, "").split("/").pop() ?? "";

/** `ps -o pid=,lstart=,command=`: `pid Sat Nov  1 01:00:00 2026 command line`. */
export function parsePsCommands(output: string): Map<number, { command: string; startedAt: string | null }> {
	const found = new Map<number, { command: string; startedAt: string | null }>();
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
		if (!match) continue;
		const started = Date.parse(match[2]!);
		found.set(Number(match[1]), { command: match[3]!, startedAt: Number.isNaN(started) ? null : new Date(started).toISOString() });
	}
	return found;
}

/** `ps -o pid=,comm=`: the executable (macOS: its full path, spaces included, Linux: the kernel's name of the process); everything after the pid is the name. */
export function parsePsComm(output: string): Map<number, string> {
	const found = new Map<number, string>();
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
		if (match) found.set(Number(match[1]), match[2]!);
	}
	return found;
}

/** Linux cuts `comm` at 15 characters; a longer program name is then recovered from the command line. */
const COMM_CUT = 15;

/**
 * The program a process runs, for the chip label: the basename of `ps`'s `comm`, which unlike lsof's COMMAND column is the
 * process's own name (lsof reports the name of the thread that holds the socket: a Node server shows up as `MainThrea`).
 * A `comm` that Linux cut is completed from the first word of the command line.
 */
export function executableName(comm: string | null, command: string): string | null {
	const fromComm = comm ? baseName(comm) : "";
	const fromCommand = baseName(command.trim().split(/\s+/)[0] ?? "");
	if (fromComm !== "" && fromComm.length >= COMM_CUT && fromCommand.length > fromComm.length && fromCommand.startsWith(fromComm)) return fromCommand;
	return fromComm || fromCommand || null;
}

/** Command line, executable and start time of `pids` (`ps`), for naming the tool behind a port and ordering by recency; empty on Windows. */
export async function readCommands(pids: number[], platform: NodeJS.Platform = process.platform): Promise<Map<number, ProcessInfo>> {
	const found = new Map<number, ProcessInfo>();
	if (platform === "win32" || pids.length === 0) return found;
	const list = pids.join(",");
	const [commands, comms] = await Promise.all([run("ps", ["-o", "pid=,lstart=,command=", "-p", list], 5_000), run("ps", ["-o", "pid=,comm=", "-p", list], 5_000)]);
	const names = parsePsComm(comms ?? "");
	for (const [pid, info] of parsePsCommands(commands ?? "")) found.set(pid, { ...info, executable: executableName(names.get(pid) ?? null, info.command) });
	return found;
}

/** What a short HTTP probe of a listening port learned. */
export interface WebProbe {
	/** Answered HTTP with an HTML or JSON response: something a browser can show. */
	web: boolean;
	/** `<title>` of the page, when it has one. */
	title: string | null;
	/** A CL Agent Mesh server (UI or wire listener): never offered, it is not the app being built. */
	clam: boolean;
}

const NOT_WEB: WebProbe = { web: false, title: null, clam: false };
const PROBE_TIMEOUT_MS = 300;
const MAX_PROBE_BODY = 64 * 1024;

interface HttpAnswer {
	status: number;
	contentType: string;
	body: string;
}

function get(host: string, port: number, path: string, timeoutMs: number, accept: string): Promise<HttpAnswer | null> {
	const { promise, resolve } = Promise.withResolvers<HttpAnswer | null>();
	let settled = false;
	const finish = (answer: HttpAnswer | null): void => {
		if (settled) return;
		settled = true;
		resolve(answer);
	};
	const req = request({ host, port, path, method: "GET", agent: false, timeout: timeoutMs, headers: { accept, "user-agent": "cl-agent-mesh-port-probe", connection: "close", host: `localhost:${port}` } }, (res) => {
		const chunks: Buffer[] = [];
		let size = 0;
		const done = (): void => {
			finish({ status: res.statusCode ?? 0, contentType: String(res.headers["content-type"] ?? "").toLowerCase(), body: Buffer.concat(chunks).toString("utf8") });
			req.destroy();
		};
		res.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			size += chunk.length;
			if (size >= MAX_PROBE_BODY) done();
		});
		res.on("end", done);
		res.on("error", () => finish(null));
	});
	req.on("timeout", () => {
		finish(null);
		req.destroy();
	});
	req.on("error", () => finish(null));
	req.end();
	return promise;
}

const decodeEntities = (text: string): string =>
	text.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/gi, (_m, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " })[name.toLowerCase()] ?? "");

export function extractTitle(html: string): string | null {
	const match = /<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(html);
	const title = match ? decodeEntities(match[1]!).replace(/\s+/g, " ").trim().slice(0, 120) : "";
	return title || null;
}

/**
 * Is this port a web server worth offering? One short loopback GET / (HTML or JSON back); then, for the ones that are, two more
 * short GETs tell a CL Agent Mesh server apart (its wire listener answers `/api/v1/node/info`, its UI listener `/api/local/node`).
 */
export async function probeWeb(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<WebProbe> {
	const root = await get(host, port, "/", timeoutMs, "text/html,application/json;q=0.9,*/*;q=0.5");
	if (!root || !/\b(html|json)\b/.test(root.contentType)) return NOT_WEB;
	const [wire, local] = await Promise.all([get(host, port, "/api/v1/node/info", timeoutMs, "application/json"), get(host, port, "/api/local/node", timeoutMs, "application/json")]);
	const isNode = (answer: HttpAnswer | null, key: string): boolean => answer?.status === 200 && answer.contentType.includes("json") && answer.body.includes(`"${key}"`);
	const clam = isNode(wire, "protocolVersions") || isNode(local, "fingerprint") || (root.contentType.includes("html") && extractTitle(root.body) === "CL Agent Mesh");
	return { web: true, title: root.contentType.includes("html") ? extractTitle(root.body) : null, clam };
}

/** OS and desktop-app daemons that answer HTTP on a local port but are not something being built (matched on lsof's truncated name). */
const SYSTEM_PROCESSES = /^(ControlCe|rapportd|sharingd|identitys|AirPlay|WiFiAgent|airportd|mDNSResp|launchd|systemd|cupsd|avahi|sshd|OrbStack|com\.docker|vpnkit|Dropbox|Spotify|Slack|Discord|figma_ag|zoom|Creative|AdobeIPC|nginx: master|Google|Chrom|Microsoft|Brave|Arc$|Firefox|Safari|Electron)/i;

export interface PortDiscoveryOptions {
	/** Ports of this node itself (UI + wire listener); read on every listing (a port may be chosen after boot). */
	selfPorts: () => number[];
	/** Processes whose listeners are never offered (this server, the browser it started). */
	selfPids: () => number[];
	platform?: NodeJS.Platform;
	/** Test seams. */
	read?: () => Promise<RawListener[]>;
	commands?: (pids: number[]) => Promise<Map<number, ProcessInfo>>;
	probe?: (host: string, port: number) => Promise<WebProbe>;
}

interface ProbeEntry {
	at: number;
	value: WebProbe;
}
const PROBE_TTL_MS = 20_000;
const MAX_PROBES = 60;

/** Port discovery with a short probe cache, so a Browser page refreshing the list every few seconds never re-probes a stable port. */
export class PortDiscovery {
	private readonly probes = new Map<string, ProbeEntry>();

	constructor(private readonly options: PortDiscoveryOptions) {}

	async list(): Promise<ListeningPort[]> {
		const read = this.options.read ?? (() => readListeners(this.options.platform));
		const selfPorts = this.options.selfPorts();
		const selfPids = this.options.selfPids();
		const raw = (await read()).filter((l) => !selfPorts.includes(l.port) && !(l.pid !== null && selfPids.includes(l.pid)));
		const merged = mergeListeners(raw);
		const pids = [...new Set(merged.flatMap((l) => (l.pid === null ? [] : [l.pid])))];
		const commands = await (this.options.commands ?? ((p) => readCommands(p, this.options.platform)))(pids);
		const probe = this.options.probe ?? ((host, port) => probeWeb(host, port));

		const now = Date.now();
		for (const [key, entry] of this.probes) if (now - entry.at > PROBE_TTL_MS * 3) this.probes.delete(key);
		let probesLeft = MAX_PROBES;
		const items = await Promise.all(
			merged.map(async (l): Promise<ListeningPort | null> => {
				const info = l.pid === null ? undefined : commands.get(l.pid);
				// lsof's own column is a (cut) thread name; the executable `ps` names is the real process name.
				const processName = info?.executable ?? l.process;
				if ((l.process !== null && SYSTEM_PROCESSES.test(l.process)) || (processName !== null && SYSTEM_PROCESSES.test(processName)) || NON_HTTP_PORTS.has(l.port)) return null;
				const key = `${l.port}:${l.pid ?? ""}:${l.address}`;
				let result = this.probes.get(key);
				if (!result || now - result.at >= PROBE_TTL_MS) {
					if (probesLeft-- <= 0) return null;
					result = { at: Date.now(), value: await probe(l.address === "*" ? "127.0.0.1" : l.address, l.port) };
					this.probes.set(key, result);
				}
				if (!result.value.web || result.value.clam) return null;
				return { port: l.port, address: l.address, pid: l.pid, process: processName, hint: info ? hintFromCommand(info.command) : null, likelyHttp: true, title: result.value.title, startedAt: info?.startedAt ?? null, url: urlFor(l) };
			}),
		);
		return items
			.filter((item): item is ListeningPort => item !== null)
			.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || a.port - b.port);
	}
}
