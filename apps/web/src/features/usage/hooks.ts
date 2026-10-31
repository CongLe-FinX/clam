import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { routes, type MeshUsage, type QuotaReport, type RecordedUsage } from "@clam/contracts";
import { api } from "@/lib/api";
import { qk } from "@/lib/queries";

export function useRecordedUsage() {
	return useQuery({
		queryKey: qk.usageRecorded,
		queryFn: ({ signal }) => api.get<RecordedUsage>(routes.usageRecorded, undefined, { signal }),
		// The server serves a stale snapshot while it recomputes (`omp stats` is slow when cold); poll until fresh.
		refetchInterval: (q) => (q.state.data?.stale ? 4000 : false),
		staleTime: 60_000,
	});
}

export function useQuotaReport() {
	return useQuery({
		queryKey: qk.usageQuota,
		queryFn: ({ signal }) => api.get<QuotaReport>(routes.usageQuota, undefined, { signal }),
		refetchInterval: (q) => (q.state.data?.stale ? 4000 : false),
		staleTime: 60_000,
	});
}

export function useMeshUsage() {
	return useQuery({
		queryKey: qk.usageMesh,
		queryFn: ({ signal }) => api.get<MeshUsage>(routes.usageMesh, undefined, { signal }),
		staleTime: 30_000,
	});
}

/** Forces `?refresh=1` on both OMP-backed sources and writes the fresh results into the cache. */
export function useRefreshUsage() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async () => {
			const [recorded, quota, mesh] = await Promise.all([
				api.get<RecordedUsage>(routes.usageRecorded, { refresh: "1" }),
				api.get<QuotaReport>(routes.usageQuota, { refresh: "1" }),
				api.get<MeshUsage>(routes.usageMesh),
			]);
			qc.setQueryData(qk.usageRecorded, recorded);
			qc.setQueryData(qk.usageQuota, quota);
			qc.setQueryData(qk.usageMesh, mesh);
		},
	});
}
