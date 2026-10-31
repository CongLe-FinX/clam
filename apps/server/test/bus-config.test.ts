import { describe, expect, it } from "vitest";
import { createEventBus, isRetainedTopic } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";

describe("event bus", () => {
	it("stamps per-topic sequence numbers and isolates topics", () => {
		const bus = createEventBus();
		const seen: Array<[string, number]> = [];
		bus.subscribe("a", (_e, seq) => seen.push(["a", seq]));
		bus.subscribe("b", (_e, seq) => seen.push(["b", seq]));
		bus.publish("a", 1);
		bus.publish("b", 1);
		bus.publish("a", 2);
		expect(seen).toEqual([["a", 1], ["b", 1], ["a", 2]]);
	});

	it("survives a throwing subscriber and supports unsubscribe", () => {
		const bus = createEventBus();
		const got: unknown[] = [];
		bus.subscribe("t", () => {
			throw new Error("boom");
		});
		const off = bus.subscribe("t", (e) => got.push(e));
		bus.publish("t", "x");
		off();
		bus.publish("t", "y");
		expect(got).toEqual(["x"]);
	});

	it("retains only the latest event of state-like topics and bounds the cache", () => {
		const bus = createEventBus();
		bus.publish("session:1", "s");
		bus.publish("node", "n1");
		bus.publish("node", "n2");
		expect(bus.latest("session:1")).toBeUndefined();
		expect(bus.latest("node")).toEqual({ event: "n2", seq: 2 });
		expect(isRetainedTopic("login:abc")).toBe(true);
		expect(isRetainedTopic("github-device:abc")).toBe(true);
		expect(isRetainedTopic("sessions")).toBe(false);
		for (let i = 0; i < 300; i++) bus.publish(`login:${i}`, i);
		expect(bus.latest("login:0")).toBeUndefined();
		expect(bus.latest("login:299")).toEqual({ event: 299, seq: 1 });
	});
});

describe("loadConfig", () => {
	it("defaults to loopback:4317 and refuses non-loopback hosts", () => {
		const config = loadConfig({ CLAM_DATA_DIR: "/tmp/clam-config-test" });
		expect(config).toMatchObject({ host: "127.0.0.1", port: 4317, dataDir: "/tmp/clam-config-test", ompBinary: null, ompProfile: null });
		expect(loadConfig({ CLAM_HOST: "[::1]", CLAM_DATA_DIR: "/tmp/x" }).host).toBe("::1");
		expect(() => loadConfig({ CLAM_HOST: "0.0.0.0" })).toThrow(/loopback/);
		expect(() => loadConfig({ CLAM_HOST: "192.168.1.2" })).toThrow(/loopback/);
	});

	it("validates the port and reads overrides", () => {
		expect(loadConfig({ CLAM_PORT: "4337", CLAM_OMP_BIN: " /bin/omp ", CLAM_OMP_PROFILE: "clam-dev", CLAM_DATA_DIR: "/tmp/x" })).toMatchObject({
			port: 4337,
			ompBinary: "/bin/omp",
			ompProfile: "clam-dev",
		});
		expect(() => loadConfig({ CLAM_PORT: "70000" })).toThrow(/CLAM_PORT/);
		expect(() => loadConfig({ CLAM_PORT: "abc" })).toThrow(/CLAM_PORT/);
		expect(() => loadConfig({ CLAM_WEB_DIST: "/definitely/not/here" })).toThrow(/index\.html/);
	});

	it("uses <repo>/.data/core under `pnpm dev` and ~/.clam otherwise", () => {
		expect(loadConfig({ npm_lifecycle_event: "dev" }).dataDir).toMatch(/\.data\/core$/);
		expect(loadConfig({}).dataDir).toMatch(/\.clam$/);
	});
});
