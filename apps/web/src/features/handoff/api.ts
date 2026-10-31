import { type Handoff, type HandoffDetail, type HandoffEvent, type HandoffState, type HandoffTopicEvent, routes } from "@clam/contracts";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useTopic } from "@/lib/ws";

/**
 * Data layer for the Handoff Center. Kept free of UI so the app shell (nav badge) and the realtime bridge can import it without
 * pulling the lazy Handoff Center chunk into the initial bundle.
 */

export const hk = {
	all: ["local", "handoffs"] as const,
	detail: (id: string) => ["local", "handoff", id] as const,
};

/** States after which nothing more happens (a failed handoff stays "active" while it still offers a retry). */
const FINISHED: Record<string, true> = { completed: true, rejected: true, expired: true, cancelled: true, reclaimed: true, failed: true, released: true };

export const isActiveHandoff = (h: Handoff): boolean => !FINISHED[h.state] || h.actions.includes("retry");

export const useHandoffs = () =>
	useQuery({
		queryKey: hk.all,
		queryFn: ({ signal }) => api.get<Handoff[]>(routes.handoffs, undefined, { signal }),
		staleTime: 30_000,
	});

/** Handoffs that are still moving or waiting for the user: drives the nav badge. */
export function useActiveHandoffCount(): number {
	return (useHandoffs().data ?? []).filter(isActiveHandoff).length;
}

export function upsertHandoff(list: Handoff[] | undefined, h: Handoff): Handoff[] | undefined {
	if (!list) return list;
	return list.some((x) => x.id === h.id) ? list.map((x) => (x.id === h.id ? h : x)) : [h, ...list];
}

export function upsertEvent(list: HandoffEvent[], e: HandoffEvent): HandoffEvent[] {
	const i = list.findIndex((x) => x.seq === e.seq);
	if (i < 0) return [...list, e].sort((a, b) => a.seq - b.seq);
	return list.map((x, j) => (j === i ? e : x));
}

/** Writes a handoff record into the list cache and any open detail cache. */
export function putHandoff(qc: QueryClient, h: Handoff): void {
	qc.setQueryData<Handoff[]>(hk.all, (d) => upsertHandoff(d, h));
	qc.setQueryData<HandoffDetail>(hk.detail(h.id), (d) => (d ? { ...d, handoff: h } : d));
}

export function applyTopicEvent(qc: QueryClient, e: HandoffTopicEvent): void {
	if (e.type === "handoff") putHandoff(qc, e.handoff);
	else qc.setQueryData<HandoffDetail>(hk.detail(e.handoffId), (d) => (d ? { ...d, events: upsertEvent(d.events, e.event) } : d));
}

export function useHandoff(id: string) {
	return useQuery({
		queryKey: hk.detail(id),
		queryFn: ({ signal }) => api.get<HandoffDetail>(routes.handoff(id), undefined, { signal }),
		// The topic is the fast path; this keeps an open handoff honest if a frame was lost.
		refetchInterval: (q) => (q.state.data && isActiveHandoff(q.state.data.handoff) ? 15_000 : false),
	});
}

/** Keeps one open handoff (state, steps, setup output, events) current from `handoff:<id>`. */
export function useHandoffLive(id: string): void {
	const qc = useQueryClient();
	useTopic(`handoff:${id}`, (e) => applyTopicEvent(qc, e as HandoffTopicEvent), { onResync: () => void qc.invalidateQueries({ queryKey: hk.detail(id) }) });
}

export type { HandoffState };
