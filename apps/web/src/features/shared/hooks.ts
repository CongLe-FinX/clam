import { type Checkpoint, type SharedInvite, type SharedMessage, type SharedSession, type SharedSessionDetail, type SharedTopicEvent, type TransferBody, routes } from "@clam/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { qk, usePeers } from "@/lib/queries";
import { useTopic } from "@/lib/ws";

/** Web UI base URL of a node: what it published, else the address this node reaches it on (its domain serves the UI once remote access is on). */
export function useNodeUiUrl(nodeId: string, published: string | null): string | null {
	const peers = usePeers().data;
	return published ?? peers?.find((p) => p.id === nodeId)?.url ?? null;
}

/** The group log is replicated on every member node: its order is (hlc, originNodeId, id), never the local clock. */
export const compareMessages = (a: SharedMessage, b: SharedMessage): number =>
	a.hlc !== b.hlc ? (a.hlc < b.hlc ? -1 : 1) : a.originNodeId !== b.originNodeId ? (a.originNodeId < b.originNodeId ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function upsertSharedMessage(list: SharedMessage[], m: SharedMessage): SharedMessage[] {
	const i = list.findIndex((x) => x.id === m.id);
	if (i < 0) return [...list, m].sort(compareMessages);
	return list.map((x, j) => (j === i ? m : x));
}
export function upsertCheckpoint(list: Checkpoint[], c: Checkpoint): Checkpoint[] {
	const i = list.findIndex((x) => x.seq === c.seq);
	if (i < 0) return [...list, c].sort((a, b) => a.seq - b.seq);
	return list.map((x, j) => (j === i ? c : x));
}

function putShared(qc: QueryClient, s: SharedSession): void {
	qc.setQueryData<SharedSession[]>(qk.shared, (d) => (d ? (d.some((x) => x.id === s.id) ? d.map((x) => (x.id === s.id ? s : x)) : [s, ...d]) : d));
	qc.setQueryData<SharedSessionDetail>(qk.sharedDetail(s.id), (d) => (d ? { ...d, shared: s } : d));
}

/** Applies one `shared` / `shared:<id>` frame to the caches. Used by the always-on bridge and by an open session. */
export function applySharedEvent(qc: QueryClient, e: SharedTopicEvent): void {
	switch (e.type) {
		case "shared":
			putShared(qc, e.shared);
			break;
		case "checkpoint":
			qc.setQueryData<SharedSessionDetail>(qk.sharedDetail(e.sharedSessionId), (d) => (d ? { ...d, checkpoints: upsertCheckpoint(d.checkpoints, e.checkpoint) } : d));
			break;
		case "message":
			qc.setQueryData<SharedSessionDetail>(qk.sharedDetail(e.sharedSessionId), (d) => (d ? { ...d, messages: upsertSharedMessage(d.messages, e.message) } : d));
			break;
		case "invite":
			qc.setQueryData<SharedInvite[]>(qk.sharedInvites, (d) => {
				if (!d) return d;
				return d.some((x) => x.id === e.invite.id) ? d.map((x) => (x.id === e.invite.id ? e.invite : x)) : [e.invite, ...d];
			});
			break;
	}
}

export function useSharedDetail(id: string | null) {
	return useQuery({
		queryKey: qk.sharedDetail(id ?? ""),
		queryFn: ({ signal }) => api.get<SharedSessionDetail>(routes.sharedSession(id ?? ""), undefined, { signal }),
		enabled: id !== null,
		// The topic is the fast path; polling covers a lost frame and outbox delivery flips (no event when a message is delivered).
		refetchInterval: (q) => {
			const d = q.state.data;
			if (!d) return false;
			return d.messages.some((m) => m.delivery === "pending") ? 2_500 : 20_000;
		},
	});
}

/** Keeps one open shared session current from `shared:<id>`. */
export function useSharedLive(id: string | null): void {
	const qc = useQueryClient();
	useTopic(
		id ? `shared:${id}` : null,
		(e) => applySharedEvent(qc, e as SharedTopicEvent),
		{ onResync: () => id && void qc.invalidateQueries({ queryKey: qk.sharedDetail(id) }) },
	);
}

function afterShareChange(qc: QueryClient, s: SharedSession): void {
	putShared(qc, s);
	void qc.invalidateQueries({ queryKey: qk.sessionsAll });
	if (s.localSessionId) void qc.invalidateQueries({ queryKey: qk.session(s.localSessionId) });
}

export function useAddParticipant(sessionId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: { nodeId: string; agentId?: string }) => api.post<SharedSession>(routes.sessionParticipants(sessionId), body),
		onSuccess: (s) => {
			qc.setQueryData<SharedSession[]>(qk.shared, (d) => (d ? (d.some((x) => x.id === s.id) ? d.map((x) => (x.id === s.id ? s : x)) : [s, ...d]) : d));
			void qc.invalidateQueries({ queryKey: qk.sharedDetail(s.id) });
			void qc.invalidateQueries({ queryKey: qk.sessionsAll });
			void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
		},
	});
}

export function useRemoveParticipant(sharedId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (nodeId: string) => api.delete<SharedSession>(routes.sharedParticipant(sharedId, nodeId)),
		onSuccess: (s) => {
			afterShareChange(qc, s);
			toast.success("Removed from the team");
		},
		onError: (e) => toast.error("Could not remove the participant", { description: errorMessage(e) }),
	});
}

export function usePostSharedMessage(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: { text: string; kind?: "chat" | "instruction" | "answer" | "note"; to?: { mode: "all" | "lead" | "agents"; agents: Array<{ nodeId: string; agentId: string }> } }) => api.post<SharedMessage>(routes.sharedMessages(id), body),
		onSuccess: (m) => qc.setQueryData<SharedSessionDetail>(qk.sharedDetail(id), (d) => (d ? { ...d, messages: upsertSharedMessage(d.messages, m) } : d)),
		onError: (e) => toast.error("Could not send the message", { description: errorMessage(e) }),
	});
}

/** Marks the thread read and clears the unread count locally. */
export function useMarkSharedRead(id: string): () => void {
	const qc = useQueryClient();
	return useCallback(() => {
		const clear = (s: SharedSession): SharedSession => (s.id === id && s.unreadMessages > 0 ? { ...s, unreadMessages: 0 } : s);
		qc.setQueryData<SharedSession[]>(qk.shared, (d) => d?.map(clear));
		qc.setQueryData<SharedSessionDetail>(qk.sharedDetail(id), (d) => (d ? { ...d, shared: clear(d.shared) } : d));
		void api.post(routes.sharedRead(id)).catch(() => void qc.invalidateQueries({ queryKey: qk.sharedDetail(id) }));
	}, [qc, id]);
}

export function useCheckpointNow(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (note?: string) => api.post<Checkpoint>(routes.sharedCheckpoint(id), note ? { note } : {}),
		onSuccess: (c) => {
			qc.setQueryData<SharedSessionDetail>(qk.sharedDetail(id), (d) => (d ? { ...d, checkpoints: upsertCheckpoint(d.checkpoints, c), shared: { ...d.shared, lastCheckpoint: c } } : d));
			void qc.invalidateQueries({ queryKey: qk.sharedDetail(id) });
			toast.success(`Checkpoint ${c.seq} saved`, { description: c.pushed ? "Pushed to the shared branch." : c.commit ? "Committed locally; the push was refused or is pending." : "No file changes; the session snapshot was shipped." });
		},
		onError: (e) => toast.error("Could not take a checkpoint", { description: errorMessage(e) }),
	});
}

/** Participant: continue the work on this node. Navigates to the new local session. */
export function useTakeover(id: string) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	return useMutation({
		mutationFn: (force: boolean) => api.post<SharedSession>(routes.sharedTakeover(id), { force }),
		onSuccess: (s) => {
			afterShareChange(qc, s);
			void qc.invalidateQueries({ queryKey: qk.sharedDetail(s.id) });
			toast.success("This node is now driving the session");
			if (s.localSessionId) void navigate({ to: "/sessions/$sessionId", params: { sessionId: s.localSessionId } });
		},
	});
}

/**
 * Driver: hand the work over to another node — shares the session first when needed, invites the node, then runs the hand-over in the
 * background. Progress is `SharedSession.transfer` (live on `shared:<id>`).
 */
export function useHandover(sessionId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: TransferBody) => api.post<SharedSession>(routes.sessionHandover(sessionId), body),
		onSuccess: (s) => {
			qc.setQueryData<SharedSession[]>(qk.shared, (d) => (d ? (d.some((x) => x.id === s.id) ? d.map((x) => (x.id === s.id ? s : x)) : [s, ...d]) : d));
			qc.setQueryData<SharedSessionDetail>(qk.sharedDetail(s.id), (d) => (d ? { ...d, shared: s } : d));
			void qc.invalidateQueries({ queryKey: qk.sharedDetail(s.id) });
			void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
			void qc.invalidateQueries({ queryKey: qk.sessionsAll });
		},
	});
}

/** Cancels a pending hand-over, or dismisses a finished one. */
export function useCancelTransfer(sharedId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api.delete<SharedSession>(routes.sharedTransfer(sharedId)),
		onSuccess: (s) => putShared(qc, s),
		onError: (e) => toast.error("Could not cancel the hand-over", { description: errorMessage(e) }),
	});
}

export function useLeaveShared(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api.post<SharedSession>(routes.sharedLeave(id)),
		onSuccess: (s) => {
			afterShareChange(qc, s);
			toast.success("You left the shared session");
		},
		onError: (e) => toast.error("Could not leave", { description: errorMessage(e) }),
	});
}

export interface DecideInviteInput {
	id: string;
	body: { decision: "accept"; projectId?: string; agentId?: string } | { decision: "decline"; reason?: string };
}

export function useDecideInvite() {
	const qc = useQueryClient();
	const navigate = useNavigate();
	return useMutation({
		mutationFn: ({ id, body }: DecideInviteInput) => api.post<SharedInvite>(routes.sharedInviteDecide(id), body),
		onSuccess: (invite, v) => {
			qc.setQueryData<SharedInvite[]>(qk.sharedInvites, (d) => d?.map((x) => (x.id === invite.id ? invite : x)));
			toast.dismiss(`shared-invite-${invite.id}`);
			void qc.invalidateQueries({ queryKey: qk.shared });
			void qc.invalidateQueries({ queryKey: qk.sessionsAll });
			if (v.body.decision === "accept") {
				toast.success("Joined the shared session", { description: "A live view is being set up on this node." });
				void qc.invalidateQueries({ queryKey: qk.sharedInvites });
				void api.get<SharedSession[]>(routes.sharedSessions).then((list) => {
					qc.setQueryData(qk.shared, list);
					const s = list.find((x) => x.id === invite.sharedSessionId);
					if (s?.localSessionId) void navigate({ to: "/sessions/$sessionId", params: { sessionId: s.localSessionId } });
				});
			} else {
				toast.success("Invitation declined");
			}
		},
		onError: (e) => toast.error("Could not answer the invitation", { description: errorMessage(e) }),
	});
}
