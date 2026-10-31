import { CAPABILITIES, type Capability } from "@clam/contracts";
import { useId } from "react";
import { cn } from "@/lib/utils";

export const CAPABILITY_INFO: Record<Capability, { label: string; description: string }> = {
	"agents.read": { label: "See agents", description: "The peer can list this node's agents and whether they are busy." },
	"events.read": { label: "Follow live events", description: "The peer receives live status changes (agents, health) from this node." },
	"tasks.send": { label: "Send tasks", description: "The peer can submit work to agents on this node. This node still decides whether to run it." },
	"tasks.receive": { label: "Receive tasks and results", description: "This node can delegate tasks to the peer and the peer reports progress and results back." },
	"tasks.cancel": { label: "Cancel tasks", description: "The peer can cancel tasks it submitted here." },
	"context.sync": { label: "Sync shared context", description: "Exchange shared workspace notes and decisions with the peer." },
	"artifacts.read": { label: "Read artifacts", description: "The peer can download files that agents here produced for it." },
	"artifacts.write": { label: "Write artifacts", description: "The peer can upload files into tasks it runs on this node." },
	"handoff.send": { label: "Hand sessions over", description: "The peer can transfer a whole agent session to this node." },
	"handoff.receive": { label: "Accept session handoffs", description: "This node can transfer an agent session to the peer." },
	"sessions.share": { label: "Share sessions", description: "The peer can invite this node into shared sessions (live mirror, shared discussion, checkpoints, takeover). Granted per direction; not part of the default set." },
};

export function CapabilityChecklist({
	value,
	onChange,
	disabled,
	className,
}: {
	value: readonly Capability[];
	onChange: (next: Capability[]) => void;
	disabled?: boolean;
	className?: string;
}) {
	const group = useId();
	const set = new Set(value);
	return (
		<ul className={cn("flex flex-col divide-y rounded-xl shadow-[inset_0_0_0_1px_var(--border)]", className)} aria-label="Capabilities">
			{CAPABILITIES.map((cap) => {
				const info = CAPABILITY_INFO[cap];
				const id = `${group}-${cap}`;
				return (
					<li key={cap}>
						<label htmlFor={id} className={cn("flex min-h-11 cursor-pointer items-start gap-3 px-3 py-2.5", disabled && "cursor-not-allowed opacity-60")}>
							<input
								id={id}
								type="checkbox"
								checked={set.has(cap)}
								disabled={disabled}
								onChange={(e) => onChange(CAPABILITIES.filter((c) => (c === cap ? e.target.checked : set.has(c))))}
								className="mt-0.5 size-4 shrink-0 accent-[var(--accent)] coarse:size-5"
							/>
							<span className="flex min-w-0 flex-col gap-0.5">
								<span className="text-[13px] font-medium">
									{info.label} <span className="ml-1 font-mono text-2xs font-normal text-subtle">{cap}</span>
								</span>
								<span className="text-xs text-muted-foreground">{info.description}</span>
							</span>
						</label>
					</li>
				);
			})}
		</ul>
	);
}

/** Read-only chips for a granted/received set. */
export function CapabilityChips({ value, empty = "None" }: { value: readonly Capability[]; empty?: string }) {
	if (value.length === 0) return <span className="text-[13px] text-subtle">{empty}</span>;
	return (
		<div className="flex flex-wrap gap-1.5">
			{value.map((c) => (
				<span key={c} title={CAPABILITY_INFO[c]?.description} className="rounded-md bg-surface-3 px-1.5 py-1 font-mono text-2xs text-muted-foreground">
					{c}
				</span>
			))}
		</div>
	);
}
