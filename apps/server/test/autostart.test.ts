import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NodeSettings, i18nMsg, plainMsg } from "@clam/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import workspaceRoutes from "../src/api/workspaces.ts";
import nodeRoutes from "../src/api/node.ts";
import {
	type AutostartManager,
	AutostartError,
	type CommandResult,
	type RunCommand,
	buildLoginPath,
	createAutostartManager,
	stableNodeExecutable,
} from "../src/services/autostart.ts";
import {
	type AutostartSpec,
	buildLaunchAgentPlist,
	buildSystemdUnit,
	buildWindowsTaskXml,
	buildWindowsWrapper,
	readPlistEntry,
	readPlistString,
	readUnitEntry,
	readUnitEnvironment,
} from "../src/services/autostart-templates.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "clam-autostart-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

const spec: AutostartSpec = {
	nodeExecutable: "/opt/node v22/bin/node",
	entry: "/srv/clam & co/apps/server/dist/main.js",
	dataDir: "/Users/me/.clam",
	logsDir: "/Users/me/.clam/logs",
	env: { CLAM_HOST: "127.0.0.1", CLAM_PORT: "4317", CLAM_DATA_DIR: "/Users/me/.clam", PATH: "/Users/me/.bun/bin:/usr/bin:/a<b>&c", CLAM_OMP_PROFILE: "dev" },
};

describe("stableNodeExecutable", () => {
	it("prefers a PATH entry that resolves to the running binary over its versioned install path", () => {
		const versioned = join(tmp, "Cellar", "node", "25.8.0", "bin");
		const stable = join(tmp, "bin");
		mkdirSync(versioned, { recursive: true });
		mkdirSync(stable, { recursive: true });
		writeFileSync(join(versioned, "node"), "#!/bin/sh\n", { mode: 0o755 });
		symlinkSync(join(versioned, "node"), join(stable, "node"));
		const other = join(tmp, "other");
		mkdirSync(other);
		writeFileSync(join(other, "node"), "#!/bin/sh\n# a different node\n", { mode: 0o755 });
		expect(stableNodeExecutable(join(versioned, "node"), `${other}:${stable}`, "linux")).toBe(join(stable, "node"));
		expect(stableNodeExecutable(join(versioned, "node"), other, "linux")).toBe(join(versioned, "node"));
		expect(stableNodeExecutable(join(tmp, "gone", "node"), stable, "linux")).toBe(join(tmp, "gone", "node"));
	});
});

describe("login entry templates", () => {
	it("generates a LaunchAgent that runs at load and restarts only after crashes", () => {
		const plist = buildLaunchAgentPlist(spec);
		expect(plist).toContain("<key>Label</key>\n\t<string>io.clam.agent-mesh</string>");
		expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
		expect(plist).toContain("<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>");
		expect(plist).toContain("<string>/opt/node v22/bin/node</string>\n\t\t<string>/srv/clam &amp; co/apps/server/dist/main.js</string>");
		expect(plist).toContain("<string>/Users/me/.bun/bin:/usr/bin:/a&lt;b&gt;&amp;c</string>");
		expect(plist).toContain("<key>StandardOutPath</key>\n\t<string>/Users/me/.clam/logs/server.out.log</string>");
		expect(plist).toContain("<key>StandardErrorPath</key>\n\t<string>/Users/me/.clam/logs/server.err.log</string>");
		for (const [key, value] of Object.entries(spec.env)) expect(readPlistString(plist, key)).toBe(value);
		expect(readPlistEntry(plist)).toBe(spec.entry);
	});

	it.runIf(process.platform === "darwin")("produces a plist that macOS plutil accepts, with hostile characters in paths", () => {
		const path = join(tmp, "login.plist");
		writeFileSync(path, buildLaunchAgentPlist({ ...spec, env: { ...spec.env, CLAM_X: "a'b&c<d>e" } }));
		expect(execFileSync("plutil", ["-lint", path], { encoding: "utf8" })).toContain("OK");
		const json = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" }));
		expect(json).toMatchObject({
			Label: "io.clam.agent-mesh",
			RunAtLoad: true,
			KeepAlive: { SuccessfulExit: false },
			ProgramArguments: [spec.nodeExecutable, spec.entry],
			EnvironmentVariables: { CLAM_PORT: "4317", CLAM_X: "a'b&c<d>e" },
		});
	});

	it("generates a systemd user unit that restarts on failure and escapes specifiers and variables", () => {
		const unit = buildSystemdUnit({ ...spec, entry: "/srv/50%/dist/$x/main.js", env: { ...spec.env, CLAM_X: "100%$HOME" } });
		expect(unit).toContain('ExecStart="/opt/node v22/bin/node" "/srv/50%%/dist/$$x/main.js"');
		expect(unit).toContain("Restart=on-failure");
		expect(unit).toContain("WantedBy=default.target");
		expect(unit).toContain('Environment="CLAM_PORT=4317"');
		expect(unit).toContain('Environment="CLAM_X=100%%$HOME"'); // `$` is not expanded in Environment=
		expect(unit).toContain("StandardOutput=append:/Users/me/.clam/logs/server.out.log");
		expect(readUnitEnvironment(unit, "CLAM_DATA_DIR")).toBe("/Users/me/.clam");
		expect(readUnitEnvironment(unit, "CLAM_X")).toBe("100%$HOME");
		expect(readUnitEntry(unit)).toBe("/srv/50%/dist/$x/main.js");
	});

	it("generates a Windows wrapper and task definition", () => {
		const wrapper = buildWindowsWrapper({ ...spec, nodeExecutable: "C:\\Program Files\\nodejs\\node.exe", entry: "C:\\clam\\dist\\main.js", dataDir: "C:\\Users\\me\\.clam", logsDir: "C:\\Users\\me\\.clam\\logs", env: { CLAM_PORT: "4317", PATH: "C:\\x;%USERPROFILE%\\bin" } });
		expect(wrapper).toContain("\r\nset \"CLAM_PORT=4317\"\r\n");
		expect(wrapper).toContain('set "PATH=C:\\x;%%USERPROFILE%%\\bin"');
		expect(wrapper).toContain('"C:\\Program Files\\nodejs\\node.exe" "C:\\clam\\dist\\main.js" >> "C:\\Users\\me\\.clam\\logs\\server.out.log" 2>> "C:\\Users\\me\\.clam\\logs\\server.err.log"');
		expect(wrapper.endsWith("exit /b %ERRORLEVEL%\r\n")).toBe(true);
		const xml = buildWindowsTaskXml("C:\\Users\\me & you\\.clam\\autostart\\start-server.cmd");
		expect(xml).toContain("<LogonTrigger>");
		expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
		expect(xml).toContain("<RestartOnFailure>");
		expect(xml).toContain("<Command>cmd.exe</Command>");
		expect(xml).toContain('<Arguments>/c ""C:\\Users\\me &amp; you\\.clam\\autostart\\start-server.cmd""</Arguments>');
	});

	it("refuses values it cannot quote safely in every format", () => {
		expect(() => buildLaunchAgentPlist({ ...spec, entry: '/x/"y"/main.js' })).toThrow(/quote or control/);
		expect(() => buildSystemdUnit({ ...spec, env: { ...spec.env, CLAM_X: "a\nExecStartPost=/bin/evil" } })).toThrow(/quote or control/);
		expect(() => buildWindowsWrapper({ ...spec, env: { "BAD NAME": "x" } })).toThrow(/Invalid environment variable name/);
	});

	it("builds a login PATH containing the omp and node directories without duplicates", () => {
		const path = buildLoginPath({ ompBinary: "/Users/me/.bun/bin/omp", nodeExecutable: "/opt/homebrew/bin/node", pathEnv: "/opt/homebrew/bin:/usr/bin:/Users/me/.bun/bin", platform: "darwin" });
		expect(path.split(":")).toEqual(["/Users/me/.bun/bin", "/opt/homebrew/bin", "/usr/bin", "/usr/local/bin", "/bin", "/usr/sbin", "/sbin"]);
		expect(buildLoginPath({ ompBinary: null, nodeExecutable: "C:\\node\\node.exe", pathEnv: "C:\\a;C:\\b", platform: "win32" })).toBe("C:\\node;C:\\a;C:\\b");
	});
});

/** Scripted command runner: records every call, answers from `answers` (first matching prefix) else success. */
function scriptedRun(answers: Record<string, Partial<CommandResult>> = {}) {
	const calls: string[] = [];
	const run: RunCommand = async (command, args) => {
		const line = [command, ...args].join(" ");
		calls.push(line);
		const key = Object.keys(answers).find((k) => line.startsWith(k));
		return { code: 0, stdout: "", stderr: "", ...(key ? answers[key] : {}) };
	};
	return { run, calls };
}

function manager(platform: NodeJS.Platform, run: RunCommand, overrides: { dataDir?: string; entry?: string } = {}) {
	const entry = overrides.entry ?? join(tmp, "server", "dist", "main.js");
	if (!overrides.entry) {
		mkdirSync(join(tmp, "server", "dist"), { recursive: true });
		writeFileSync(entry, "// built");
	}
	return createAutostartManager({
		config: { dataDir: overrides.dataDir ?? join(tmp, "data"), host: "127.0.0.1", port: 4317, ompBinary: null },
		entry,
		ompBinary: () => "/Users/me/.bun/bin/omp",
		extraEnv: { CLAM_OMP_PROFILE: "clam-dev" },
		platform,
		home: join(tmp, "home"),
		nodeExecutable: "/usr/local/bin/node",
		pathEnv: "/usr/bin",
		run,
	});
}

describe("macOS LaunchAgent", () => {
	const plistFile = () => join(tmp, "home", "Library", "LaunchAgents", "io.clam.agent-mesh.plist");

	it("writes the plist only (no launchctl), reports the truth, and removes it again", async () => {
		const { run, calls } = scriptedRun();
		const autostart = manager("darwin", run);
		expect(await autostart.status()).toEqual({ enabled: false, detail: "No LaunchAgent installed.", i18n: { key: "No LaunchAgent installed." } });

		const enabled = await autostart.enable();
		expect(enabled.enabled).toBe(true);
		expect(enabled.detail).toContain("next login");
		const plist = readFileSync(plistFile(), "utf8");
		expect(readPlistEntry(plist)).toBe(join(tmp, "server", "dist", "main.js"));
		expect(readPlistString(plist, "CLAM_DATA_DIR")).toBe(join(tmp, "data"));
		expect(readPlistString(plist, "CLAM_PORT")).toBe("4317");
		expect(readPlistString(plist, "CLAM_OMP_PROFILE")).toBe("clam-dev");
		expect(readPlistString(plist, "PATH")?.split(":").slice(0, 2)).toEqual(["/Users/me/.bun/bin", "/usr/local/bin"]);
		expect(existsSync(join(tmp, "data", "logs"))).toBe(true);
		expect(calls).toEqual([`plutil -lint ${plistFile()}`]); // validation only; launchctl is never invoked

		expect((await autostart.enable()).enabled).toBe(true); // refresh is idempotent
		expect((await autostart.disable()).enabled).toBe(false);
		expect(existsSync(plistFile())).toBe(false);
		expect((await autostart.disable()).enabled).toBe(false); // already gone
	});

	it("refuses with not_built when there is no built server, leaving nothing behind", async () => {
		const autostart = manager("darwin", scriptedRun().run, { entry: join(tmp, "nope", "main.js") });
		const error = await autostart.enable().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AutostartError);
		expect((error as AutostartError).code).toBe("not_built");
		expect((error as AutostartError).message).toContain("pnpm build");
		expect(existsSync(plistFile())).toBe(false);
	});

	it("removes a plist that plutil rejects and reports failure", async () => {
		const autostart = manager("darwin", scriptedRun({ plutil: { code: 1, stderr: "Encountered unexpected character" } }).run);
		await expect(autostart.enable()).rejects.toMatchObject({ code: "failed" });
		expect(existsSync(plistFile())).toBe(false);
	});

	it("does not claim, or delete, another node's entry", async () => {
		const other = manager("darwin", scriptedRun().run, { dataDir: join(tmp, "other-data") });
		await other.enable();
		const mine = manager("darwin", scriptedRun().run);
		const status = await mine.status();
		expect(status.enabled).toBe(false);
		expect(status.detail).toContain(join(tmp, "other-data"));
		await mine.disable();
		expect(existsSync(plistFile())).toBe(true); // untouched
		expect((await mine.enable()).enabled).toBe(true); // explicit enable takes the entry over
		expect((await other.status()).enabled).toBe(false);
	});

	it("warns when the build the entry points at has disappeared", async () => {
		const autostart = manager("darwin", scriptedRun().run);
		await autostart.enable();
		rmSync(join(tmp, "server"), { recursive: true });
		const status = await autostart.status();
		expect(status.enabled).toBe(true);
		expect(status.detail).toContain("no longer exists");
	});
});

describe("Linux systemd user unit", () => {
	const unitFile = () => join(tmp, "home", ".config", "systemd", "user", "cl-agent-mesh.service");

	it("writes the unit, runs daemon-reload and enable (never start), and reports enabled state from systemctl", async () => {
		const { run, calls } = scriptedRun({ "systemctl --user is-enabled": { stdout: "enabled\n" } });
		const autostart = manager("linux", run);
		const status = await autostart.enable();
		expect(status.enabled).toBe(true);
		expect(calls).toEqual([
			"systemctl --user --version",
			"systemctl --user daemon-reload",
			"systemctl --user enable cl-agent-mesh.service",
			"systemctl --user is-enabled cl-agent-mesh.service",
		]);
		expect(calls.some((c) => /\b(start|restart|--now)\b/.test(c))).toBe(false);
		const unit = readFileSync(unitFile(), "utf8");
		expect(unit).toContain("Restart=on-failure");
		expect(readUnitEnvironment(unit, "CLAM_DATA_DIR")).toBe(join(tmp, "data"));
		expect(readUnitEntry(unit)).toBe(join(tmp, "server", "dist", "main.js"));

		calls.length = 0;
		expect((await autostart.disable()).enabled).toBe(false);
		expect(calls).toEqual(["systemctl --user disable cl-agent-mesh.service", "systemctl --user daemon-reload"]);
		expect(existsSync(unitFile())).toBe(false);
	});

	it("reports an installed-but-disabled unit as not enabled", async () => {
		const autostart = manager("linux", scriptedRun({ "systemctl --user is-enabled": { code: 1, stdout: "disabled\n" } }).run);
		await autostart.enable().catch(() => {}); // enable succeeds (all other commands succeed); status then reads `disabled`
		const status = await autostart.status();
		expect(status.enabled).toBe(false);
		expect(status.detail).toContain("installed but not enabled");
	});

	it("is unsupported when systemd user services are unavailable and writes nothing", async () => {
		const autostart = manager("linux", scriptedRun({ "systemctl --user --version": { code: 127, stderr: "spawn systemctl ENOENT" } }).run);
		await expect(autostart.enable()).rejects.toMatchObject({ code: "unsupported" });
		expect(existsSync(unitFile())).toBe(false);
	});

	it("rolls the unit back when systemctl enable fails", async () => {
		const { run, calls } = scriptedRun({ "systemctl --user enable": { code: 1, stderr: "Failed to connect to bus" } });
		const autostart = manager("linux", run);
		await expect(autostart.enable()).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("Failed to connect to bus") });
		expect(existsSync(unitFile())).toBe(false);
		expect(calls.at(-1)).toBe("systemctl --user daemon-reload");
	});

	it("fails disable only if the unit stays enabled", async () => {
		const stuck = manager("linux", scriptedRun({ "systemctl --user disable": { code: 1, stderr: "denied" }, "systemctl --user is-enabled": { stdout: "enabled\n" } }).run);
		await stuck.enable();
		await expect(stuck.disable()).rejects.toMatchObject({ code: "failed" });
		expect(existsSync(unitFile())).toBe(true);
		const benign = manager("linux", scriptedRun({ "systemctl --user disable": { code: 1, stderr: "Unit file cl-agent-mesh.service does not exist" }, "systemctl --user is-enabled": { code: 1, stdout: "disabled\n" } }).run);
		await benign.disable();
		expect(existsSync(unitFile())).toBe(false);
	});
});

describe("Windows scheduled task", () => {
	it("writes the wrapper and a UTF-16 task definition, creates the task from it, and deletes it on disable", async () => {
		const state = { installed: false };
		const calls: string[] = [];
		const wrapper = join(tmp, "data", "autostart", "start-server.cmd");
		const run: RunCommand = async (command, args) => {
			calls.push([command, ...args].join(" "));
			if (args[0] === "/Create") state.installed = true;
			if (args[0] === "/Delete") state.installed = false;
			if (args[0] === "/Query") return state.installed ? { code: 0, stdout: `<Arguments>/c ""${wrapper}""</Arguments>`, stderr: "" } : { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
			return { code: 0, stdout: "", stderr: "" };
		};
		const autostart = manager("win32", run);
		expect((await autostart.status()).enabled).toBe(false);
		expect((await autostart.enable()).enabled).toBe(true);
		const create = calls.find((c) => c.startsWith("schtasks /Create"));
		expect(create).toBe(`schtasks /Create /TN CL Agent Mesh /XML ${join(tmp, "data", "autostart", "task.xml")} /F`);
		const xml = readFileSync(join(tmp, "data", "autostart", "task.xml"));
		expect([...xml.subarray(0, 2)]).toEqual([0xff, 0xfe]);
		expect(xml.subarray(2).toString("utf16le")).toContain("<LogonTrigger>");
		const script = readFileSync(wrapper, "utf8");
		expect(script).toContain("set \"CLAM_PORT=4317\"");
		expect(script).toContain(`"/usr/local/bin/node" "${join(tmp, "server", "dist", "main.js")}"`);

		expect((await autostart.disable()).enabled).toBe(false);
		expect(calls.some((c) => c.startsWith("schtasks /Delete /TN CL Agent Mesh /F"))).toBe(true);
		expect(existsSync(wrapper)).toBe(false);
	});

	it("reports another node's task as not enabled and does not delete it", async () => {
		const calls: string[] = [];
		const run: RunCommand = async (command, args) => {
			calls.push([command, ...args].join(" "));
			return args[0] === "/Query" ? { code: 0, stdout: '<Arguments>/c ""C:\\elsewhere\\start-server.cmd""</Arguments>', stderr: "" } : { code: 0, stdout: "", stderr: "" };
		};
		const autostart = manager("win32", run);
		expect((await autostart.status()).enabled).toBe(false);
		await autostart.disable();
		expect(calls.some((c) => c.startsWith("schtasks /Delete"))).toBe(false);
	});

	it("surfaces schtasks failures", async () => {
		const autostart = manager("win32", scriptedRun({ "schtasks /Create": { code: 1, stderr: "ERROR: Access is denied." } }).run);
		await expect(autostart.enable()).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("Access is denied") });
	});
});

describe("unsupported platforms", () => {
	it("reports off and refuses to enable", async () => {
		const autostart = manager("freebsd", scriptedRun().run);
		expect(await autostart.status()).toEqual({ enabled: false, detail: "Autostart is not supported on freebsd.", i18n: { key: "Autostart is not supported on {platform}.", params: { platform: "freebsd" } } });
		await expect(autostart.enable()).rejects.toMatchObject({ code: "unsupported" });
		expect((await autostart.disable()).enabled).toBe(false);
	});
});

describe("PATCH/GET /settings autostart", () => {
	let harness: TestHarness | undefined;
	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
	});

	function fake(initial = false) {
		const state = { enabled: initial, error: null as AutostartError | null };
		const autostart: AutostartManager = {
			status: async () => ({ enabled: state.enabled, detail: state.enabled ? "installed (fake)" : "not installed (fake)" }),
			enable: async () => {
				if (state.error) throw state.error;
				state.enabled = true;
				return autostart.status();
			},
			disable: async () => {
				state.enabled = false;
				return autostart.status();
			},
		};
		return { state, autostart };
	}

	async function settings(h: TestHarness, method: "GET" | "PATCH", payload?: Record<string, unknown>) {
		const res = await h.app.inject({ method, url: "/api/local/settings", headers: { host: "localhost" }, ...(payload === undefined ? {} : { payload }) });
		return { status: res.statusCode, body: res.json() as NodeSettings & { error?: { code: string; message: string } } };
	}

	it("toggles the OS entry and reports the effective state with its detail", async () => {
		const { autostart, state } = fake();
		harness = await createTestHarness({ plugins: [nodeRoutes], ctx: { autostart } });
		expect((await settings(harness, "GET")).body).toMatchObject({ autoStart: false, autoStartDetail: "not installed (fake)" });
		const on = await settings(harness, "PATCH", { autoStart: true });
		expect(on.body).toMatchObject({ autoStart: true, autoStartDetail: "installed (fake)" });
		expect(state.enabled).toBe(true);
		const off = await settings(harness, "PATCH", { autoStart: false });
		expect(off.body).toMatchObject({ autoStart: false });
		expect(state.enabled).toBe(false);
	});

	it("carries the localisation twin of the autostart detail", async () => {
		const autostart: AutostartManager = {
			status: async () => ({ enabled: false, detail: "No LaunchAgent installed.", i18n: { key: "No LaunchAgent installed." } }),
			enable: async () => autostart.status(),
			disable: async () => autostart.status(),
		};
		harness = await createTestHarness({ plugins: [nodeRoutes], ctx: { autostart } });
		expect((await settings(harness, "GET")).body).toMatchObject({ autoStartDetail: "No LaunchAgent installed.", autoStartI18n: { key: "No LaunchAgent installed." } });
	});

	it("GET reflects the OS, not the stored value (entry removed outside the app)", async () => {
		const { autostart, state } = fake();
		harness = await createTestHarness({ plugins: [nodeRoutes], ctx: { autostart } });
		await settings(harness, "PATCH", { autoStart: true });
		state.enabled = false; // user deleted the LaunchAgent by hand
		expect((await settings(harness, "GET")).body.autoStart).toBe(false);
		state.enabled = true; // ...or created it by hand
		expect((await settings(harness, "GET")).body.autoStart).toBe(true);
	});

	it("answers 409 not_built (and applies nothing else) when the server is not built", async () => {
		const { autostart, state } = fake();
		state.error = new AutostartError("not_built", i18nMsg("The built server was not found at {entry}. Build the server first: pnpm build", { entry: "/x/dist/main.js" }));
		harness = await createTestHarness({ plugins: [nodeRoutes], ctx: { autostart } });
		const res = await settings(harness, "PATCH", { autoStart: true, nodeName: "Renamed", maxConcurrentRuntimes: 2 });
		expect(res.status).toBe(409);
		expect(res.body.error).toMatchObject({ code: "autostart_not_built", message: expect.stringContaining("pnpm build"), i18n: { key: "The built server was not found at {entry}. Build the server first: pnpm build", params: { entry: "/x/dist/main.js" } } });
		const after = (await settings(harness, "GET")).body;
		expect(after).toMatchObject({ autoStart: false, maxConcurrentRuntimes: 4 });
		expect(after.nodeName).not.toBe("Renamed");
	});

	it("maps unsupported and failed to typed errors; does not touch the OS when autoStart is not in the patch", async () => {
		const { autostart, state } = fake();
		harness = await createTestHarness({ plugins: [nodeRoutes], ctx: { autostart } });
		state.error = new AutostartError("unsupported", plainMsg("no systemd"));
		expect((await settings(harness, "PATCH", { autoStart: true })).status).toBe(409);
		state.error = new AutostartError("failed", plainMsg("access denied"));
		const failed = await settings(harness, "PATCH", { autoStart: true });
		expect(failed.status).toBe(502);
		expect(failed.body.error?.code).toBe("autostart_failed");
		state.error = new AutostartError("failed", plainMsg("must not be reached"));
		const other = await settings(harness, "PATCH", { nodeName: "Studio" });
		expect(other.status).toBe(200);
		expect(other.body.nodeName).toBe("Studio");
	});

	it("with the real manager in a dev checkout (no dist) PATCH autoStart is a 409 telling to build first", async () => {
		harness = await createTestHarness({ plugins: [nodeRoutes, workspaceRoutes] });
		const res = await settings(harness, "PATCH", { autoStart: true });
		expect(res.status).toBe(409);
		expect(res.body.error?.message).toContain("pnpm build");
	});
});
