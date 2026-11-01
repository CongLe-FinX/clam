import { type Handoff, routes } from "@clam/contracts";
import { type UseMutationResult, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { t } from "@/i18n";
import { api, errorText } from "@/lib/api";
import { hk, putHandoff } from "./api.ts";

/** Body of POST /handoffs as the UI sends it (docs: CreateTaskHandoffBody). */
export interface CreateHandoffInput {
	taskId: string;
	targetNodeId: string;
	targetAgentId?: string;
	stopRunning: boolean;
	includeTranscript: boolean;
	setupCommands: string[];
	checkCommand?: string;
}

export type DecideBody = { decision: "accept"; projectId?: string; agentId?: string } | { decision: "reject"; reason: string };

/** The mutations behind the action buttons of one handoff. */
export interface HandoffActions {
	decide: UseMutationResult<Handoff, unknown, DecideBody>;
	setup: UseMutationResult<Handoff, unknown, { approve: string[]; deny: string[] }>;
	retry: UseMutationResult<Handoff, unknown, void>;
	extend: UseMutationResult<Handoff, unknown, number>;
	reclaim: UseMutationResult<Handoff, unknown, boolean>;
	cancel: UseMutationResult<Handoff, unknown, void>;
}

/** One mutation per action; every one writes the returned record straight into the caches (the topic then confirms it). */
export function useHandoffActions(id: string): HandoffActions {
	const qc = useQueryClient();
	const done = (message: string) => (h: Handoff) => {
		putHandoff(qc, h);
		void qc.invalidateQueries({ queryKey: hk.detail(id) });
		toast.success(message);
	};
	const fail = (title: string) => (e: unknown) => toast.error(title, { description: errorText(e) });

	return {
		decide: useMutation({
			mutationFn: (body: DecideBody) => api.post<Handoff>(routes.handoffDecide(id), body),
			onSuccess: (h, v) => done(v.decision === "accept" ? t("Handoff accepted. Restoring the work…") : t("Handoff rejected"))(h),
			onError: fail(t("Could not answer the handoff")),
		}),
		setup: useMutation({
			mutationFn: (body: { approve: string[]; deny: string[] }) => api.post<Handoff>(routes.handoffSetup(id), body),
			onSuccess: (h, v) => done(v.deny.length > 0 && v.approve.length === 0 ? t("Setup denied") : t("Setup approved"))(h),
			onError: fail(t("Could not save the setup decision")),
		}),
		retry: useMutation({
			mutationFn: () => api.post<Handoff>(routes.handoffRetry(id)),
			onSuccess: done(t("Retrying")),
			onError: fail(t("Could not retry")),
		}),
		extend: useMutation({
			mutationFn: (minutes: number) => api.post<Handoff>(routes.handoffExtend(id), { minutes }),
			onSuccess: (h, minutes) => done(t("{count, plural, one {Deadline extended by # minute} other {Deadline extended by # minutes}}", { count: minutes }))(h),
			onError: fail(t("Could not extend the deadline")),
		}),
		reclaim: useMutation({
			mutationFn: (override: boolean) => api.post<Handoff>(routes.handoffReclaim(id), { override }),
			onSuccess: done(t("Task reclaimed on this machine")),
		}),
		cancel: useMutation({
			mutationFn: () => api.delete<Handoff>(routes.handoff(id)),
			onSuccess: done(t("Handoff cancelled")),
			onError: fail(t("Could not cancel")),
		}),
	};
}

export function useCreateHandoff() {
	const qc = useQueryClient();
	const navigate = useNavigate();
	return useMutation({
		mutationFn: (body: CreateHandoffInput) => api.post<Handoff>(routes.handoffs, body),
		onSuccess: (h) => {
			putHandoff(qc, h);
			void qc.invalidateQueries({ queryKey: hk.all });
			void qc.invalidateQueries({ queryKey: ["local", "tasks"] });
			toast.success(t("Handing off “{title}” to {name}", { title: h.title, name: h.target.nodeName }));
			void navigate({ to: "/handoffs/$handoffId", params: { handoffId: h.id } });
		},
	});
}
