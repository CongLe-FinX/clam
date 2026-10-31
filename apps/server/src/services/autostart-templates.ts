/**
 * Pure generators for the OS login entries that start CL Agent Mesh at login (FR-01). No I/O here so every
 * format is unit-testable on any platform; `autostart.ts` writes and removes the files.
 */

export const MAC_LABEL = "io.clam.agent-mesh";
export const SYSTEMD_UNIT = "cl-agent-mesh.service";
export const WINDOWS_TASK_NAME = "CL Agent Mesh";

export interface AutostartSpec {
	/** Absolute path of the node executable that runs the server. */
	nodeExecutable: string;
	/** Absolute path of the built server entry (`apps/server/dist/main.js`). */
	entry: string;
	dataDir: string;
	logsDir: string;
	/** Environment of the autostarted server: CLAM_HOST/PORT/DATA_DIR, PATH, optional overrides. */
	env: Record<string, string>;
}

/** Env names/values land in XML, systemd and cmd syntax: refuse anything that cannot be quoted safely in all three. */
export function assertSafeSpec(spec: AutostartSpec): void {
	const values = [spec.nodeExecutable, spec.entry, spec.dataDir, spec.logsDir, ...Object.keys(spec.env), ...Object.values(spec.env)];
	for (const value of values) {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
		if (/[\u0000-\u001f"]/.test(value)) throw new Error(`Cannot create a login entry: value contains a quote or control character: ${JSON.stringify(value).slice(0, 120)}`);
	}
	for (const name of Object.keys(spec.env)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid environment variable name: ${name}`);
	}
}

export function xmlEscape(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function xmlUnescape(value: string): string {
	return value.replaceAll("&apos;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

const sortedEnv = (env: Record<string, string>): Array<[string, string]> => Object.entries(env).sort(([a], [b]) => a.localeCompare(b));

// ---------------------------------------------------------------- macOS

/**
 * LaunchAgent: loaded by launchd at the next login (`RunAtLoad`), restarted after a crash but not after a clean exit
 * (`KeepAlive.SuccessfulExit = false`), throttled so a crash loop cannot spin.
 */
export function buildLaunchAgentPlist(spec: AutostartSpec): string {
	assertSafeSpec(spec);
	const env = sortedEnv(spec.env)
		.map(([key, value]) => `\t\t<key>${xmlEscape(key)}</key>\n\t\t<string>${xmlEscape(value)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${MAC_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xmlEscape(spec.nodeExecutable)}</string>
		<string>${xmlEscape(spec.entry)}</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${env}
	</dict>
	<key>WorkingDirectory</key>
	<string>${xmlEscape(spec.dataDir)}</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>15</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${xmlEscape(`${spec.logsDir}/server.out.log`)}</string>
	<key>StandardErrorPath</key>
	<string>${xmlEscape(`${spec.logsDir}/server.err.log`)}</string>
</dict>
</plist>
`;
}

/** Value of `<key>name</key><string>…</string>` in a plist we generated; null when absent. */
export function readPlistString(plist: string, name: string): string | null {
	const match = new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`).exec(plist);
	return match ? xmlUnescape(match[1] ?? "") : null;
}

/** The second ProgramArguments string (the server entry) of a plist we generated. */
export function readPlistEntry(plist: string): string | null {
	const match = /<key>ProgramArguments<\/key>\s*<array>\s*<string>[^<]*<\/string>\s*<string>([^<]*)<\/string>/.exec(plist);
	return match ? xmlUnescape(match[1] ?? "") : null;
}

// ---------------------------------------------------------------- Linux (systemd user unit)

/**
 * systemd value quoting: backslash, double quote and `%` (specifiers) are special everywhere; `$` additionally
 * triggers variable expansion in `ExecStart=` but not in `Environment=`.
 */
function systemdQuote(value: string, expandsVariables: boolean): string {
	let escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
	if (expandsVariables) escaped = escaped.replaceAll("$", () => "$$");
	return `"${escaped}"`;
}

/** User service started by `default.target` at login, restarted on failure. Enabled (not started) by `systemctl --user enable`. */
export function buildSystemdUnit(spec: AutostartSpec): string {
	assertSafeSpec(spec);
	const env = sortedEnv(spec.env)
		.map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`, false)}`)
		.join("\n");
	return `[Unit]
Description=CL Agent Mesh node
After=network.target

[Service]
Type=simple
ExecStart=${systemdQuote(spec.nodeExecutable, true)} ${systemdQuote(spec.entry, true)}
WorkingDirectory=${systemdQuote(spec.dataDir, false)}
${env}
Restart=on-failure
RestartSec=5
StandardOutput=append:${spec.logsDir}/server.out.log
StandardError=append:${spec.logsDir}/server.err.log

[Install]
WantedBy=default.target
`;
}

export function readUnitEnvironment(unit: string, name: string): string | null {
	const match = new RegExp(`^Environment="${name}=(.*)"$`, "m").exec(unit);
	return match ? (match[1] ?? "").replaceAll("%%", "%").replaceAll('\\"', '"').replaceAll("\\\\", "\\") : null;
}

export function readUnitEntry(unit: string): string | null {
	const match = /^ExecStart="(?:[^"\\]|\\.)*" "((?:[^"\\]|\\.)*)"$/m.exec(unit);
	return match ? (match[1] ?? "").replaceAll("%%", "%").replaceAll("$$", "$").replaceAll('\\"', '"').replaceAll("\\\\", "\\") : null;
}

// ---------------------------------------------------------------- Windows (Task Scheduler)

/** `cmd` batch wrapper: sets the environment (a scheduled task cannot), runs the server, propagates its exit code. */
export function buildWindowsWrapper(spec: AutostartSpec): string {
	assertSafeSpec(spec);
	const percent = (value: string) => value.replaceAll("%", "%%");
	const sets = sortedEnv(spec.env)
		.map(([key, value]) => `set "${key}=${percent(value)}"`)
		.join("\r\n");
	const log = (name: string) => percent(`${spec.logsDir}\\${name}`.replaceAll("/", "\\"));
	return [
		"@echo off",
		sets,
		`cd /d "${percent(spec.dataDir)}"`,
		`"${percent(spec.nodeExecutable)}" "${percent(spec.entry)}" >> "${log("server.out.log")}" 2>> "${log("server.err.log")}"`,
		"exit /b %ERRORLEVEL%",
		"",
	].join("\r\n");
}

/**
 * Task definition for `schtasks /Create /XML`: runs the wrapper at logon of the current user with the user's own
 * privileges, hidden from the task list, and lets Task Scheduler restart it after a failure (up to 999 times, 1 minute apart).
 */
export function buildWindowsTaskXml(wrapperPath: string): string {
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts the CL Agent Mesh node at logon.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/c ""${xmlEscape(wrapperPath)}""</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}
