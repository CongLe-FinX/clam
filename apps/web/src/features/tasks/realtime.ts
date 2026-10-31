import type { Task } from "@clam/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
			const t = e.task;
			qc.setQueryData<Task[]>(qk.tasks, (d) => (d ? (d.some((x) => x.id === t.id) ? d.map((x) => (x.id === t.id ? t : x)) : [t, ...d]) : d));
			qc.setQueryData<{ task: Task }>(qk.task(t.id), (d) => (d ? { ...d, task: t } : d));
			void qc.invalidateQueries({ queryKey: qk.activityAll });
			if (t.direction === "incoming" && t.status === "offered") {
				// One notice per offer (the task frame also fires on every new message); none while its page is open.
				if (offerToasted[t.id] || location.pathname === `/tasks/${t.id}`) return;
				offerToasted[t.id] = true;
				toast(`Task offered by ${t.sender.nodeName}`, {
					id: `task-offer-${t.id}`,
					description: t.title,
					duration: 20_000,
					action: { label: "Review", onClick: () => openTask(t.id) },
				});
			} else {
				toast.dismiss(`task-offer-${t.id}`);
			}
		},
		() => {
			void qc.invalidateQueries({ queryKey: qk.tasks });
			void qc.invalidateQueries({ queryKey: ["local", "task"] });
		},
	);
}
