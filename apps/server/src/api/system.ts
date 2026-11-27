import { ELEVATION_MINUTES, routes, type DiskUsageReport, type QuitAppResult, type SystemProcesses, type SystemStatus, QuitAppBody, i18nMsg } from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import type { RoutePluginOptions } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { recordAudit } from "../services/audit.ts";
import { SystemMonitor } from "../services/system-monitor.ts";

/**
 * Host CPU / memory / disk, the apps using them (which the owner can quit), and an on-demand size scan of the user's home folder.
 * No client-supplied paths.
 */
export default async function systemRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const monitor = new SystemMonitor(ctx.config.dataDir);
	monitor.start();
	app.addHook("onClose", async () => monitor.stop());

	app.get(routes.system, async (): Promise<SystemStatus> => monitor.status());
	app.get(routes.systemProcesses, async (): Promise<SystemProcesses> => monitor.processes());

	/** Quit an app of the list. Through the domain this stops processes on the machine: like the Terminal, it needs the password again. */
	app.post(routes.systemQuitApp, async (request): Promise<QuitAppResult> => {
		const body = QuitAppBody.parse(request.body);
		const { via, session } = request.access;
		if (via === "remote" && ctx.access.elevatedUntil(session) === null) {
			throw new ApiError(403, "step_up_required", i18nMsg("Re-enter the owner password to quit apps through the domain"), { elevationMinutes: ELEVATION_MINUTES });
		}
		const result = await monitor.quitApp(body.name, body.force === true);
		recordAudit(ctx, "system.quit_app", { via, name: body.name, force: body.force === true, stopped: result.stopped, running: result.running, denied: result.denied, sid: session?.sid.slice(0, 8) ?? null });
		return result;
	});

	app.get(routes.systemDiskUsage, async (): Promise<DiskUsageReport> => {
		const report = monitor.cachedDiskUsage();
		if (!report) throw ApiError.notFound("Disk usage report");
		return report;
	});
	app.post(routes.systemDiskUsage, async (): Promise<DiskUsageReport> => monitor.scanDiskUsage());
}
