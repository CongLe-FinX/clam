import { type AccessStatus, type CreateTerminalBody, type TerminalInfo, type TerminalSession, routes } from "@clam/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessKey } from "@/features/auth/hooks";
import { api } from "@/lib/api";

export const terminalKeys = {
	info: ["local", "terminal", "info"] as const,
	sessions: ["local", "terminal", "sessions"] as const,
};

/** `enabled` is false while the tool is switched off for this (remote) connection: those routes answer 403. */
export const useTerminalInfo = (enabled = true) =>
	useQuery({ queryKey: terminalKeys.info, queryFn: ({ signal }) => api.get<TerminalInfo>(routes.terminalInfo, undefined, { signal }), enabled, staleTime: 60_000 });

export const useTerminalSessions = (enabled = true) =>
	useQuery({
		queryKey: terminalKeys.sessions,
		queryFn: ({ signal }) => api.get<TerminalSession[]>(routes.terminalSessions, undefined, { signal }),
		enabled,
		// Shells end and other browsers open or close terminals: a light poll keeps tabs honest while the page is visible.
		refetchInterval: 5_000,
		refetchIntervalInBackground: false,
	});

/** Patch one session in the cached list (live `session` frames from the socket). */
export function upsertSession(qc: QueryClient, session: TerminalSession): void {
	qc.setQueryData<TerminalSession[]>(terminalKeys.sessions, (list) => (list ? (list.some((s) => s.id === session.id) ? list.map((s) => (s.id === session.id ? session : s)) : [...list, session]) : [session]));
}

export function useCreateTerminal() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: CreateTerminalBody) => api.post<TerminalSession>(routes.terminalSessions, body),
		onSuccess: (session) => {
			upsertSession(qc, session);
			void qc.invalidateQueries({ queryKey: terminalKeys.info });
		},
	});
}

export function useRenameTerminal() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, title }: { id: string; title: string }) => api.patch<TerminalSession>(routes.terminalSession(id), { title }),
		onSuccess: (session) => upsertSession(qc, session),
	});
}

export function useKillTerminal() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.delete(routes.terminalSession(id)),
		onSuccess: (_void, id) => {
			qc.setQueryData<TerminalSession[]>(terminalKeys.sessions, (list) => list?.filter((s) => s.id !== id));
			void qc.invalidateQueries({ queryKey: terminalKeys.info });
		},
	});
}

/** Password re-entry on a remote session: unlocks opening/attaching terminals for a few minutes. */
export function useStepUp() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (password: string) => api.post<AccessStatus>(routes.accessStepUp, { password }),
		onSuccess: (status) => qc.setQueryData(accessKey, status),
	});
}

/** Switch the remote Terminal on from a signed-in remote session (needs the password in the same request). */
export function useEnableRemoteTerminal() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (password: string) => api.patch<AccessStatus>(routes.access, { remoteTerminalEnabled: true, password }),
		onSuccess: (status) => qc.setQueryData(accessKey, status),
	});
}

/** Is a remote session currently elevated (recent password re-entry)? Loopback never needs it. */
export const isElevated = (a: AccessStatus | undefined): boolean => a?.via === "loopback" || (a?.elevatedUntil != null && Date.parse(a.elevatedUntil) > Date.now());
