import { type Checkpoint, type FilesApplyResult, type FilesPreview, type SharedInvite, type SharedMessage, type SharedMessagesPage, type SharedSession, type SharedSessionDetail, type SharedTopicEvent, type TransferBody, routes } from "@clam/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { t } from "@/i18n";
import { api, errorText } from "@/lib/api";
import { qk, usePeers } from "@/lib/queries";
import { useTopic } from "@/lib/ws";

/** Web UI base URL of a machine: what it published, else the address this machine reaches it on (its domain serves the UI once remote access is on). */
export function useNodeUiUrl(nodeId: string, published: string | null): string | null {
	const peers = usePeers().data;
	return published ?? peers?.find((p) => p.id === nodeId)?.url ?? null;
}

/** The group log is replicated on every member machine: its order is (hlc, originNodeId, id), never the local clock. */
const compareMessages = (a: SharedMessage, b: SharedMessage): number =>
	a.hlc !== b.hlc ? (a.hlc < b.hlc ? -1 : 1) : a.originNodeId !== b.originNodeId ? (a.originNodeId < b.originNodeId ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Inserts or replaces one message in the loaded window of the log (kept sorted and deduped by id). Appends — the common case — cost one
 * comparison. A message that sorts before the loaded window while older pages remain is skipped: it arrives with its page.
 */
function putMessage(d: SharedSessionDetail, m: SharedMessage): SharedSessionDetail {
	const list = d.messages;
	for (let i = list.length - 1; i >= 0; i--) {
		const x = list[i];
		if (x?.id !== m.id) continue;
		if (x === m) return d;
		const next = list.slice();
		next[i] = m;
		return { ...d, messages: next };
	}
	let at = list.length;
	while (at > 0 && compareMessages(list[at - 1] as SharedMessage, m) > 0) at--;
	if (at === 0 && list.length > 0 && d.messagesCursor) return d;
	return { ...d, messages: [...list.slice(0, at), m, ...list.slice(at)] };
}

/** Messages fetched with the detail (the newest ones) and per older page. */
const INITIAL_MESSAGES = 80;
const PAGE_MESSAGES = 60;

/**
 * A refetched detail carries only the newest window of the log. Keep what the cache holds beyond it — older pages already loaded and
 * messages that arrived over the topic while the request was in flight — so a refresh never throws the loaded history away.
 */
function mergeDetail(prev: SharedSessionDetail | undefined, fresh: SharedSessionDetail): SharedSessionDetail {
	const f = fresh.messages;
	const p = prev?.messages;
	const first = f[0];
	const last = f[f.length - 1];
	if (!prev || !p || p.length === 0 || !first || !last || !fresh.messagesCursor) return fresh;
	// The cache must reach into the fresh window, else history between them is unknown: start over from the fresh window.
	if (compareMessages(p[p.length - 1] as SharedMessage, first) < 0) return fresh;
	let older = 0;
	while (older < p.length && compareMessages(p[older] as SharedMessage, first) < 0) older++;
	let tail = p.length;
	while (tail > older && compareMessages(p[tail - 1] as SharedMessage, last) > 0) tail--;
	return {
		...fresh,
		messages: older === 0 && tail === p.length ? f : [...p.slice(0, older), ...f, ...p.slice(tail)],
		messagesCursor: older > 0 ? (prev.messagesCursor ?? null) : fresh.messagesCursor,
	};
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
			qc.setQueryData<SharedSessionDetail>(qk.sharedDetail(e.sharedSessionId), (d) => (d ? putMessage(d, e.message) : d));
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
	const qc = useQueryClient();
	return useQuery({
		queryKey: qk.sharedDetail(id ?? ""),
		queryFn: async ({ signal }) => {
			const fresh = await api.get<SharedSessionDetail>(routes.sharedSession(id ?? ""), { messageLimit: INITIAL_MESSAGES }, { signal });
			return mergeDetail(qc.getQueryData<SharedSessionDetail>(qk.sharedDetail(id ?? "")), fresh);
		},
		enabled: id !== null,
		// The topic is the fast path; polling covers a lost frame and outbox delivery flips (no event when a message is delivered).
		// Only the newest window is refetched, so only it is inspected.
		refetchInterval: (q) => {
			const d = q.state.data;
			if (!d) return false;
			const recent = d.messages.slice(-INITIAL_MESSAGES);
			if (recent.some((m) => m.delivery === "pending")) return 2_500;
			// An attachment still being fetched from a member machine flips to available without any event.
			return recent.some((m) => m.attachments.some((a) => !a.available)) ? 4_000 : 20_000;
		},
	});
}

export interface SharedHistory {
	/** Older messages exist on the server. */
	hasOlder: boolean;
	loading: boolean;
	failed: boolean;
	/** Fetches the next older page into the detail cache (no-op while loading or when the log start is reached). */
	loadOlder: () => void;
}

/** Pages the group log backwards into the detail cache; the page boundary is `SharedSessionDetail.messagesCursor`. */
export function useSharedHistory(id: string, cursor: string | null | undefined): SharedHistory {
	const qc = useQueryClient();
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);
	const busy = useRef(false);
	const loadOlder = useCallback(() => {
		const before = qc.getQueryData<SharedSessionDetail>(qk.sharedDetail(id))?.messagesCursor;
		if (!before || busy.current) return;
		busy.current = true;
		setLoading(true);
		setFailed(false);
		api.get<SharedMessagesPage>(routes.sharedMessages(id), { before, limit: PAGE_MESSAGES })
			.then((page) =>
				qc.setQueryData<SharedSessionDetail>(qk.sharedDetail(id), (d) => {
					// A refresh that moved the cursor in the meantime makes this page stale.
					if (!d || d.messagesCursor !== before) return d;
					const known = new Set(d.messages.map((m) => m.id));
					return { ...d, messages: [...page.messages.filter((m) => !known.has(m.id)), ...d.messages], messagesCursor: page.nextCursor };
				}),
			)
			.catch(() => setFailed(true))
			.finally(() => {
				busy.current = false;
				setLoading(false);
			});
	}, [qc, id]);
	return { hasOlder: Boolean(cursor), loading, failed, loadOlder };
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
			toast.success(t("Removed from the team"));
		},
		onError: (e) => toast.error(t("Could not remove the participant"), { description: errorText(e) }),
	});
}

export function usePostSharedMessage(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: { text: string; kind?: "chat" | "instruction" | "answer" | "note"; attachmentIds?: string[]; to?: { mode: "all" | "lead" | "agents"; agents: Array<{ nodeId: string; agentId: string }> } }) => api.post<SharedMessage>(routes.sharedMessages(id), body),
		onSuccess: (m) => qc.setQueryData<SharedSessionDetail>(qk.sharedDetail(id), (d) => (d ? putMessage(d, m) : d)),
		onError: (e) => toast.error(t("Could not send the message"), { description: errorText(e) }),
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
			toast.success(t("Checkpoint {seq} saved", { seq: c.seq }), { description: c.pushed ? t("Pushed to the shared branch.") : c.commit ? t("Committed locally; the push was refused or is pending.") : t("No file changes; the session snapshot was shipped.") });
		},
		onError: (e) => toast.error(t("Could not take a checkpoint"), { description: errorText(e) }),
	});
}

/** Participant: continue the work on this machine. Navigates to the new local session. */
export function useTakeover(id: string) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	return useMutation({
		mutationFn: (force: boolean) => api.post<SharedSession>(routes.sharedTakeover(id), { force }),
		onSuccess: (s) => {
			afterShareChange(qc, s);
			void qc.invalidateQueries({ queryKey: qk.sharedDetail(s.id) });
			toast.success(t("This machine is now driving the session"));
			if (s.localSessionId) void navigate({ to: "/sessions/$sessionId", params: { sessionId: s.localSessionId } });
		},
	});
}

/**
 * Driver: hand the work over to another machine — shares the session first when needed, invites the machine, then runs the hand-over in the
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
		onError: (e) => toast.error(t("Could not cancel the hand-over"), { description: errorText(e) }),
	});
}

export function useLeaveShared(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api.post<SharedSession>(routes.sharedLeave(id)),
		onSuccess: (s) => {
			afterShareChange(qc, s);
			toast.success(t("You left the shared session"));
		},
		onError: (e) => toast.error(t("Could not leave"), { description: errorText(e) }),
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
				toast.success(t("Joined the shared session"), { description: t("A live view is being set up on this machine.") });
				void qc.invalidateQueries({ queryKey: qk.sharedInvites });
				void api.get<SharedSession[]>(routes.sharedSessions).then((list) => {
					qc.setQueryData(qk.shared, list);
					const s = list.find((x) => x.id === invite.sharedSessionId);
					if (s?.localSessionId) void navigate({ to: "/sessions/$sessionId", params: { sessionId: s.localSessionId } });
				});
			} else {
				toast.success(t("Invitation declined"));
			}
		},
		onError: (e) => toast.error(t("Could not answer the invitation"), { description: errorText(e) }),
	});
}

export interface ApplyRescueInput {
	projectId: string;
	paths?: string[];
	overwrite: string[];
}

/** Files mode: the saved work of this machine after the last checkpoint, compared with a local project. */
export function useRescuePreview(id: string, projectId: string) {
	return useQuery({
		queryKey: [...qk.sharedDetail(id), "rescue-preview", projectId] as const,
		queryFn: ({ signal }) => api.get<FilesPreview>(routes.sharedRescuePreview(id), { projectId }, { signal }),
		enabled: projectId !== "",
		staleTime: 0,
		gcTime: 0,
	});
}

export function useRescueApply(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: ApplyRescueInput) => api.post<FilesApplyResult>(routes.sharedRescueApply(id), body),
		onSuccess: (r) => {
			void qc.invalidateQueries({ queryKey: qk.projectsAll });
			toast.success(t("{count, plural, one {# file written} other {# files written}}", { count: r.written.length }));
		},
	});
}
