import { createContext, useContext } from "react";
import type { AssetResolver } from "@/components/rich/assets";

/**
 * Per-session facts the conversation rows need. The value is memoized by the page, so memoized rows never re-render for it;
 * `openFile` is a stable callback (it opens a project file in the Files panel).
 */
export interface SessionEnv {
	projectId: string;
	/** Resolves relative markdown paths (`![chart](out/chart.png)`) against the project folder. Stable per project. */
	assets: AssetResolver;
	openFile: (path: string) => void;
	agentName: string;
}

export const SessionEnvContext = createContext<SessionEnv | null>(null);

export function useSessionEnv(): SessionEnv {
	const env = useContext(SessionEnvContext);
	if (!env) throw new Error("useSessionEnv must be used inside a session workspace");
	return env;
}
