import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { wire } from "@clam/agent-network";
import type { Capability } from "@clam/contracts";
import { checkEpoch } from "@clam/task-engine";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../http/errors.ts";
import { runIdempotent } from "./idempotency.ts";
import { sendArtifact } from "../tasks/artifact-proxy.ts";
import type { TaskService } from "../tasks/service.ts";
import type { TaskRow } from "../tasks/store.ts";

export interface BodySchema<T> {
	safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}

/** The listener's authentication helpers, shared so the task endpoints are verified exactly like every other signed endpoint. */
export interface TaskWireDeps {
	tasks: TaskService;
	authenticate(request: FastifyRequest, reply: FastifyReply, needed: Capability[]): Promise<void>;
	requires(...needed: Capability[]): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
	bodyOf<T>(schema: BodySchema<T>, request: FastifyRequest): T;
}

interface IdParams {
	id: string;
}

/**
 * `/api/v1/tasks*` (docs/agent-network-protocol.md §5.5–5.8). Every handler runs after `authenticate`, so `request.peer`
 * is the verified peer. A task is only visible to the peer it was exchanged with: anything else answers 404.
 */
export function registerTaskWireRoutes(api: FastifyInstance, deps: TaskWireDeps): void {
	const { tasks, requires, bodyOf } = deps;
	const { store } = tasks;
	const idempotency = { store: tasks.idempotency, inFlight: new Set<string>() };
	const idempotent = (request: FastifyRequest, reply: FastifyReply, run: () => Promise<{ status: number; body: unknown }>): Promise<FastifyReply> => runIdempotent(idempotency, request, reply, run);

	/** The task, if it exists and is the caller's; 404 otherwise (never reveal that someone else's task exists). */
	function ownTask(request: FastifyRequest, taskId: string, direction?: "incoming"): TaskRow {
		const row = store.find(taskId);
		if (!row || row.peerId !== request.peer?.id || (direction !== undefined && row.direction !== direction)) throw ApiError.notFound("Task");
		return row;
	}

	api.post("/tasks", { preHandler: requires("tasks.send") }, (request, reply) =>
		idempotent(request, reply, async () => {
			const body = bodyOf(wire.CreateTaskRequest, request);
			const { row, created } = await tasks.executor.receive(request.peer?.id as string, body);
			return { status: !created ? 200 : row.status === "offered" ? 202 : 201, body: store.toWireRecord(row) satisfies wire.TaskRecord };
		}),
	);

	api.get<{ Params: IdParams; Querystring: { since?: string } }>("/tasks/:id", { preHandler: requires() }, async (request): Promise<wire.GetTaskResponse> => {
		const row = ownTask(request, request.params.id);
		const { since } = request.query;
		if (since === undefined) return store.toWireRecord(row);
		if (!/^\d{1,15}$/.test(since)) throw ApiError.badRequest("since must be a non-negative integer");
		return { ...store.toWireRecord(row), events: store.eventsSince(row.id, Number(since)).map((e) => store.toEvent(e)) };
	});

	api.post<{ Params: IdParams }>("/tasks/:id/cancel", { preHandler: requires("tasks.cancel") }, (request, reply) =>
		idempotent(request, reply, async () => {
			const row = ownTask(request, request.params.id, "incoming");
			const body = bodyOf(wire.CancelTaskRequest, request);
			const epoch = checkEpoch(row.epoch, body.epoch);
			if (!epoch.ok) {
				throw new ApiError(409, epoch.reason === "stale" ? "stale_epoch" : "conflict", `The cancel carries epoch ${body.epoch}; the task is at epoch ${row.epoch}`, { currentEpoch: epoch.currentEpoch });
			}
			const cancelled = await tasks.executor.cancel(row.id, { reason: body.reason ?? null, by: "sender" });
			return { status: 200, body: store.toWireRecord(cancelled) satisfies wire.TaskRecord };
		}),
	);

	api.post<{ Params: IdParams }>("/tasks/:id/messages", { preHandler: requires() }, (request, reply) => {
		const row = ownTask(request, request.params.id);
		// The capability depends on our role: the sender of a task instructs the executor, the executor reports back to the sender.
		const needed: Capability = row.direction === "incoming" ? "tasks.send" : "tasks.receive";
		if (!request.peer?.capabilities.includes(needed)) throw new ApiError(403, "forbidden", `Missing capability: ${needed}`, { missing: [needed] });
		return idempotent(request, reply, async () => {
			const body = bodyOf(wire.TaskMessageRequest, request);
			return { status: 202, body: await tasks.receiveMessage(request.peer?.id as string, row.id, body) };
		});
	});

	api.get<{ Params: IdParams & { artifactId: string } }>("/tasks/:id/artifacts/:artifactId", { preHandler: requires() }, async (request, reply) => {
		const { params } = request;
		const task = ownTask(request, params.id, "incoming");
		const artifact = store.artifact(task.id, params.artifactId);
		if (!artifact) throw ApiError.notFound("Artifact");
		let bytes: Buffer;
		try {
			bytes = await readFile(tasks.artifacts.absolutePath(artifact));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw ApiError.notFound("Artifact");
			throw error;
		}
		return sendArtifact(reply, { bytes, name: artifact.name, mediaType: artifact.mediaType });
	});
}
