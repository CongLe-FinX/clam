import { routes, type DiskUsageReport, type SystemProcesses, type SystemStatus } from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import type { RoutePluginOptions } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { SystemMonitor } from "../services/system-monitor.ts";

/** Host CPU / memory / disk, the apps using them, and an on-demand size scan of the user's home folder. Read-only; no client-supplied paths. */
export default async function systemRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const monitor = new SystemMonitor(ctx.config.dataDir);
	monitor.start();
	app.addHook("onClose", async () => monitor.stop());

	app.get(routes.system, async (): Promise<SystemStatus> => monitor.status());
	app.get(routes.systemProcesses, async (): Promise<SystemProcesses> => monitor.processes());
	app.get(routes.systemDiskUsage, async (): Promise<DiskUsageReport> => {
		const report = monitor.cachedDiskUsage();
		if (!report) throw ApiError.notFound("Disk usage report");
		return report;
	});
	app.post(routes.systemDiskUsage, async (): Promise<DiskUsageReport> => monitor.scanDiskUsage());
}
