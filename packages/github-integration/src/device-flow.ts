import type { DeviceFlowStart, DeviceFlowStatus, GithubAccount } from "@clam/contracts";
import { describeNetworkError, type FetchFn } from "./api-client.ts";
import { GithubError } from "./errors.ts";

export const DEVICE_SCOPES = ["repo", "read:user", "user:email"] as const;
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** GitHub: on `slow_down` the polling interval grows by 5 seconds. */
const SLOW_DOWN_STEP_SEC = 5;
const MAX_CONSECUTIVE_NETWORK_FAILURES = 4;
const FINISHED_FLOW_RETENTION_MS = 10 * 60_000;

interface Flow {
	id: string;
	clientId: string;
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	expiresAtMs: number;
	intervalSec: number;
	status: DeviceFlowStatus;
	timer: ReturnType<typeof setTimeout> | null;
	networkFailures: number;
	cleanup: ReturnType<typeof setTimeout> | null;
}

export interface DeviceFlowDeps {
	fetch: FetchFn;
	/** Turns an access token into a stored account (fetch profile, save secret, upsert row). */
	completeLogin: (token: string, scopes: string[]) => Promise<GithubAccount>;
	publish: (topic: string, event: unknown) => void;
	newId: () => string;
	now: () => number;
}

/**
 * OAuth device flow. Public-client flow: only `client_id` is sent, there is no client secret.
 * Flows live in memory; each polls GitHub on its own timer honoring `interval` / `slow_down` and
 * ends in exactly one terminal state (success | expired | denied | error).
 */
export class DeviceFlowManager {
	private readonly flows = new Map<string, Flow>();
	constructor(private readonly deps: DeviceFlowDeps) {}

	async start(clientId: string): Promise<DeviceFlowStart> {
		const body = await this.post(DEVICE_CODE_URL, { client_id: clientId, scope: DEVICE_SCOPES.join(" ") });
		if (typeof body.error === "string") throw deviceStartError(body);
		const deviceCode = str(body.device_code);
		const userCode = str(body.user_code);
		const verificationUri = str(body.verification_uri);
		if (!deviceCode || !userCode || !verificationUri) {
			throw new GithubError(502, "upstream", "GitHub returned an unexpected device-code response.");
		}
		const intervalSec = Math.max(1, Number(body.interval) || 5);
		const expiresIn = Math.max(1, Number(body.expires_in) || 900);
		const id = this.deps.newId();
		const flow: Flow = {
			id,
			clientId,
			deviceCode,
			userCode,
			verificationUri,
			expiresAtMs: this.deps.now() + expiresIn * 1000,
			intervalSec,
			status: { flowId: id, state: "pending" },
			timer: null,
			networkFailures: 0,
			cleanup: null,
		};
		this.flows.set(id, flow);
		this.schedule(flow);
		return { flowId: id, userCode, verificationUri, expiresAt: new Date(flow.expiresAtMs).toISOString(), intervalSec };
	}

	status(flowId: string): DeviceFlowStatus | null {
		const flow = this.flows.get(flowId);
		if (!flow) return null;
		// A pending flow past its deadline is reported expired even if the timer has not fired yet.
		if (flow.status.state === "pending" && this.deps.now() >= flow.expiresAtMs) this.finish(flow, { state: "expired" });
		return flow.status;
	}

	/** Stops every timer (server shutdown). */
	dispose(): void {
		for (const flow of this.flows.values()) {
			if (flow.timer) clearTimeout(flow.timer);
			if (flow.cleanup) clearTimeout(flow.cleanup);
		}
		this.flows.clear();
	}

	private schedule(flow: Flow): void {
		flow.timer = setTimeout(() => void this.poll(flow), flow.intervalSec * 1000);
		flow.timer.unref?.();
	}

	private async poll(flow: Flow): Promise<void> {
		flow.timer = null;
		if (flow.status.state !== "pending") return;
		if (this.deps.now() >= flow.expiresAtMs) return this.finish(flow, { state: "expired" });

		let body: Record<string, unknown>;
		try {
			body = await this.post(ACCESS_TOKEN_URL, { client_id: flow.clientId, device_code: flow.deviceCode, grant_type: GRANT_TYPE });
		} catch (err) {
			// Transient network trouble must not kill a flow the user is still completing in the browser.
			if (++flow.networkFailures >= MAX_CONSECUTIVE_NETWORK_FAILURES) {
				return this.finish(flow, { state: "error", error: err instanceof Error ? err.message : String(err) });
			}
			return this.schedule(flow);
		}
		flow.networkFailures = 0;

		const token = str(body.access_token);
		if (token) {
			const scopes = (str(body.scope) ?? "").split(/[\s,]+/).filter(Boolean);
			try {
				const account = await this.deps.completeLogin(token, scopes);
				return this.finish(flow, { state: "success", account });
			} catch (err) {
				return this.finish(flow, { state: "error", error: err instanceof Error ? err.message : String(err) });
			}
		}

		switch (str(body.error)) {
			case "authorization_pending":
				return this.schedule(flow);
			case "slow_down": {
				const given = Number(body.interval);
				flow.intervalSec = Number.isFinite(given) && given > flow.intervalSec ? given : flow.intervalSec + SLOW_DOWN_STEP_SEC;
				return this.schedule(flow);
			}
			case "expired_token":
				return this.finish(flow, { state: "expired" });
			case "access_denied":
				return this.finish(flow, { state: "denied" });
			default:
				return this.finish(flow, { state: "error", error: str(body.error_description) ?? str(body.error) ?? "Unexpected response from GitHub." });
		}
	}

	private finish(flow: Flow, patch: Omit<DeviceFlowStatus, "flowId">): void {
		if (flow.status.state !== "pending") return;
		if (flow.timer) clearTimeout(flow.timer);
		flow.timer = null;
		flow.status = { flowId: flow.id, ...patch };
		this.deps.publish(`github-device:${flow.id}`, { type: "flow", status: flow.status });
		flow.cleanup = setTimeout(() => this.flows.delete(flow.id), FINISHED_FLOW_RETENTION_MS);
		flow.cleanup.unref?.();
	}

	private async post(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
		let res: Response;
		try {
			res = await this.deps.fetch(url, {
				method: "POST",
				headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "CL-Agent-Mesh" },
				body: new URLSearchParams(form).toString(),
				signal: AbortSignal.timeout(15_000),
			});
		} catch (err) {
			throw new GithubError(502, "network", `Could not reach GitHub: ${describeNetworkError(err)}`);
		}
		const text = await res.text().catch(() => "");
		try {
			const parsed = JSON.parse(text) as unknown;
			if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
		} catch {
			// fall through
		}
		throw new GithubError(502, "upstream", `GitHub answered ${res.status} with a non-JSON body.`);
	}
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function deviceStartError(body: Record<string, unknown>): GithubError {
	const code = str(body.error);
	if (code === "device_flow_disabled") {
		return new GithubError(409, "not_configured", "Device Flow is not enabled for this OAuth App. Enable it in the app's GitHub settings (\"Enable Device Flow\").");
	}
	if (code === "incorrect_client_credentials" || code === "invalid_client") {
		return new GithubError(409, "not_configured", "GitHub does not recognise this OAuth client id.");
	}
	return new GithubError(502, "upstream", `GitHub refused to start the device flow: ${str(body.error_description) ?? code ?? "unknown error"}`);
}
