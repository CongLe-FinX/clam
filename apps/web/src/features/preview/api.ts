import { type PreviewCheckResult, type PreviewStatus, type PreviewTicket, routes } from "@clam/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { useAccess } from "@/features/auth/hooks";
import { type Msg, msg, t, tr } from "@/i18n";
import { api, errorText } from "@/lib/api";

export const previewKey = ["local", "preview", "status"] as const;

/** Preview status: the preview host, whether it is switched on for remote sessions, and why not. */
export const usePreviewStatus = (enabled = true) =>
	useQuery({ queryKey: previewKey, queryFn: ({ signal }) => api.get<PreviewStatus>(routes.preview, undefined, { signal }), enabled, staleTime: 15_000, retry: false });

/** Settings → Cloudflare Tunnel: save (or, with null, reset) the preview host. Loopback UI only. */
export function useSavePreviewHost() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (host: string | null) => api.put<PreviewStatus>(routes.previewConfig, { host }),
		onSuccess: (status) => qc.setQueryData(previewKey, status),
	});
}

/** Settings → Cloudflare Tunnel: does `https://<preview host>/__clam_preview/health` answer from this machine? */
export const useCheckPreview = () => useMutation({ mutationFn: () => api.post<PreviewCheckResult>(routes.previewCheck) });

const WHY_NOT: Record<"tunnel" | "off", Msg> = {
	tunnel: msg("Preview needs a named tunnel on this machine (Settings → Cloudflare Tunnel)."),
	off: msg("Preview is switched off for remote sign-ins. Turn it on from this machine's local UI (Settings → Security)."),
};

export interface PreviewOpener {
	/** The button may be used: the loopback UI always, a remote session once Preview is on and addressable. */
	canOpen: boolean;
	/** Why not, for the tooltip. */
	why: string | null;
	/** Open `localhost:<port><path>` in the user's own browser (a new tab). Loopback: straight to localhost; remote: through the preview host after a one-time ticket. */
	open: (port: number, path?: string) => void;
	pending: boolean;
}

/**
 * Open a local web app in the user's own browser. A tab is opened synchronously (a click handler may not open one after an await:
 * Safari and most mobile browsers block it) and pointed at the destination once the ticket arrives.
 */
export function usePreviewOpener(): PreviewOpener {
	const access = useAccess();
	const loopback = access.data?.via === "loopback";
	const status = usePreviewStatus(access.data !== undefined && !loopback);
	const ticket = useMutation({ mutationFn: (body: { port: number; path: string }) => api.post<PreviewTicket>(routes.previewTicket, body) });
	const remoteReady = status.data?.available === true && status.data.remoteEnabled;
	const why = loopback || remoteReady || status.data === undefined ? null : tr(status.data.available ? WHY_NOT.off : WHY_NOT.tunnel);
	const open = useCallback(
		(port: number, path = "/") => {
			const tab = window.open("about:blank", "_blank");
			if (tab) tab.opener = null;
			if (loopback) {
				const url = `http://localhost:${port}${path}`;
				if (tab) tab.location.href = url;
				else window.open(url, "_blank", "noopener");
				return;
			}
			ticket.mutate(
				{ port, path },
				{
					onSuccess: ({ url }) => {
						if (tab) tab.location.href = url;
						else window.location.assign(url);
					},
					onError: (error) => {
						tab?.close();
						toast.error(errorText(error) || t("Could not open the preview"));
					},
				},
			);
		},
		[loopback, ticket],
	);
	return { canOpen: access.data !== undefined && (loopback || remoteReady), why, open, pending: ticket.isPending };
}
