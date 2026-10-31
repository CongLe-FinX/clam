import { type AccessStatus, routes } from "@clam/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "@/lib/api";

export const accessKey = ["local", "access"] as const;

/** `/access` answers without a session, so this works on the login page too. */
export const useAccess = (opts?: { fresh?: boolean }) =>
	useQuery({
		queryKey: accessKey,
		queryFn: ({ signal }) => api.get<AccessStatus>(routes.access, undefined, { signal }),
		staleTime: opts?.fresh ? 0 : 30_000,
		// The login page must never trust a status cached while the session was still valid.
		refetchOnMount: opts?.fresh ? "always" : true,
	});

/** Drop every cached owner-data query (keeps the access status): used on login and sign-out. */
export function useDropOwnerData() {
	const qc = useQueryClient();
	return useCallback(() => {
		qc.removeQueries({ predicate: (q) => q.queryKey[0] === "local" && q.queryKey[1] !== "access" });
	}, [qc]);
}
