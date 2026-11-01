import { type AgentSession, routes } from "@clam/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorText } from "@/lib/api";
import { qk } from "@/lib/queries";

export interface SessionPatch {
	title?: string;
	archived?: boolean;
}

/** PATCH a session (rename / archive) with optimistic cache updates and rollback. */
export function useUpdateSession() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, patch }: { id: string; patch: SessionPatch }) => api.patch<AgentSession>(routes.session(id), patch),
		onMutate: async ({ id, patch }) => {
			await Promise.all([qc.cancelQueries({ queryKey: qk.sessionsAll }), qc.cancelQueries({ queryKey: qk.session(id), exact: true })]);
			const lists = qc.getQueriesData<AgentSession[]>({ queryKey: qk.sessionsAll });
			const one = qc.getQueryData<AgentSession>(qk.session(id));
			if (one) qc.setQueryData<AgentSession>(qk.session(id), { ...one, ...patch });
			for (const [key, data] of lists) {
				if (!Array.isArray(data)) continue;
				const next = patch.archived === true ? data.filter((s) => s.id !== id) : data.map((s) => (s.id === id ? { ...s, ...patch } : s));
				qc.setQueryData(key, next);
			}
			return { lists, one };
		},
		onError: (e, { id }, ctx) => {
			if (ctx) {
				for (const [key, data] of ctx.lists) qc.setQueryData(key, data);
				if (ctx.one) qc.setQueryData(qk.session(id), ctx.one);
			}
			toast.error(errorText(e));
		},
		onSettled: (_d, _e, { id }) => {
			void qc.invalidateQueries({ queryKey: qk.sessionsAll });
			void qc.invalidateQueries({ queryKey: qk.session(id), exact: true });
		},
	});
}
