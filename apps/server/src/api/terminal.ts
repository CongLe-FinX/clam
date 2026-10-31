import { CreateTerminalBody, UpdateTerminalBody, routes, type TerminalInfo, type TerminalSession } from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";
import { recordAudit } from "../services/audit.ts";

const IdParams = z.object({ id: z.string().min(1).max(64) });

/**
 * The machine's Terminal (REST side): list, create, rename, kill. The bytes travel on `/ws/terminal/:id` (`ws/terminal.ts`).
 * Loopback UI: always. Through the domain: only with the Terminal switched on, and creating one needs a recent password re-entry.
 */
export default async function terminalRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const { access, terminals } = ctx;

	app.get(routes.terminalInfo, async (request): Promise<TerminalInfo> => {
		access.assertTool(request.access, "terminal");
		return terminals.info();
	});

	app.get(routes.terminalSessions, async (request): Promise<TerminalSession[]> => {
		access.assertTool(request.access, "terminal");
		return terminals.list();
	});

	app.get<{ Params: { id: string } }>(routes.terminalSession(":id"), async (request): Promise<TerminalSession> => {
		access.assertTool(request.access, "terminal");
		return terminals.get(IdParams.parse(request.params).id);
	});

	app.post(routes.terminalSessions, async (request, reply): Promise<TerminalSession> => {
		access.assertTool(request.access, "terminal", { stepUp: true });
		const body = CreateTerminalBody.parse(request.body ?? {});
		const session = await terminals.create({ ...body, cols: body.cols ?? 80, rows: body.rows ?? 24 });
		recordAudit(ctx, "terminal.open", { via: request.access.via, terminal: session.id, shell: session.shell, cwd: session.cwd, sid: request.access.session?.sid.slice(0, 8) ?? null });
		return reply.status(201).send(session);
	});

	app.patch<{ Params: { id: string } }>(routes.terminalSession(":id"), async (request): Promise<TerminalSession> => {
		access.assertTool(request.access, "terminal");
		return terminals.rename(IdParams.parse(request.params).id, UpdateTerminalBody.parse(request.body).title);
	});

	app.delete<{ Params: { id: string } }>(routes.terminalSession(":id"), async (request, reply) => {
		access.assertTool(request.access, "terminal");
		const session = terminals.kill(IdParams.parse(request.params).id);
		recordAudit(ctx, "terminal.close", { via: request.access.via, terminal: session.id, status: session.status, sid: request.access.session?.sid.slice(0, 8) ?? null });
		return reply.status(204).send();
	});
}
