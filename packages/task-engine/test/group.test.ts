import { type MentionCandidate, mentionTokens, parseMentions } from "@clam/contracts";
import { describe, expect, it } from "vitest";
import {
	BUFFER_MAX_CHARS,
	buildSharedMessageInjection,
	buildSinceLastTurnBlock,
	compareGroupMessages,
	formatHlc,
	isAddressed,
	mergeHlc,
	orderGroupMessages,
	parseHlc,
	parseSharedInjectionHeader,
	pickFallbackAgent,
	resolveRecipients,
	tickHlc,
	wakeBudget,
	wakesAgents,
	type MessageTo,
} from "../src/index.ts";

const A: MentionCandidate = { nodeId: "node_a", nodeName: "Node-A", agentId: "ag_a", agentName: "Ada" };
const B: MentionCandidate = { nodeId: "node_b", nodeName: "Node-B", agentId: "ag_b", agentName: "Bob Builder" };
const C: MentionCandidate = { nodeId: "node_c", nodeName: "Node-C", agentId: "ag_c", agentName: "Bob Builder" };
const D: MentionCandidate = { nodeId: "node_d", nodeName: "Node-D", agentId: null, agentName: null };
const targets = (...c: MentionCandidate[]) => c.map((x) => ({ nodeId: x.nodeId, agentId: x.agentId as string }));

describe("hybrid logical clock", () => {
	it("formats to a fixed width that sorts like the clock and parses back", () => {
		const early = formatHlc({ wall: 1_793_427_266_195, counter: 0 });
		const sameMs = formatHlc({ wall: 1_793_427_266_195, counter: 12 });
		const later = formatHlc({ wall: 1_793_427_266_196, counter: 0 });
		expect(early).toBe("001793427266195-00000");
		expect([later, sameMs, early].sort()).toEqual([early, sameMs, later]);
		expect(parseHlc(sameMs)).toEqual({ wall: 1_793_427_266_195, counter: 12 });
		for (const bad of ["", "1793427266195-00000", "001793427266195-0", "x01793427266195-00000", "001793427266195_00000"]) expect(parseHlc(bad), bad).toBeNull();
	});

	it("ticks monotonically when the wall clock stalls or steps back", () => {
		let last = tickHlc(null, 1000);
		expect(last).toEqual({ wall: 1000, counter: 0 });
		last = tickHlc(last, 1000);
		expect(last).toEqual({ wall: 1000, counter: 1 });
		last = tickHlc(last, 900);
		expect(last).toEqual({ wall: 1000, counter: 2 });
		last = tickHlc(last, 1001);
		expect(last).toEqual({ wall: 1001, counter: 0 });
		// the counter overflows into the next millisecond instead of wrapping
		expect(tickHlc({ wall: 5, counter: 99_999 }, 5)).toEqual({ wall: 6, counter: 0 });
	});

	it("merges a remote stamp above both clocks", () => {
		expect(mergeHlc({ wall: 100, counter: 3 }, { wall: 100, counter: 7 }, 50)).toEqual({ wall: 100, counter: 8 });
		expect(mergeHlc({ wall: 100, counter: 3 }, { wall: 90, counter: 7 }, 50)).toEqual({ wall: 100, counter: 4 });
		expect(mergeHlc({ wall: 100, counter: 3 }, { wall: 120, counter: 7 }, 50)).toEqual({ wall: 120, counter: 8 });
		expect(mergeHlc({ wall: 100, counter: 3 }, { wall: 90, counter: 7 }, 200)).toEqual({ wall: 200, counter: 0 });
		expect(mergeHlc(null, { wall: 90, counter: 7 }, 50)).toEqual({ wall: 90, counter: 8 });
	});

	it("orders messages by (hlc, origin node, id) whatever the arrival order", () => {
		const m = (id: string, hlc: string, authorNodeId: string) => ({ id, hlc, authorNodeId });
		const messages = [m("z", "002-0", "a"), m("b", "001-0", "b"), m("a", "001-0", "b"), m("c", "001-0", "a")];
		expect(orderGroupMessages(messages).map((x) => x.id)).toEqual(["c", "a", "b", "z"]);
		expect(orderGroupMessages([...messages].reverse()).map((x) => x.id)).toEqual(["c", "a", "b", "z"]);
		expect(compareGroupMessages(m("x", "1", "a"), m("x", "1", "a"))).toBe(0);
	});
});

describe("parseMentions", () => {
	const all = [A, B, C, D];

	it("matches agent names and node names, case-insensitively", () => {
		expect(parseMentions("hey @ada, look", all)).toEqual({ all: false, agents: targets(A) });
		expect(parseMentions("@NODE-A please", all)).toEqual({ all: false, agents: targets(A) });
		expect(parseMentions("@node-a and @Node-C", all)).toEqual({ all: false, agents: targets(A, C) });
	});

	it("an ambiguous agent name addresses every agent with that name", () => {
		expect(parseMentions("@Bob Builder, can you check?", all).agents).toEqual(targets(B, C));
		expect(parseMentions("@bob-builder", all).agents).toEqual(targets(B, C));
		expect(parseMentions("@bob_builder", all).agents).toEqual(targets(B, C));
		expect(parseMentions("@bobbuilder", all).agents).toEqual(targets(B, C));
		// a node name is unique, so it picks one
		expect(parseMentions("@Node-B only", all).agents).toEqual(targets(B));
	});

	it("@all, in any case, anywhere", () => {
		expect(parseMentions("@all stop", all)).toEqual({ all: true, agents: [] });
		expect(parseMentions("ok @ALL.", all).all).toBe(true);
		expect(parseMentions("(@all)", all).all).toBe(true);
	});

	it("unknown mentions, words glued to an @ and partial names stay plain text", () => {
		expect(parseMentions("@nobody and @alloy and @ad", all)).toEqual({ all: false, agents: [] });
		expect(parseMentions("write to ada@example.com", all)).toEqual({ all: false, agents: [] });
		expect(parseMentions("@node-a-extra", all)).toEqual({ all: false, agents: [] });
		expect(parseMentions("@types/node", all)).toEqual({ all: false, agents: [] });
		// a node without an agent cannot be addressed by name
		expect(parseMentions("@node-d", all)).toEqual({ all: false, agents: [] });
	});

	it("the longest name wins and every mention counts once", () => {
		const longer: MentionCandidate = { nodeId: "node_e", nodeName: "Node-E", agentId: "ag_e", agentName: "Ada Lovelace" };
		expect(parseMentions("@Ada Lovelace you too", [A, longer]).agents).toEqual(targets(longer));
		expect(parseMentions("@ada then @Ada then @node-a", [A, longer]).agents).toEqual(targets(A));
	});

	describe("two agents with the same name on different machines", () => {
		const alpha: MentionCandidate = { nodeId: "node_alpha", nodeName: "Alpha", agentId: "ag_1", agentName: "OMP Agent" };
		const bravo: MentionCandidate = { nodeId: "node_bravo", nodeName: "Bravo", agentId: "ag_2", agentName: "OMP Agent" };
		const twins = [alpha, bravo];

		it("a qualified @agent@machine mention addresses exactly one agent", () => {
			expect(parseMentions("@OMP Agent@Bravo please look", twins).agents).toEqual(targets(bravo));
			expect(parseMentions("@OMP Agent@Alpha", twins).agents).toEqual(targets(alpha));
			expect(parseMentions("@omp-agent@bravo, @ompagent@ALPHA", twins).agents).toEqual(targets(bravo, alpha));
			expect(parseMentions("hi @OMP Agent@Bravo", twins).agents).toEqual(targets(bravo));
		});

		it("a qualified mention works with a machine name that has spaces or hyphens", () => {
			const mac: MentionCandidate = { nodeId: "node_mac", nodeName: "Cong's Mac mini", agentId: "ag_3", agentName: "OMP Agent" };
			const lin: MentionCandidate = { nodeId: "node_lin", nodeName: "build-box", agentId: "ag_4", agentName: "OMP Agent" };
			expect(parseMentions("@OMP Agent@Cong's Mac mini go", [mac, lin]).agents).toEqual(targets(mac));
			expect(parseMentions("@OMP Agent@build-box go", [mac, lin]).agents).toEqual(targets(lin));
			expect(parseMentions("@OMP Agent@build box go", [mac, lin]).agents).toEqual([]);
		});

		it("the machine short form addresses one agent; the bare ambiguous name still addresses all of them", () => {
			expect(parseMentions("@Bravo", twins).agents).toEqual(targets(bravo));
			expect(parseMentions("@OMP Agent", twins).agents).toEqual(targets(alpha, bravo));
		});

		it("a qualifier that matches nothing never widens into every agent of that name", () => {
			expect(parseMentions("@OMP Agent@Charlie hello", twins)).toEqual({ all: false, agents: [] });
			// …but a unique name keeps working next to punctuation
			expect(parseMentions("@Ada, @Bob Builder@Node-C", [A, B, C]).agents).toEqual(targets(A, C));
		});

		it("an agent whose name is another machine's name is still told apart by the qualified form", () => {
			const odd: MentionCandidate = { nodeId: "node_x", nodeName: "Bravo", agentId: "ag_x", agentName: "Zed" };
			const other: MentionCandidate = { nodeId: "node_y", nodeName: "Yankee", agentId: "ag_y", agentName: "Bravo" };
			expect(parseMentions("@Zed@Bravo", [odd, other]).agents).toEqual(targets(odd));
			expect(parseMentions("@Bravo@Yankee", [odd, other]).agents).toEqual(targets(other));
		});

		it("resolveRecipients: a human message with the qualified token goes to that agent only", () => {
			expect(resolveRecipients({ author: "human", authorNodeId: "node_alpha", text: "@OMP Agent@Bravo answer this", candidates: twins })).toEqual({ mode: "agents", agents: targets(bravo) });
		});

		it("the picker's tokens each address exactly the one agent they were made for", () => {
			const solo: MentionCandidate = { nodeId: "node_s", nodeName: "Sierra", agentId: "ag_s", agentName: "Ada" };
			const group = [alpha, bravo, solo];
			// ambiguous agent name → the machine short form
			expect(mentionTokens({ ...bravo, agentName: "OMP Agent" }, group)).toEqual({ agent: "@Bravo", machine: "@Bravo" });
			// unique agent name → the name; the machine form is its own option
			expect(mentionTokens({ ...solo, agentName: "Ada" }, group)).toEqual({ agent: "@Ada", machine: "@Sierra" });
			for (const c of group) {
				const t = mentionTokens({ ...c, agentName: c.agentName as string }, group);
				for (const token of [t.agent, t.machine]) expect(parseMentions(token, group), token).toEqual({ all: false, agents: targets(c) });
			}
		});

		it("falls back to @agent@machine when the machine name is itself another agent's name", () => {
			const odd: MentionCandidate = { nodeId: "node_x", nodeName: "Bravo", agentId: "ag_x", agentName: "OMP Agent" };
			const other: MentionCandidate = { nodeId: "node_y", nodeName: "Yankee", agentId: "ag_y", agentName: "Bravo" };
			const group = [odd, other, { ...alpha, nodeName: "Alpha" }];
			expect(mentionTokens({ ...odd, agentName: "OMP Agent" }, group)).toEqual({ agent: "@OMP Agent@Bravo", machine: "@OMP Agent@Bravo" });
			expect(parseMentions("@OMP Agent@Bravo", group).agents).toEqual(targets(odd));
		});
	});
});

describe("resolveRecipients", () => {
	const base = { authorNodeId: "node_a", candidates: [A, B, C] };

	it("a human without a mention talks to the lead; mentions pick agents; @all everybody", () => {
		expect(resolveRecipients({ ...base, author: "human", text: "please add a test" })).toEqual({ mode: "lead", agents: [] });
		expect(resolveRecipients({ ...base, author: "human", text: "@node-b look" })).toEqual({ mode: "agents", agents: targets(B) });
		expect(resolveRecipients({ ...base, author: "human", text: "@all and @node-b" })).toEqual({ mode: "all", agents: [] });
	});

	it("an agent without a mention talks to nobody; it never mentions itself", () => {
		expect(resolveRecipients({ ...base, author: "agent", text: "done" })).toEqual({ mode: "agents", agents: [] });
		expect(resolveRecipients({ ...base, author: "agent", text: "@node-b your turn" })).toEqual({ mode: "agents", agents: targets(B) });
		expect(resolveRecipients({ ...base, author: "agent", text: "@node-a @node-b" })).toEqual({ mode: "agents", agents: targets(B) });
		expect(resolveRecipients({ ...base, author: "agent", text: "me, myself: @node-a" })).toEqual({ mode: "agents", agents: [] });
		expect(resolveRecipients({ ...base, author: "agent", text: "@all heads up" })).toEqual({ mode: "all", agents: [] });
	});

	it("an explicit `to` wins over the text", () => {
		const explicit: MessageTo = { mode: "agents", agents: targets(C) };
		expect(resolveRecipients({ ...base, author: "human", text: "@node-b", explicit })).toEqual(explicit);
		expect(resolveRecipients({ ...base, author: "human", text: "@node-b", explicit: { mode: "all", agents: targets(A) } })).toEqual({ mode: "all", agents: [] });
	});
});

describe("addressing and the wake budget", () => {
	it("isAddressed: all, the lead, named agents", () => {
		const me = { nodeId: "node_b", isLead: false };
		expect(isAddressed({ mode: "all", agents: [] }, me)).toBe(true);
		expect(isAddressed({ mode: "lead", agents: [] }, me)).toBe(false);
		expect(isAddressed({ mode: "lead", agents: [] }, { ...me, isLead: true })).toBe(true);
		expect(isAddressed({ mode: "agents", agents: targets(B) }, me)).toBe(true);
		expect(isAddressed({ mode: "agents", agents: targets(A) }, me)).toBe(false);
		expect(isAddressed({ mode: "agents", agents: [] }, me)).toBe(false);
	});

	it("only a message that can wake an agent counts, and a human message after it resets the count", () => {
		expect(wakesAgents({ mode: "all", agents: [] })).toBe(true);
		expect(wakesAgents({ mode: "agents", agents: targets(A) })).toBe(true);
		expect(wakesAgents({ mode: "agents", agents: [] })).toBe(false);
		expect(wakesAgents({ mode: "lead", agents: [] })).toBe(false);

		const wake: MessageTo = { mode: "agents", agents: targets(B) };
		const quiet: MessageTo = { mode: "agents", agents: [] };
		const m = (id: string, hlc: string, authorKind: "human" | "agent" | "system", authorNodeId: string, to: MessageTo) => ({ id, hlc, authorKind, authorNodeId, to });
		const log = [m("1", "001-0", "agent", "node_a", wake), m("2", "002-0", "agent", "node_a", quiet), m("3", "003-0", "agent", "node_b", wake), m("4", "004-0", "agent", "node_a", wake)];
		expect(wakeBudget(log, "node_a", 12)).toEqual({ limit: 12, used: 2, remaining: 10 });
		expect(wakeBudget(log, "node_b", 12)).toEqual({ limit: 12, used: 1, remaining: 11 });
		expect(wakeBudget([...log, m("5", "005-0", "human", "node_b", { mode: "lead", agents: [] })], "node_a", 12).used).toBe(0);
		// the human message counts by log order, not by arrival: one stamped before the wakes resets nothing after it
		expect(wakeBudget([...log, m("0", "000-0", "human", "node_b", { mode: "lead", agents: [] })], "node_a", 12).used).toBe(2);
		expect(wakeBudget(log, "node_a", 2).remaining).toBe(0);
		expect(wakeBudget(log, "node_a", 1).remaining).toBe(0);
	});
});

describe("buildSinceLastTurnBlock", () => {
	const human = (text: string) => ({ author: { kind: "human" as const, agentName: null, nodeName: "node-b" }, kind: "chat" as const, text });

	it("lists what the group said, oldest first, with the author and kind", () => {
		const block = buildSinceLastTurnBlock([human("first"), { author: { kind: "agent", agentName: "Bee", nodeName: "node-b" }, kind: "reply", text: "line one\nline two" }]);
		expect(block).toBe("Since your last turn in the group:\n- human@node-b (chat): first\n- Bee@node-b (reply): line one\n  line two");
		expect(buildSinceLastTurnBlock([])).toBeNull();
	});

	it("keeps the newest messages within the cap, trims the oldest and says how many were dropped", () => {
		const messages = Array.from({ length: 10 }, (_, i) => human(`m${i} ${"x".repeat(1000)}`));
		const block = buildSinceLastTurnBlock(messages, 3500) as string;
		expect(block.length).toBeLessThan(3800);
		expect(block).toContain("(7 earlier messages omitted)");
		expect(block).toContain("m9 ");
		expect(block).toContain("m7 ");
		expect(block).not.toContain("m6 ");
		// one giant message is clipped, not dropped
		const huge = buildSinceLastTurnBlock([human("y".repeat(50_000))]) as string;
		expect(huge.length).toBeLessThan(BUFFER_MAX_CHARS);
		expect(huge).toContain("…");
	});

	it("is the part of an injected group message that comes before the text, below the header the UI recognises", () => {
		const sinceLastTurn = buildSinceLastTurnBlock([human("earlier remark")]);
		const text = buildSharedMessageInjection({ sharedSessionId: "shs_1", title: "Notes", author: { kind: "human", agentName: null, nodeName: "node-b" }, kind: "chat", text: "now the real request", role: "participant", sinceLastTurn });
		const lines = text.split("\n");
		expect(lines[0]).toBe('[CL Agent Mesh] shared session shs_1 · "Notes" · from human@node-b · kind chat');
		expect(parseSharedInjectionHeader(text)).toEqual({ sharedSessionId: "shs_1", title: "Notes", from: "human@node-b", kind: "chat" });
		expect(text.indexOf("Since your last turn in the group:")).toBeLessThan(text.indexOf("earlier remark"));
		expect(text.indexOf("earlier remark")).toBeLessThan(text.indexOf("now the real request"));
		expect(text).toContain("Addressed to you now:");
		// without a buffer the message stays plain
		const plain = buildSharedMessageInjection({ sharedSessionId: "shs_1", title: "Notes", author: { kind: "human", agentName: null, nodeName: "node-b" }, kind: "chat", text: "alone", role: "driver" });
		expect(plain).not.toContain("Since your last turn");
		expect(plain).toContain("you are the lead");
	});
});

describe("pickFallbackAgent: where a human's unmentioned message goes while the lead cannot take it", () => {
	const everyone = [A, B, C, D];
	const reachable = (nodes: string[]) => (nodeId: string) => nodes.includes(nodeId);

	it("prefers the agent of the node the message was written on, never the lead's node and never an agentless node", () => {
		expect(pickFallbackAgent(everyone, { postedOnNodeId: "node_b", leadNodeId: "node_a", hasLocalAgent: true, isReachable: reachable([]) })).toEqual(B);
		// written on the lead's own node (its agent is gone): somebody else
		expect(pickFallbackAgent(everyone, { postedOnNodeId: "node_a", leadNodeId: "node_a", hasLocalAgent: false, isReachable: reachable(["node_b", "node_c"]) })).toEqual(B);
		// written on a node without an agent: the others, by node name
		expect(pickFallbackAgent(everyone, { postedOnNodeId: "node_d", leadNodeId: "node_a", hasLocalAgent: false, isReachable: reachable(["node_b", "node_c"]) })).toEqual(B);
		expect(pickFallbackAgent(everyone, { postedOnNodeId: "node_d", leadNodeId: "node_a", hasLocalAgent: false, isReachable: reachable(["node_c"]) })).toEqual(C);
	});

	it("falls back to a reachable member agent when the local node has no agent session, and to nobody when no agent can be woken", () => {
		expect(pickFallbackAgent([A, B], { postedOnNodeId: "node_b", leadNodeId: "node_a", hasLocalAgent: false, isReachable: reachable(["node_a"]) })).toBeNull();
		expect(pickFallbackAgent([A], { postedOnNodeId: "node_a", leadNodeId: "node_a", hasLocalAgent: true, isReachable: reachable(["node_a"]) })).toBeNull();
		expect(pickFallbackAgent([], { postedOnNodeId: "node_a", leadNodeId: "node_a", hasLocalAgent: true, isReachable: () => true })).toBeNull();
	});
});
