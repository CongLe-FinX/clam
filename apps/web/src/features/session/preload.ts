import type { AgentSession, MessagesPage, SessionOutputsPage } from "@clam/contracts";
import { routes } from "@clam/contracts";
import type { QueryClient } from "@tanstack/react-query";
import type { PointerEvent } from "react";
import { api } from "@/lib/api";
import { qk } from "@/lib/queries";

/** Messages per history page (initial load, resync and older pages). */
export const PAGE_SIZE = 60;

const PRELOAD_TTL = 10_000;
const MAX_PRELOADS = 8;

interface Preloaded {
	at: number;
	page: Promise<MessagesPage>;
	outputs: Promise<SessionOutputsPage>;
}
const preloaded = new Map<string, Preloaded>();

/**
 * Start fetching a session's first page of messages and turn outputs (and its record) when the user is about to open it
 * (hover / focus / touch on a list row), so the conversation paints without a request round trip. Tiny on purpose: it is
 * imported by list rows that live in the initial bundle, not by the session page chunk.
 */
export function preloadSession(qc: QueryClient, id: string): void {
	const now = Date.now();
	const hit = preloaded.get(id);
	if (hit && now - hit.at < PRELOAD_TTL / 2) return;
	for (const [k, v] of preloaded) if (now - v.at >= PRELOAD_TTL) preloaded.delete(k);
	while (preloaded.size >= MAX_PRELOADS) {
		const oldest = preloaded.keys().next();
		if (oldest.done) break;
		preloaded.delete(oldest.value);
	}
	const page = api.get<MessagesPage>(routes.sessionMessages(id), { limit: PAGE_SIZE });
	const outputs = api.get<SessionOutputsPage>(routes.sessionOutputs(id));
	// The consumer (the session stream) handles failures; these only keep an unused preload from being an unhandled rejection.
	page.catch(() => undefined);
	outputs.catch(() => undefined);
	preloaded.set(id, { at: now, page, outputs });
	void qc.prefetchQuery({ queryKey: qk.session(id), queryFn: ({ signal }) => api.get<AgentSession>(routes.session(id), undefined, { signal }) });
}

/** The preloaded first page for `id` if one is fresh; each preload is handed out once. */
export function takePreloaded(id: string): Pick<Preloaded, "page" | "outputs"> | null {
	const hit = preloaded.get(id);
	preloaded.delete(id);
	return hit && Date.now() - hit.at < PRELOAD_TTL ? hit : null;
}

const hoverTimers = new Map<string, number>();

/**
 * Link props that preload a session when the user is about to open it: mouse hover (after a short delay so sweeping across a long
 * list does not fire a request per row), keyboard focus, and pointer/touch down (≈100 ms before the click or navigation).
 */
export function warmHandlers(
	qc: QueryClient,
	id: string,
	status: string,
): {
	onPointerEnter: (e: PointerEvent<HTMLElement>) => void;
	onPointerLeave: () => void;
	onPointerDown: () => void;
	onFocus: () => void;
} {
	const warm = (): void => preloadSession(qc, id);
	// Reading a transcript starts the session's agent process: a stopped session is only warmed when the user commits (pointer down), never by hovering or tabbing past it.
	const speculative = status !== "stopped";
	return {
		onPointerEnter: (e) => {
			if (e.pointerType !== "mouse" || !speculative) return;
			window.clearTimeout(hoverTimers.get(id));
			hoverTimers.set(id, window.setTimeout(warm, 90));
		},
		onPointerLeave: () => window.clearTimeout(hoverTimers.get(id)),
		onPointerDown: warm,
		onFocus: () => {
			if (speculative) warm();
		},
	};
}
