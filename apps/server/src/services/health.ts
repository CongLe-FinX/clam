import { type HealthCheck, type HealthStatus, type I18nMessage, type NodeHealth, i18nMsg } from "@clam/contracts";
import type { OmpInstall } from "@clam/contracts";
import { sql } from "drizzle-orm";
import type { ServerContext } from "../context.ts";

const OMP_CACHE_MS = 60_000;
const HEALTH_PUBLISH_MS = 30_000;
const WORST: Record<HealthStatus, number> = { ok: 0, degraded: 1, down: 2 };

/** A check's `message` (English) next to its structured twin. */
const say = (m: I18nMessage): Pick<HealthCheck, "message" | "i18n"> => ({ message: m.text, ...(m.i18n && { i18n: m.i18n }) });

export type HealthContext = Pick<ServerContext, "db" | "ompCli" | "runtime" | "startedAt" | "bus" | "log">;

/** Node health: database ping, OMP availability (cached), runtime supervision. Pure reads, safe to call often. */
export class HealthService {
	private readonly ctx: HealthContext;
	private ompCache: { at: number; install: OmpInstall } | null = null;
	private timer: NodeJS.Timeout | null = null;
	private lastPublished = "";
	private readonly stopFns: Array<() => void> = [];

	constructor(ctx: HealthContext) {
		this.ctx = ctx;
	}

	private async omp(): Promise<OmpInstall> {
		const cached = this.ompCache;
		if (cached && Date.now() - cached.at < OMP_CACHE_MS) return cached.install;
		const install = await this.ctx.ompCli.detect();
		this.ompCache = { at: Date.now(), install };
		return install;
	}

	invalidateOmp(): void {
		this.ompCache = null;
	}

	async check(): Promise<NodeHealth> {
		const checks: HealthCheck[] = [];

		const dbStart = performance.now();
		try {
			this.ctx.db.run(sql`select 1`);
			checks.push({ name: "database", status: "ok", latencyMs: Math.round((performance.now() - dbStart) * 10) / 10 });
		} catch (error) {
			checks.push({ name: "database", status: "down", message: error instanceof Error ? error.message : String(error) });
		}

		const ompStart = performance.now();
		const install = await this.omp();
		checks.push(
			install.installed
				? { name: "omp", status: "ok", ...say(i18nMsg("{version} at {path}", { version: install.version ?? "omp", path: install.binaryPath ?? "" })), latencyMs: Math.round(performance.now() - ompStart) }
				: { name: "omp", status: "degraded", ...(install.error ? { message: install.error } : say(i18nMsg("OMP is not installed; agents cannot run"))) },
		);

		const runtimes = this.ctx.runtime.list();
		const crashed = runtimes.filter((r) => r.state === "crashed");
		const active = runtimes.filter((r) => r.state !== "stopped" && r.state !== "crashed").length;
		checks.push(
			crashed.length > 0
				? { name: "runtime", status: "degraded", ...say(i18nMsg("{crashed, plural, one {# agent runtime} other {# agent runtimes}} crashed ({active} running)", { crashed: crashed.length, active })) }
				: { name: "runtime", status: "ok", ...say(i18nMsg("{active, plural, one {# agent runtime} other {# agent runtimes}} running", { active })) },
		);

		const status = checks.reduce<HealthStatus>((worst, c) => (WORST[c.status] > WORST[worst] ? c.status : worst), "ok");
		const memory = process.memoryUsage();
		return {
			status,
			uptimeMs: Date.now() - this.ctx.startedAt.getTime(),
			checks,
			memory: { rss: memory.rss, heapUsed: memory.heapUsed },
			activeRuntimes: active,
			checkedAt: new Date().toISOString(),
		};
	}

	/** Publish `node` health every 30 s and, debounced, when a runtime status change alters the aggregate. */
	startPublishing(): void {
		const publish = async (onlyIfChanged: boolean) => {
			try {
				const health = await this.check();
				const signature = `${health.status}:${health.activeRuntimes}:${health.checks.map((c) => c.status).join(",")}`;
				if (onlyIfChanged && signature === this.lastPublished) return;
				this.lastPublished = signature;
				this.ctx.bus.publish("node", { type: "health", health });
			} catch (error) {
				this.ctx.log.warn({ err: error }, "health publish failed");
			}
		};
		let debounce: NodeJS.Timeout | undefined;
		const offStatus = this.ctx.runtime.onStatus(() => {
			clearTimeout(debounce);
			debounce = setTimeout(() => void publish(true), 250);
			debounce.unref();
		});
		this.stopFns.push(offStatus, () => clearTimeout(debounce));
		this.timer = setInterval(() => void publish(false), HEALTH_PUBLISH_MS);
		this.timer.unref();
		void publish(false);
	}

	stop(): void {
		clearInterval(this.timer ?? undefined);
		this.timer = null;
		for (const stop of this.stopFns.splice(0)) stop();
	}
}
