import type { DataSource } from "@clam/contracts";
import { msg, tr, type Msg } from "@/i18n";
import { Badge } from "@/ui/badge";
import { Tip } from "@/ui/tooltip";

const META: Record<DataSource, { label: Msg; variant: "accent" | "success" | "warning"; hint: Msg }> = {
	"omp-recorded": {
		label: msg("OMP recorded"),
		variant: "accent",
		hint: msg("Actual requests logged by OMP on this machine (omp stats). Cost uses OMP's model price table."),
	},
	"provider-reported": {
		label: msg("Provider reported"),
		variant: "success",
		hint: msg("Quota and limits returned by the provider's own usage API through OMP (omp usage)."),
	},
	"clam-estimated": {
		label: msg("Estimated"),
		variant: "warning",
		hint: msg("Derived by CL Agent Mesh from per-session OMP statistics; not authoritative."),
	},
};

export function SourceBadge({ source }: { source: DataSource }) {
	const m = META[source];
	return (
		<Tip label={tr(m.hint)}>
			<Badge variant={m.variant} className="cursor-help whitespace-nowrap">
				{tr(m.label)}
			</Badge>
		</Tip>
	);
}
