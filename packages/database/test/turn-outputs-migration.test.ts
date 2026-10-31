import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/index.ts";

describe("0010_turn_outputs", () => {
	it("creates turn_outputs with its session index, and its rows go with the session", () => {
		const db = openDatabase({ file: ":memory:" });
		const columns = (db.$client.pragma("table_info(turn_outputs)") as Array<{ name: string }>).map((c) => c.name);
		expect(columns).toEqual(["id", "session_id", "project_id", "anchor_message_id", "anchor_timestamp", "started_at", "ended_at", "files", "truncated", "created_at"]);
		expect((db.$client.pragma("index_list(turn_outputs)") as Array<{ name: string }>).map((i) => i.name)).toContain("turn_outputs_session_idx");

		db.$client.prepare("insert into node(id,name,public_key,fingerprint) values('n','n','k','f')").run();
		db.$client.prepare("insert into workspaces(id,name,owner_id) values('w','w','n')").run();
		db.$client.prepare("insert into projects(id,workspace_id,name,path,managed) values('p','w','p','/tmp/p',1)").run();
		db.$client.prepare("insert into agents(id,node_id,name,runtime) values('a','n','a','omp')").run();
		db.$client.prepare("insert into agent_sessions(id,agent_id,project_id,title,session_dir) values('s','a','p','t','/tmp/s')").run();
		db.$client.prepare("insert into turn_outputs(id,session_id,project_id,started_at,ended_at,files) values('t','s','p',1,2,'[]')").run();
		expect(db.$client.prepare("select truncated, anchor_message_id from turn_outputs").all()).toEqual([{ truncated: 0, anchor_message_id: null }]);
		expect(() => db.$client.prepare("insert into turn_outputs(id,session_id,project_id,started_at,ended_at,files) values('x','missing','p',1,2,'[]')").run()).toThrow(/FOREIGN KEY/);
		db.$client.prepare("delete from agent_sessions where id = 's'").run();
		expect(db.$client.prepare("select id from turn_outputs").all()).toEqual([]);
		db.$client.close();
	});
});
