import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type UrlVerdict = { ok: true; url: string } | { ok: false; code: "invalid" | "blocked"; message: string };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST_PORT = /^[^:/\s]+:\d{1,5}(?:[/?#]|$)/;
const HAS_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i;
const BLOCKED_FILE = "file:// is only allowed for files inside a project folder";

/** Hosts typed without a scheme that are reached over plain http: loopback, IPs, single-label and local-network names. */
function isLocalHost(host: string): boolean {
	const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (bare === "localhost" || bare.endsWith(".localhost") || bare.endsWith(".local") || bare.endsWith(".internal") || bare.endsWith(".lan")) return true;
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(":")) return true; // IPv4 / IPv6 literal
	return !bare.includes(".");
}

export interface UrlPolicy {
	/** Home directory for `~/` paths. */
	home: string;
	/** True when `file` (an absolute path) lies inside a project folder. */
	isProjectFile(file: string): boolean;
}

function resolveReal(file: string): string {
	let probe = path.resolve(file);
	const tail: string[] = [];
	for (;;) {
		try {
			return path.join(realpathSync(probe), ...tail.reverse());
		} catch {
			const parent = path.dirname(probe);
			if (parent === probe) return path.resolve(file);
			tail.push(path.basename(probe));
			probe = parent;
		}
	}
}

function fileVerdict(file: string, policy: UrlPolicy): UrlVerdict {
	const real = resolveReal(file);
	if (!policy.isProjectFile(real)) return { ok: false, code: "blocked", message: BLOCKED_FILE };
	return { ok: true, url: pathToFileURL(real).href };
}

/**
 * Turn what the owner typed into a URL the machine's browser may open. `localhost:1234` → `http://localhost:1234`, `3000` and
 * `:3000` → `http://localhost:3000`, other hosts get https (http for loopback/IP/local names), absolute paths open as `file://`
 * when inside a project folder. Browser-internal schemes (`chrome://`, `devtools://`, …) and `file://` outside project folders are refused.
 */
export function normalizeBrowserUrl(input: string, policy: UrlPolicy): UrlVerdict {
	const text = input.trim();
	if (!text) return { ok: false, code: "invalid", message: "Enter a URL, or a host and port such as localhost:3000" };
	if (text.toLowerCase() === "about:blank") return { ok: true, url: "about:blank" };

	if (text.startsWith("/") || text.startsWith("~/")) return fileVerdict(text.startsWith("~/") ? path.join(policy.home, text.slice(2)) : text, policy);

	const authority = HAS_AUTHORITY.test(text);
	const scheme = SCHEME.exec(text)?.[0].slice(0, -1).toLowerCase();
	// `localhost:3000` also looks like `scheme:rest`; it is a host:port when the part after the colon starts with a port number.
	const hostPort = !authority && scheme !== undefined && HOST_PORT.test(text);
	if (scheme !== undefined && !hostPort) {
		if (scheme === "file") {
			let file: string;
			try {
				file = fileURLToPath(authority ? text : `file://${text.slice(5).replace(/^\/*/, "/")}`);
			} catch {
				return { ok: false, code: "invalid", message: "That file URL is not valid" };
			}
			return fileVerdict(file, policy);
		}
		if (scheme === "http" || scheme === "https") {
			if (!authority) return { ok: false, code: "invalid", message: "That URL is not valid" };
		} else if (scheme === "about") {
			return { ok: false, code: "blocked", message: "Only about:blank can be opened" };
		} else {
			return { ok: false, code: "blocked", message: `${scheme}: addresses cannot be opened in this browser (only http, https and project files)` };
		}
	}

	if (/^\d{1,5}$/.test(text)) return normalizeBrowserUrl(`http://localhost:${text}`, policy);
	let candidate = text;
	if (candidate.startsWith(":")) candidate = `localhost${candidate}`;
	if (!SCHEME.test(candidate) || HOST_PORT.test(candidate)) {
		if (/\s/.test(candidate)) return { ok: false, code: "invalid", message: "Enter a URL, or a host and port such as localhost:3000" };
		const host = /^(\[[^\]]+\]|[^/?#:]+)/.exec(candidate)?.[1] ?? "";
		candidate = `${isLocalHost(host) ? "http" : "https"}://${candidate}`;
	}
	try {
		const parsed = new URL(candidate);
		if (!parsed.hostname) return { ok: false, code: "invalid", message: "That URL is not valid" };
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, code: "blocked", message: "Only http and https pages can be opened" };
		return { ok: true, url: parsed.href };
	} catch {
		return { ok: false, code: "invalid", message: "That URL is not valid" };
	}
}

/** Is a URL the page ended up on (redirect, `location = …`) one the viewer may stay on? Used to bounce a tab back to a blank page. */
export function isPermittedLocation(url: string, policy: UrlPolicy): boolean {
	if (url === "" || url === "about:blank" || url.startsWith("chrome-error://")) return true;
	if (url.startsWith("blob:http") || url.startsWith("data:") || url.startsWith("about:srcdoc")) return true; // pages' own constructed documents
	const verdict = normalizeBrowserUrl(url, policy);
	return verdict.ok;
}
