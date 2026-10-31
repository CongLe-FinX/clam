export type GitEngineErrorCode =
	| "git_missing"
	| "not_a_repo"
	| "invalid_ref"
	| "dest_not_empty"
	| "would_overwrite"
	| "dirty_worktree"
	| "auth_failed"
	| "network"
	| "timeout"
	| "operation_in_progress"
	| "secret_detected"
	| "failed";

export class GitEngineError extends Error {
	readonly code: GitEngineErrorCode;
	/** Credential-scrubbed git stderr, verbatim otherwise. */
	readonly stderr: string;

	constructor(code: GitEngineErrorCode, message: string, stderr = "", options?: { cause?: unknown }) {
		super(message, options);
		this.name = "GitEngineError";
		this.code = code;
		this.stderr = stderr;
	}
}

const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s'"]*@/gi;
const TOKEN_SHAPES: RegExp[] = [
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\b(Authorization:\s*(?:Basic|Bearer|token)\s+)[A-Za-z0-9+/=._~-]+/gi,
];

/** Removes URL userinfo and well-known token shapes (plus any exact `secrets`) from text that may reach logs or users. */
export function scrub(text: string, secrets?: Iterable<string>): string {
	let out = text.replace(USERINFO, "$1");
	for (const re of TOKEN_SHAPES) out = out.replace(re, (_m, prefix: unknown) => (typeof prefix === "string" ? `${prefix}***` : "***"));
	if (secrets) {
		for (const s of secrets) if (s.length >= 6) out = out.split(s).join("***");
	}
	return out;
}

/** `https://user:pass@host/x` → `https://host/x` (also scp-like and plain URLs pass through). */
export function stripUrlCredentials(url: string): string {
	return url.replace(USERINFO, "$1");
}

/** Maps git stderr to the closest engine error code. */
export function classifyFailure(stderr: string): GitEngineErrorCode {
	if (/not a git repository/i.test(stderr)) return "not_a_repo";
	if (
		/Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Invalid username or password|returned error: 40[13]|HTTP\/\d(?:\.\d)? 40[13]|Permission denied \(publickey\)|SAML/i.test(
			stderr,
		)
	)
		return "auth_failed";
	if (
		/Could not resolve host|Failed to connect|Connection (?:timed out|refused|reset)|Network is unreachable|Operation timed out|Empty reply from server|early EOF|RPC failed|SSL_ERROR|unable to access/i.test(
			stderr,
		)
	)
		return "network";
	if (/would be overwritten/i.test(stderr)) return "would_overwrite";
	if (/unknown revision|not a valid (?:ref|object name|branch name)|invalid reference|couldn't find remote ref|bad revision/i.test(stderr))
		return "invalid_ref";
	return "failed";
}
