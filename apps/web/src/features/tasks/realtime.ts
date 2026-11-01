import type { Task } from "@clam/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { t } from "@/i18n";
import { qk } from "@/lib/queries";
import { ws } from "@/lib/ws";

const offerToasted: Record<string, true> = {};

/**
 * Keeps the task list (and open task details) current from the `tasks` topic, and announces new offers. Loaded on demand by the
 * app shell so none of this sits in the initial bundle.
 */
export function startTaskBridge(qc: QueryClient, openTask: (taskId: string) => void): () => void {
	return ws.subscribe(
		"tasks",
		(e) => {
			if (e.type !== "task") return;
			const task = e.task;
			qc.setQueryData<Task[]>(qk.tasks, (d) => (d ? (d.some((x) => x.id === task.id) ? d.map((x) => (x.id === task.id ? task : x)) : [task, ...d]) : d));
			qc.setQueryData<{ task: Task }>(qk.task(task.id), (d) => (d ? { ...d, task } : d));
			void qc.invalidateQueries({ queryKey: qk.activityAll });
			if (task.direction === "incoming" && task.status === "offered") {
				// One notice per offer (the task frame also fires on every new message); none while its page is open.
				if (offerToasted[task.id] || location.pathname === `/tasks/${task.id}`) return;
				offerToasted[task.id] = true;
				toast(t("Task offered by {name}", { name: task.sender.nodeName }), {
					id: `task-offer-${task.id}`,
					description: task.title,
					duration: 20_000,
					action: { label: t("Review"), onClick: () => openTask(task.id) },
				});
			} else {
				toast.dismiss(`task-offer-${task.id}`);
			}
		},
		() => {
			void qc.invalidateQueries({ queryKey: qk.tasks });
			void qc.invalidateQueries({ queryKey: ["local", "task"] });
		},
	);
}
