import { MESH_HOST_TOOLS } from "@clam/contracts";
import { describe, expect, it } from "vitest";
import { HOST_TOOL_DEFINITIONS, parseHostToolCall } from "../src/index.ts";

const REQUIRED: Record<string, string[]> = {
	mesh_agents: [],
	mesh_delegate: ["node", "title", "instructions"],
	mesh_message: ["taskId", "text"],
	mesh_task: ["taskId"],
	mesh_complete: ["outcome", "summary"],
};

describe("definitions", () => {
	it("names match contracts exactly", () => {
		expect(HOST_TOOL_DEFINITIONS.map((t) => t.name)).toEqual([...MESH_HOST_TOOLS]);
	});
	it("schemas are valid object schemas", () => {
		for (const t of HOST_TOOL_DEFINITIONS) {
			const p = t.parameters as { type: string; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
			expect(p.type).toBe("object");
			expect(p.additionalProperties).toBe(false);
			expect(p.required).toEqual(REQUIRED[t.name]);
			for (const r of p.required) expect(p.properties[r]).toBeDefined();
			expect(t.loadMode).toBe("essential");
			expect(t.description.length).toBeGreaterThan(40);
			expect(t.label.length).toBeGreaterThan(0);
		}
	});
	it("descriptions carry guidance", () => {
		const d = (n: string) => HOST_TOOL_DEFINITIONS.find((t) => t.name === n)!.description;
		expect(d("mesh_message")).toMatch(/END YOUR TURN/);
		expect(d("mesh_message")).toMatch(/12/);
		expect(d("mesh_complete")).toMatch(/delegated task/);
	});
});

describe("parseHostToolCall", () => {
	it("happy paths with defaults", () => {
		expect(parseHostToolCall("mesh_agents", {})).toEqual({ ok: true, call: { name: "mesh_agents", args: {} } });
		expect(parseHostToolCall("mesh_agents", undefined).ok).toBe(true);
		expect(parseHostToolCall("mesh_delegate", { node: " n ", title: " T ", instructions: " do it " })).toEqual({
			ok: true,
			call: { name: "mesh_delegate", args: { node: "n", title: "T", instructions: "do it", deliverAs: "branch" } },
		});
		expect(parseHostToolCall("mesh_delegate", { node: "n", agent: "a", title: "T", instructions: "i", deliverAs: "summary", baseBranch: "dev", maxCostUsd: 3 })).toEqual({
			ok: true,
			call: { name: "mesh_delegate", args: { node: "n", agent: "a", title: "T", instructions: "i", deliverAs: "summary", baseBranch: "dev", maxCostUsd: 3 } },
		});
		expect(parseHostToolCall("mesh_message", { taskId: "t", text: " hi " })).toEqual({
			ok: true,
			call: { name: "mesh_message", args: { taskId: "t", text: "hi", kind: "note" } },
		});
		expect(parseHostToolCall("mesh_message", { taskId: "t", text: "q", kind: "question" }).ok).toBe(true);
		expect(parseHostToolCall("mesh_task", { taskId: "t" })).toEqual({ ok: true, call: { name: "mesh_task", args: { taskId: "t" } } });
		expect(parseHostToolCall("mesh_complete", { outcome: "blocked", summary: "s" })).toEqual({
			ok: true,
			call: { name: "mesh_complete", args: { outcome: "blocked", summary: "s" } },
		});
		expect(parseHostToolCall("mesh_complete", { taskId: "t", outcome: "succeeded", summary: "s" }).ok).toBe(true);
	});
	const fail = (name: string, raw: unknown, re: RegExp) => {
		const r = parseHostToolCall(name, raw);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(re);
	};
	it("failures", () => {
		fail("mesh_message", { taskId: "t", text: "   " }, /mesh_message: text must not be empty/);
		fail("mesh_message", { taskId: "t" }, /mesh_message: .*text/);
		fail("mesh_message", { taskId: "t", text: "x", kind: "shout" }, /kind/);
		fail("mesh_message", { taskId: "t", text: "x".repeat(20001) }, /at most 20000/);
		fail("mesh_message", { taskId: "t", text: "x", extra: 1 }, /unknown argument.*extra/);
		fail("mesh_delegate", { node: "n", title: "", instructions: "i" }, /title must not be empty/);
		fail("mesh_delegate", { node: "n", title: "t", instructions: " " }, /instructions must not be empty/);
		fail("mesh_delegate", { node: "n", title: "t".repeat(201), instructions: "i" }, /title.*200/);
		fail("mesh_delegate", { node: "n", title: "t", instructions: "x".repeat(50001) }, /50000/);
		fail("mesh_delegate", { node: "n", title: "t", instructions: "i", deliverAs: "zip" }, /deliverAs/);
		fail("mesh_delegate", { node: "n", title: "t", instructions: "i", maxCostUsd: -1 }, /maxCostUsd/);
		fail("mesh_complete", { outcome: "ok", summary: "s" }, /outcome/);
		fail("mesh_complete", { outcome: "failed", summary: "" }, /summary must not be empty/);
		fail("mesh_task", {}, /taskId/);
		fail("mesh_agents", { x: 1 }, /unknown argument/);
		fail("mesh_nope", {}, /unknown tool 'mesh_nope'/);
		fail("toString", {}, /unknown tool/);
		fail("mesh_task", "str", /mesh_task/);
	});
});
