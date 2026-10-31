import { readFile } from "node:fs/promises";
import { ApplyFilesBody, CancelTaskBody, CreateTaskBody, DecideTaskBody, PostTaskMessageBody, TaskListQuery, routes, type ActivityItem, type Task, type TaskDetail, type TaskMessage } from "@clam/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RoutePluginOptions } from "../context.ts";
import { ApiError } from "../http/errors.ts";
import { ACTIVITY_MAX_LIMIT, listActivity } from "../tasks/activity.ts";
import { fetchExecutorArtifact, sendArtifact } from "../tasks/artifact-proxy.ts";

const IdParams = z.object({ id: z.string().min(1).max(128) });
const ArtifactParams = IdParams.extend({ artifactId: z.string().min(1).max(128) });
const PreviewQuery = z.object({ projectId: z.string().min(1) });
const ActivityQuery = z.object({
	workspaceId: z.string().min(1).optional(),
	limit: z.coerce.number().int().min(1).max(ACTIVITY_MAX_LIMIT).optional(),
	before: z.string().datetime().optional(),
});

/** Delegated tasks, their discussion, artifacts and the activity feed (local UI side of M4). */
export default async function taskRoutes(app: FastifyInstance, { ctx }: RoutePluginOptions): Promise<void> {
	const tasks = ctx.tasks;

	app.get(routes.tasks, async (req): Promise<Task[]> => tasks.list(TaskListQuery.parse(req.query)));
	app.post(routes.tasks, async (req, reply) => reply.status(201).send(await tasks.create(CreateTaskBody.parse(req.body))));
	app.get(routes.task(":id"), async (req): Promise<TaskDetail> => tasks.detail(IdParams.parse(req.params).id));

	app.post(routes.taskMessages(":id"), async (req, reply) => {
		const { id } = IdParams.parse(req.params);
		const body = PostTaskMessageBody.parse(req.body);
		// A person at this node typing in the task thread: never an agent, so the loop guard resets.
		const message: TaskMessage = await tasks.postMessage(id, { text: body.text, kind: body.kind, author: { kind: "human", agentId: null, agentName: null } });
		return reply.status(201).send(message);
	});

	// Result files of a task without git (deliverAs files): what applying them to a local project would do, then do it. Never overwrites a locally changed file unless listed.
	app.get(routes.taskFilesPreview(":id"), async (req) => tasks.filesPreview(IdParams.parse(req.params).id, PreviewQuery.parse(req.query).projectId));
	app.post(routes.taskFilesApply(":id"), async (req) => tasks.filesApply(IdParams.parse(req.params).id, ApplyFilesBody.parse(req.body)));

	app.post(routes.taskDecide(":id"), async (req): Promise<Task> => tasks.decide(IdParams.parse(req.params).id, DecideTaskBody.parse(req.body)));
	app.post(routes.taskCancel(":id"), async (req): Promise<Task> => {
		const { id } = IdParams.parse(req.params);
		return tasks.cancel(id, CancelTaskBody.parse(req.body ?? {}).reason ?? null);
	});
	app.post(routes.taskRetry(":id"), async (req, reply) => reply.status(201).send(await tasks.retry(IdParams.parse(req.params).id)));
	app.post(routes.taskRead(":id"), async (req, reply) => {
		tasks.markRead(IdParams.parse(req.params).id);
		return reply.status(204).send();
	});

	// Only artifacts the task result lists are downloadable. The executor serves its own file; the sender fetches it from the executor.
	// Bytes are served as stored, with the digest of exactly those bytes: never content-encoded.
	app.get(routes.taskArtifact(":id", ":artifactId"), { compress: false }, async (req, reply) => {
		const params = ArtifactParams.parse(req.params);
		const row = tasks.store.get(params.id);
		const listed = row.result?.artifacts.find((a) => a.artifactId === params.artifactId) ?? (row.result?.files?.artifactId === params.artifactId ? { ...row.result.files, name: "result-files.tar.gz" } : undefined);
		if (!listed) throw ApiError.notFound("Artifact");
		if (row.direction === "outgoing") {
			const bytes = await fetchExecutorArtifact(ctx, row, listed);
			// The name and type come from a peer: serve it as an opaque download.
			return sendArtifact(reply, { bytes, name: listed.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "artifact", mediaType: "application/octet-stream" });
		}
		const artifact = tasks.store.artifact(row.id, listed.artifactId);
		if (!artifact) throw ApiError.notFound("Artifact");
		return sendArtifact(reply, { bytes: await readFile(tasks.artifacts.absolutePath(artifact)), name: artifact.name, mediaType: artifact.mediaType });
	});

	app.get(routes.activity, async (req): Promise<ActivityItem[]> => listActivity(ctx, ActivityQuery.parse(req.query)));
}
