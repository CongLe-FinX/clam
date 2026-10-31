export interface SecretFinding {
	rule: string;
	/** 1-based. */
	line: number;
	/** The line around the hit with the secret itself redacted. */
	excerpt: string;
}

interface Rule {
	id: string;
	re: RegExp;
	/** Capture group holding the secret value (default: whole match). */
	group?: number;
	accept?: (match: RegExpExecArray, secret: string) => boolean;
}

const PLACEHOLDER = /^(?:\$\{|\$\(|\$[A-Za-z_]|<|%|\{\{|process\.env|import\.meta|os\.environ|env\.|getenv|null$|none$|nil$|true$|false$|undefined$|example|changeme|change-me|your[_-]|xxx|\*{3,}|\.{3}|redacted|placeholder|dummy|test$|secret$|password$|token$)/i;

const RULES: Rule[] = [
	{ id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
	{ id: "github-fine-grained-token", re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
	{ id: "aws-access-key-id", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
	{ id: "aws-secret-access-key", re: /aws_?secret_?(?:access_?)?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi, group: 1 },
	{ id: "private-key-block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED |PRIVATE )?(?:PRIVATE KEY|PRIVATE KEY BLOCK)-----/g },
	{ id: "slack-token", re: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g },
	{ id: "slack-webhook", re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g },
	{ id: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
	{ id: "anthropic-api-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
	{ id: "openai-api-key", re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
	{ id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ id: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
	{ id: "sendgrid-key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
	{ id: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:([^\s/@'"]+)@[^\s'"]+/gi, group: 1, accept: (_m, s) => !PLACEHOLDER.test(s) },
	{ id: "bearer-token", re: /\bBearer\s+([A-Za-z0-9._~+/-]{24,}=*)/g, group: 1, accept: (_m, s) => !PLACEHOLDER.test(s) },
	{
		id: "generic-secret-assignment",
		re: /[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret|token)(["']?)\s*[:=]\s*(["']?)([^\s"',;)}\]]{8,})/gi,
		group: 3,
		accept: (m, s) => {
			if (PLACEHOLDER.test(s)) return false;
			const quoted = m[2] !== "";
			if (quoted) return true;
			// Unquoted: only values that look generated, not identifiers or expressions.
			return s.length >= 12 && /[A-Za-z]/.test(s) && /\d/.test(s) && !/[(.]/.test(s);
		},
	},
];

const INDEXED_RULES: Rule[] = RULES.map((r) => ({ ...r, re: new RegExp(r.re.source, `${r.re.flags}d`) }));

function entropy(s: string): number {
	const counts = new Map<string, number>();
	for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let h = 0;
	for (const n of counts.values()) {
		const p = n / s.length;
		h -= p * Math.log2(p);
	}
	return h;
}

const CANDIDATE = /[A-Za-z0-9+/_=-]{32,}/g;
const SKIP_ENTROPY_PATH = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock)$|\.(?:min\.js|map|svg|lock)$/i;

function looksRandom(token: string): boolean {
	if (/^[0-9a-f]+$/i.test(token)) return false; // git shas, sha256 digests, hex ids
	if (/^[A-Za-z]+$/.test(token) || /^\d+$/.test(token)) return false;
	if ((token.match(/\//g)?.length ?? 0) >= 2) return false; // path-like
	if (!/[A-Za-z]/.test(token) || !/\d/.test(token)) return false;
	if (/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+$/.test(token) && /^[a-z0-9-]+$/.test(token) && (token.match(/-/g)?.length ?? 0) >= 3) return false; // kebab-case slugs
	return entropy(token) >= 4.5;
}

function redactLine(line: string, start: number, end: number, keep: number): string {
	const secret = line.slice(start, end);
	const redacted = `${secret.slice(0, Math.min(keep, Math.max(0, secret.length - 4)))}…[redacted ${secret.length} chars]`;
	const left = line.slice(Math.max(0, start - 30), start);
	const right = line.slice(end, end + 10);
	return `${left}${redacted}${right}`.trim();
}

/** Scans text for credentials. Never throws; excerpts never contain the secret itself. */
export function scanForSecrets(content: string, path: string): SecretFinding[] {
	const findings: SecretFinding[] = [];
	const skipEntropy = SKIP_ENTROPY_PATH.test(path);
	const lines = content.split(/\r?\n/);
	for (let n = 0; n < lines.length; n++) {
		const line = lines[n] as string;
		if (line.length > 20_000) continue; // minified blobs: not reviewable text
		const spans: Array<[number, number]> = [];
		const hit = (rule: string, start: number, end: number, keep: number) => {
			spans.push([start, end]);
			findings.push({ rule, line: n + 1, excerpt: redactLine(line, start, end, keep) });
		};
		for (const rule of INDEXED_RULES) {
			rule.re.lastIndex = 0;
			let m: RegExpExecArray | null = rule.re.exec(line);
			while (m) {
				const g = rule.group ?? 0;
				const secret = m[g];
				const span = m.indices?.[g];
				if (secret && span && (!rule.accept || rule.accept(m, secret)) && !spans.some(([a, b]) => span[0] < b && span[1] > a)) {
					const keepPrefix = rule.id.startsWith("generic") || rule.id === "url-credentials" || rule.id === "bearer-token" ? 0 : 4;
					hit(rule.id, span[0], span[1], keepPrefix);
				}
				if (m[0].length === 0) rule.re.lastIndex++;
				m = rule.re.exec(line);
			}
		}
		if (skipEntropy) continue;
		CANDIDATE.lastIndex = 0;
		let c: RegExpExecArray | null = CANDIDATE.exec(line);
		while (c) {
			const start = c.index;
			const end = start + c[0].length;
			if (!spans.some(([a, b]) => start < b && end > a) && looksRandom(c[0])) hit("high-entropy-string", start, end, 0);
			c = CANDIDATE.exec(line);
		}
	}
	return findings;
}
