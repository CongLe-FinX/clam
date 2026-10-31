import { type ActivityItem, type FilesApplyResult, type FilesPreview, type Task, type TaskConstraints, type TaskDeliverAs, type TaskDetail, type TaskEvent, type TaskMessage, routes } from "@clam/contracts";
import { type InfiniteData, type QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queries";
import { useTopic } from "@/lib/ws";
import { isTerminal } from "./format.ts";

type DecideBody = { decision: "accept"; projectId?: string; agentId?: string } | { decision: "reject"; reason: string };
// Request bodies as the UI sends them (the contracts export the Zod schemas, not their inferred types).
export interface CreateTaskInput {
	targetNodeId: string;
	targetAgentId?: string;
	/** Needed when there is no project (a project implies its workspace). */
	workspaceId?: string;
	/** Optional: without a project the executor runs in a fresh folder (deliverAs summary/files). */
	projectId?: string;
	title: string;
	description: string;
	/** Omit to let the server pick (`branch` for a project with a GitHub repository, else `files`). */
	deliverAs?: TaskDeliverAs;
	/** Project-relative files/folders sent along as input. */
	inputPaths?: string[];
	baseBranch?: string;
	constraints: TaskConstraints;
}
export interface PostMessageInput {
	text: string;
	kind: "instruction" | "answer" | "note";
}

const byTime = <T extends { createdAt: string }>(a: T, b: T) => Date.parse(a.createdAt) - Date.parse(b.createdAt);

export function useTask(id: string) {
	return useQuery({
		queryKey: qk.task(id),
		queryFn: ({ signal }) => api.get<TaskDetail>(routes.task(id), undefined, { signal }),
		// The topic is the fast path; this keeps an open task honest if a frame was lost.
		refetchInterval: (q) => {
			const d = q.state.data;
			if (!d) return false;
			// Outbox delivery (task or message) flips without a topic event: poll quickly while something is still being sent.
			if (d.task.delivery.state === "pending" || d.messages.some((m) => m.delivery === "pending")) return 2_500;
			return isTerminal(d.task.status) ? false : 15_000;
		},
	});
}

function patchDetail(qc: QueryClient, id: string, fn: (d: TaskDetail) => TaskDetail): void {
	qc.setQueryData<TaskDetail>(qk.task(id), (d) => (d ? fn(d) : d));
}

export function upsertMessage(list: TaskMessage[], m: TaskMessage): TaskMessage[] {
	const i = list.findIndex((x) => x.id === m.id);
	if (i < 0) return [...list, m].sort(byTime);
	return list.map((x, j) => (j === i ? m : x));
}

export function upsertEvent(list: TaskEvent[], e: TaskEvent): TaskEvent[] {
	const i = list.findIndex((x) => x.seq === e.seq);
	if (i < 0) return [...list, e].sort((a, b) => a.seq - b.seq);
	return list.map((x, j) => (j === i ? e : x));
}

function putTask(qc: QueryClient, t: Task): void {
	qc.setQueryData<Task[]>(qk.tasks, (d) => (d ? (d.some((x) => x.id === t.id) ? d.map((x) => (x.id === t.id ? t : x)) : [t, ...d]) : d));
	patchDetail(qc, t.id, (d) => ({ ...d, task: t }));
}

/** Keeps one open task's detail cache current from `task:<id>`. */
export function useTaskLive(id: string): void {
	const qc = useQueryClient();
	useTopic(
		`task:${id}`,
		(e) => {
			if (e.type === "task") putTask(qc, e.task);
			else if (e.type === "event") patchDetail(qc, id, (d) => ({ ...d, events: upsertEvent(d.events, e.event) }));
			else if (e.type === "message") patchDetail(qc, id, (d) => ({ ...d, messages: upsertMessage(d.messages, e.message) }));
		},
		{ onResync: () => void qc.invalidateQueries({ queryKey: qk.task(id) }) },
	);
}

export function useCreateTask() {
	const qc = useQueryClient();
	const navigate = useNavigate();
	return useMutation({
		mutationFn: (body: CreateTaskInput) => api.post<Task>(routes.tasks, body),
		onSuccess: (t) => {
			qc.setQueryData<Task[]>(qk.tasks, (d) => (d ? [t, ...d.filter((x) => x.id !== t.id)] : d));
			void qc.invalidateQueries({ queryKey: qk.tasks });
			toast.success(`Delegated “${t.title}” to ${t.executor.agentName ? `${t.executor.agentName}@` : ""}${t.executor.nodeName}`, {
				description: t.delivery.state === "pending" ? "It will be delivered as soon as the machine is reachable." : undefined,
			});
			void navigate({ to: "/tasks/$taskId", params: { taskId: t.id } });
		},
	});
}

/** deliverAs = files: the result bundle compared with a local project (new / update / conflict / unchanged + diffs). */
export function useTaskFilesPreview(taskId: string, projectId: string) {
	return useQuery({
		queryKey: qk.taskFilesPreview(taskId, projectId),
		queryFn: ({ signal }) => api.get<FilesPreview>(routes.taskFilesPreview(taskId), { projectId }, { signal }),
		enabled: projectId !== "",
		// A preview is a snapshot of local files: never reuse a stale one when the dialog reopens.
		staleTime: 0,
		gcTime: 0,
		retry: false,
	});
}

export function useApplyTaskFiles(taskId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: { projectId: string; paths?: string[]; overwrite: string[] }) => api.post<FilesApplyResult>(routes.taskFilesApply(taskId), body),
		onSuccess: (r, vars) => {
			toast.success(`Applied ${r.written.length} ${r.written.length === 1 ? "file" : "files"}`, {
				description: r.skipped.length > 0 ? `${r.skipped.length} skipped.` : undefined,
			});
			void qc.invalidateQueries({ queryKey: qk.task(taskId) });
			void qc.invalidateQueries({ queryKey: qk.tasks });
			void qc.invalidateQueries({ queryKey: qk.taskFilesPreview(taskId, vars.projectId) });
			void qc.invalidateQueries({ queryKey: ["local", "project", vars.projectId, "files"] });
		},
	});
}

export function useDecideTask(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: DecideBody) => api.post<Task>(routes.taskDecide(id), body),
		onSuccess: (t, v) => {
			putTask(qc, t);
			toast.success(v.decision === "accept" ? "Task accepted" : "Task rejected");
			void qc.invalidateQueries({ queryKey: qk.task(id) });
		},
		onError: (e) => toast.error("Could not update the task", { description: errorMessage(e) }),
	});
}

export function useCancelTask(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (reason?: string) => api.post<Task>(routes.taskCancel(id), reason ? { reason } : {}),
		onSuccess: (t) => {
			putTask(qc, t);
			void qc.invalidateQueries({ queryKey: qk.task(id) });
			toast.success("Cancellation requested");
		},
		onError: (e) => toast.error("Could not cancel the task", { description: errorMessage(e) }),
	});
}

export function useRetryTask(id: string) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	return useMutation({
		mutationFn: () => api.post<Task>(routes.taskRetry(id)),
		onSuccess: (t) => {
			void qc.invalidateQueries({ queryKey: qk.tasks });
			toast.success("Task delegated again");
			void navigate({ to: "/tasks/$taskId", params: { taskId: t.id } });
		},
		onError: (e) => toast.error("Could not retry the task", { description: errorMessage(e) }),
	});
}

export function usePostTaskMessage(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: PostMessageInput) => api.post<TaskMessage>(routes.taskMessages(id), body),
		onSuccess: (m) => patchDetail(qc, id, (d) => ({ ...d, messages: upsertMessage(d.messages, m) })),
		onError: (e) => toast.error("Could not send the message", { description: errorMessage(e) }),
	});
}

/** Marks the task's messages read and clears the unread count locally. */
export function useMarkTaskRead(id: string): () => void {
	const qc = useQueryClient();
	return useCallback(() => {
		const clear = (t: Task): Task => (t.id === id && t.unreadMessages > 0 ? { ...t, unreadMessages: 0 } : t);
		qc.setQueryData<Task[]>(qk.tasks, (d) => d?.map(clear));
		patchDetail(qc, id, (d) => ({ ...d, task: clear(d.task) }));
		void api.post(routes.taskRead(id)).catch(() => void qc.invalidateQueries({ queryKey: qk.task(id) }));
	}, [qc, id]);
}

// ───────────────────────── activity feed ─────────────────────────

const ACTIVITY_PAGE = 40;

export function useActivity(workspaceId?: string) {
	return useInfiniteQuery({
		queryKey: qk.activity(workspaceId),
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam, signal }) => api.get<ActivityItem[]>(routes.activity, { workspaceId, limit: ACTIVITY_PAGE, before: pageParam }, { signal }),
		getNextPageParam: (last) => (last.length < ACTIVITY_PAGE ? undefined : last[last.length - 1]?.at),
		select: (d: InfiniteData<ActivityItem[], string | undefined>) => d.pages.flat(),
		staleTime: 10_000,
	});
}
