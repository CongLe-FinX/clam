import type { DataSource } from "@clam/contracts";
import { Badge } from "@/ui/badge";
import { Tip } from "@/ui/tooltip";

const META: Record<DataSource, { label: string; variant: "accent" | "success" | "warning"; hint: string }> = {
	"omp-recorded": {
		label: "OMP recorded",
		variant: "accent",
		hint: "Actual requests logged by OMP on this machine (omp stats). Cost uses OMP's model price table.",
	},
	"provider-reported": {
		label: "Provider reported",
		variant: "success",
		hint: "Quota and limits returned by the provider's own usage API through OMP (omp usage).",
	},
	"clam-estimated": {
		label: "Estimated",
		variant: "warning",
		hint: "Derived by CL Agent Mesh from per-session OMP statistics; not authoritative.",
	},
};

export function SourceBadge({ source }: { source: DataSource }) {
	const m = META[source];
	return (
		<Tip label={m.hint}>
			<Badge variant={m.variant} className="cursor-help whitespace-nowrap">
				{m.label}
			</Badge>
		</Tip>
	);
}
