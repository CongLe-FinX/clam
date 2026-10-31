import { scanForSecrets } from "@clam/git-engine";

/** A secret-looking value found in a manifest. Never contains the value itself. */
export interface ManifestSecretFinding {
	/** JSON path of the string, e.g. `$.conversationSummary.text` or `$.environment.setupCommands[1]`. */
	path: string;
	rule: string;
	/** 1-based line inside the string. */
	line: number;
	/** The line around the hit with the secret redacted (from the shared scanner). */
	excerpt: string;
}

export class SecretDetectedError extends Error {
	readonly code = "secret_detected" as const;
	constructor(readonly findings: ManifestSecretFinding[]) {
		super(
			`Possible secret in handoff manifest: ${findings.map((f) => `${f.rule} at ${f.path}:${f.line}`).join(", ")}`,
		);
		this.name = "SecretDetectedError";
	}
}

/** Keys whose values are identifiers/digests: opaque ids may look random, so only the entropy heuristic is waived. */
const ID_KEY = /(?:^|\.)(?:id|[A-Za-z]*Id|sha256|commit|baseCommit|fingerprint|lockfile)$/;

/**
 * Scans every string value (and every object key) of `value` with the repository's secret scanner
 * (`@clam/git-engine` `scanForSecrets`: GitHub/AWS/Slack/Stripe/OpenAI/Anthropic tokens, private key blocks,
 * credentials in URLs, `api_key=…` assignments, high-entropy strings).
 */
export function scanManifestForSecrets(value: unknown): ManifestSecretFinding[] {
	const findings: ManifestSecretFinding[] = [];
	walk(value, "$", findings);
	return findings;
}

/** Throws {@link SecretDetectedError} when {@link scanManifestForSecrets} finds anything. */
export function assertSecretFree(value: unknown): void {
	const findings = scanManifestForSecrets(value);
	if (findings.length > 0) throw new SecretDetectedError(findings);
}

function scanString(text: string, path: string, findings: ManifestSecretFinding[]): void {
	const idLike = ID_KEY.test(path);
	for (const f of scanForSecrets(text, "manifest.json")) {
		if (idLike && f.rule === "high-entropy-string") continue;
		findings.push({ path, rule: f.rule, line: f.line, excerpt: f.excerpt });
	}
}

function walk(value: unknown, path: string, findings: ManifestSecretFinding[]): void {
	if (typeof value === "string") {
		scanString(value, path, findings);
	} else if (Array.isArray(value)) {
		value.forEach((item, i) => walk(item, `${path}[${i}]`, findings));
	} else if (value !== null && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			// A secret used as a key (e.g. a map keyed by token) is just as leaked as one used as a value.
			scanString(key, `${path}.<key>`, findings);
			walk(child, `${path}.${key}`, findings);
		}
	}
}
