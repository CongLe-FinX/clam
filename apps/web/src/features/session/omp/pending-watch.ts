import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { t } from "@/i18n";
import { ws } from "@/lib/ws";

/** Sessions currently waiting on a human, by id (drives the tab title). */
type Pending = Map<string, number>;

function viewing(pathname: string, sessionId: string): boolean {
	return pathname.endsWith(`/sessions/${sessionId}`) || pathname.includes(`/sessions/${sessionId}/`);
}

/**
 * Mounted once in the app shell. When an agent starts waiting for an answer or an approval (`AgentSession.pendingRequests`
 * goes up) and the person is not looking at that session, say so: a toast with a way in, a browser notification when the tab
 * is in the background and notifications are allowed, and a count in the tab title either way.
 */
export function usePendingWatch(): void {
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const route = useRef({ pathname, navigate });
	route.current = { pathname, navigate };

	useEffect(() => {
		const known: Pending = new Map();
		const baseTitle = document.title.replace(/^\(\d+\)\s+/, "");
		const syncTitle = (): void => {
			const waiting = [...known.values()].filter((n) => n > 0).length;
			const current = document.title.replace(/^\(\d+\)\s+/, "");
			document.title = document.hidden && waiting > 0 ? `(${waiting}) ${current}` : current;
		};
		const off = ws.subscribe("sessions", (e) => {
			if (e.type === "remove") {
				known.delete(e.sessionId);
				syncTitle();
				return;
			}
			if (e.type !== "upsert") return;
			const { id, title } = e.session;
			const now = e.session.pendingRequests ?? 0;
			const before = known.get(id) ?? 0;
			known.set(id, now);
			syncTitle();
			if (now <= before) return;
			const here = viewing(route.current.pathname, id) && !document.hidden;
			if (here) return;
			const name = title || t("A session");
			toast.warning(t("{name} needs your answer", { name }), { id: `pending:${id}`, duration: 12_000, action: { label: t("Open"), onClick: () => void route.current.navigate({ to: "/sessions/$sessionId", params: { sessionId: id } }) } });
			if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
				const note = new Notification(t("{name} needs you", { name }), { body: t("The agent is waiting for an answer or an approval."), tag: `clam-pending:${id}` });
				note.onclick = () => {
					window.focus();
					void route.current.navigate({ to: "/sessions/$sessionId", params: { sessionId: id } });
					note.close();
				};
			}
		});
		const onVisibility = (): void => {
			if (!document.hidden) document.title = document.title.replace(/^\(\d+\)\s+/, "") || baseTitle;
			else syncTitle();
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			off();
			document.removeEventListener("visibilitychange", onVisibility);
			document.title = document.title.replace(/^\(\d+\)\s+/, "");
		};
	}, []);
}

/** Ask the browser for permission to notify (call from a user gesture). */
export async function enablePendingNotifications(): Promise<NotificationPermission | "unsupported"> {
	if (typeof Notification === "undefined") return "unsupported";
	if (Notification.permission !== "default") return Notification.permission;
	return Notification.requestPermission();
}
