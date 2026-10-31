/**
 * @mention parsing of the group chat of a shared session. Pure, so the server (who is addressed) and the web composer (which
 * token the picker inserts, who the chip shows) apply exactly the same rules.
 */

/** An active member node with its agent, as the mention parser and the addressing rules see it. */
export interface MentionCandidate {
	nodeId: string;
	nodeName: string;
	agentId: string | null;
	agentName: string | null;
}

export interface MentionTarget {
	nodeId: string;
	agentId: string;
}

export interface MentionResult {
	/** `@all` was written. */
	all: boolean;
	/** Agents mentioned by agent name, machine name or both (one per node, in order of first mention). */
	agents: MentionTarget[];
}

const WORD = /[\p{L}\p{N}_]/u;

function boundaryAfter(text: string, index: number): boolean {
	const next = text[index];
	if (next === undefined) return true;
	if (WORD.test(next)) return false;
	return !(next === "-" && WORD.test(text[index + 1] ?? ""));
}

/** `OMP Agent` is mentioned as `@omp agent`, `@omp-agent`, `@omp_agent` or `@ompagent`; case does not matter. */
function aliases(name: string): string[] {
	const lower = name.trim().toLowerCase();
	if (lower === "") return [];
	return [...new Set([lower, lower.replace(/\s+/g, "-"), lower.replace(/\s+/g, "_"), lower.replace(/\s+/g, "")])];
}

/**
 * `@AgentName` (every agent with that name: ambiguity addresses them all), `@MachineName` (that machine's agent),
 * `@AgentName@MachineName` (exactly that agent: how two agents with the same name are told apart) and `@all`, all
 * case-insensitive. The longest token wins at each `@`, so a qualified mention beats the bare agent name it starts with. An
 * `@` glued to a word (an e-mail address) and an unknown name stay plain text. An ambiguous bare name directly followed by
 * `@machine` that matches nothing addresses nobody rather than fanning out to every agent of that name. Candidates without an
 * agent can only be matched by `@all`.
 */
export function parseMentions(text: string, candidates: readonly MentionCandidate[]): MentionResult {
	const byToken = new Map<string, Map<string, MentionTarget>>();
	const add = (token: string, target: MentionTarget) => {
		let targets = byToken.get(token);
		if (!targets) byToken.set(token, (targets = new Map()));
		targets.set(target.nodeId, target);
	};
	for (const c of candidates) {
		if (!c.agentId) continue;
		const target = { nodeId: c.nodeId, agentId: c.agentId };
		const machine = aliases(c.nodeName);
		const agent = aliases(c.agentName ?? "");
		for (const alias of [...agent, ...machine]) add(alias, target);
		for (const a of agent) for (const m of machine) add(`${a}@${m}`, target);
	}
	const known = [...byToken.keys()].sort((a, b) => b.length - a.length);
	const found = new Map<string, MentionTarget>();
	let all = false;
	const lower = text.toLowerCase();
	for (let at = lower.indexOf("@"); at !== -1; at = lower.indexOf("@", at + 1)) {
		if (at > 0 && WORD.test(lower[at - 1] as string)) continue;
		const start = at + 1;
		if (lower.startsWith("all", start) && boundaryAfter(lower, start + 3)) {
			all = true;
			continue;
		}
		const token = known.find((t) => lower.startsWith(t, start) && boundaryAfter(lower, start + t.length));
		if (!token) continue;
		const targets = byToken.get(token);
		if (!targets) continue;
		// `@OMP Agent@Typo`: a qualifier that matched nothing must not widen into every agent called "OMP Agent".
		if (targets.size > 1 && lower[start + token.length] === "@" && WORD.test(lower[start + token.length + 1] ?? "")) continue;
		for (const target of targets.values()) if (!found.has(target.nodeId)) found.set(target.nodeId, target);
	}
	return { all, agents: [...found.values()] };
}

/**
 * The tokens a picker inserts for `target`, each guaranteed (by running the parser itself) to address exactly that agent:
 * `agent` is `@AgentName` when no other agent shares the name, else the `machine` token; `machine` is `@MachineName` when
 * no other agent answers to it, else the qualified `@AgentName@MachineName`. A picker offering both drops the second when
 * they are equal.
 */
export function mentionTokens(target: MentionCandidate & { agentName: string }, candidates: readonly MentionCandidate[]): { agent: string; machine: string } {
	const qualified = `@${target.agentName}@${target.nodeName}`;
	const unique = (token: string): boolean => {
		const found = parseMentions(token, candidates);
		return !found.all && found.agents.length === 1 && found.agents[0]?.nodeId === target.nodeId;
	};
	const pick = (token: string) => (unique(token) ? token : qualified);
	const machine = pick(`@${target.nodeName}`);
	const agent = `@${target.agentName}`;
	return { agent: unique(agent) ? agent : machine, machine };
}
