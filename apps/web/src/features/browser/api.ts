import { type BrowserStatus, type BrowserTab, type ListeningPort, routes } from "@clam/contracts";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";

export const bk = {
	all: ["local", "browser"] as const,
	status: ["local", "browser", "status"] as const,
	tabs: ["local", "browser", "tabs"] as const,
	ports: ["local", "browser", "ports"] as const,
};

/** The Browser is switched off for remote access (403 `tool_disabled` on the public origin). */
export const isToolDisabled = (e: unknown): boolean => e instanceof ApiError && e.status === 403 && e.code === "tool_disabled";

/** Status of the machine's browser; polls every second while it installs or starts. */
export const useBrowserStatus = () =>
	useQuery({
		queryKey: bk.status,
		queryFn: ({ signal }) => api.get<BrowserStatus>(routes.browser, undefined, { signal }),
		retry: false,
		refetchInterval: (q) => (q.state.data?.install.state === "running" || q.state.data?.state === "starting" ? 1000 : false),
	});

export const useBrowserTabs = (enabled: boolean) =>
	useQuery({
		queryKey: bk.tabs,
		queryFn: ({ signal }) => api.get<BrowserTab[]>(routes.browserTabs, undefined, { signal }),
		enabled,
		retry: false,
		staleTime: 5_000,
	});

/** TCP listeners on this machine; refetched every 4 s while the page is open (react-query pauses it while the tab is hidden). */
export const useListeningPorts = (enabled: boolean) =>
	useQuery({
		queryKey: bk.ports,
		queryFn: ({ signal }) => api.get<ListeningPort[]>(routes.browserPorts, undefined, { signal }),
		enabled,
		retry: false,
		refetchInterval: 4_000,
		refetchIntervalInBackground: false,
	});
