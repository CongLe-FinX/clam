import { CAPABILITIES, type Capability } from "@clam/contracts";
import { Check, ChevronDown, Minus } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";

export const CAPABILITY_INFO: Record<Capability, { label: string; description: string }> = {
	"agents.read": { label: "See agents", description: "The peer can list this machine's agents and whether they are busy." },
	"events.read": { label: "Follow live events", description: "The peer receives live status changes (agents, health) from this machine." },
	"tasks.send": { label: "Send tasks", description: "The peer can submit work to agents on this machine. This machine still decides whether to run it." },
	"tasks.receive": { label: "Receive tasks and results", description: "This machine can delegate tasks to the peer and the peer reports progress and results back." },
	"tasks.cancel": { label: "Cancel tasks", description: "The peer can cancel tasks it submitted here." },
	"context.sync": { label: "Sync shared context", description: "Exchange shared workspace notes and decisions with the peer." },
	"artifacts.read": { label: "Read artifacts", description: "The peer can download files that agents here produced for it." },
	"artifacts.write": { label: "Write artifacts", description: "The peer can upload files into tasks it runs on this machine." },
	"handoff.send": { label: "Hand sessions over", description: "The peer can transfer a whole agent session to this machine." },
	"handoff.receive": { label: "Accept session handoffs", description: "This machine can transfer an agent session to the peer." },
	"sessions.share": { label: "Share sessions", description: "The peer can invite this machine into shared sessions (live mirror, shared discussion, checkpoints, takeover). Granted per direction; not part of the default set." },
};

/** Plain-language bundles of the raw capabilities. Every capability belongs to at least one preset. */
export const CAPABILITY_PRESETS: { id: string; title: string; description: string; caps: readonly Capability[] }[] = [
	{ id: "chat", title: "Chat & collaborate", description: "See each other's agents, follow live status and join shared sessions and group chats.", caps: ["agents.read", "events.read", "sessions.share"] },
	{ id: "delegate", title: "Delegate tasks", description: "Send work to each other's agents, report results back, and exchange the files they produce.", caps: ["tasks.send", "tasks.receive", "tasks.cancel", "artifacts.read", "artifacts.write"] },
	{ id: "memory", title: "Share memory", description: "Keep shared workspace notes and decisions in sync.", caps: ["context.sync"] },
	{ id: "handoff", title: "Hand off work", description: "Move a whole agent session from one machine to the other.", caps: ["handoff.send", "handoff.receive"] },
];

/** Sentence-style summary of what a set grants ("Chat & collaborate, Delegate tasks +2 more"). */
export function summarizeCapabilities(value: readonly Capability[]): string {
	if (value.length === 0) return "No access";
	const set = new Set(value);
	if (CAPABILITIES.every((c) => set.has(c))) return "Full trust";
	const parts = CAPABILITY_PRESETS.flatMap((p) => {
		const t = triOf(set, p.caps);
		return t === "all" ? [p.title] : t === "some" ? [`${p.title} (partly)`] : [];
	});
	return parts.join(", ");
}

type Tri = "all" | "some" | "none";
const triOf = (set: ReadonlySet<Capability>, caps: readonly Capability[]): Tri => {
	const n = caps.filter((c) => set.has(c)).length;
	return n === 0 ? "none" : n === caps.length ? "all" : "some";
};

function Box({ state }: { state: Tri }) {
	return (
		<span
			aria-hidden
			className={cn(
				"mt-0.5 grid size-5 shrink-0 place-items-center rounded-md transition-[background-color,box-shadow] coarse:size-6",
				state === "none" ? "bg-surface-1 shadow-[inset_0_0_0_1.5px_var(--border-strong)]" : "bg-accent text-accent-foreground",
			)}
		>
			{state === "all" ? <Check className="size-3.5" strokeWidth={3} /> : state === "some" ? <Minus className="size-3.5" strokeWidth={3} /> : null}
		</span>
	);
}

/**
 * What the OTHER machine may do on THIS one. Plain-language presets on top; the raw capability checklist sits underneath
 * as secondary detail ("Fine-tune").
 */
export function CapabilityChecklist({
	value,
	onChange,
	disabled,
	className,
	peerName = "The other machine",
}: {
	value: readonly Capability[];
	onChange: (next: Capability[]) => void;
	disabled?: boolean;
	className?: string;
	peerName?: string;
}) {
	const group = useId();
	const [open, setOpen] = useState(false);
	const set = new Set(value);
	const all = triOf(set, CAPABILITIES);
	const apply = (caps: readonly Capability[], on: boolean) => {
		const next = new Set(value);
		for (const c of caps) on ? next.add(c) : next.delete(c);
		onChange(CAPABILITIES.filter((c) => next.has(c)));
	};
	const rows = [
		...CAPABILITY_PRESETS.map((p) => ({ id: p.id, title: p.title, description: p.description, caps: p.caps })),
		{ id: "full", title: "Full trust", description: "Everything above, including anything added in future versions. Only for machines you own.", caps: CAPABILITIES as readonly Capability[] },
	];
	return (
		<div className={cn("flex flex-col gap-2.5", className)}>
			<p className="text-xs text-muted-foreground">
				<strong className="font-medium text-foreground">{peerName}</strong> may do this <strong className="font-medium text-foreground">on this machine</strong>. What this machine may do on the other one is decided by its owner.
			</p>
			<ul className="grid gap-2 sm:grid-cols-2" aria-label="Access presets">
				{rows.map((r) => {
					const state = r.id === "full" ? all : triOf(set, r.caps);
					const id = `${group}-${r.id}`;
					return (
						<li key={r.id} className={r.id === "full" ? "sm:col-span-2" : undefined}>
							<label
								htmlFor={id}
								className={cn(
									"flex min-h-11 cursor-pointer items-start gap-3 rounded-xl p-3 transition-[background-color,box-shadow] focus-within:shadow-[0_0_0_2px_var(--ring)]",
									state === "none" ? "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-surface-3" : "bg-accent-soft shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_45%,transparent)]",
									disabled && "cursor-not-allowed opacity-60",
								)}
							>
								<input id={id} type="checkbox" className="peer sr-only" checked={state === "all"} disabled={disabled} onChange={(e) => apply(r.caps, e.target.checked)} />
								<Box state={state} />
								<span className="flex min-w-0 flex-col gap-1">
									<span className="text-[13px] font-semibold">
										{r.title}
										{state === "some" ? <span className="ml-1.5 text-2xs font-normal text-subtle">partly</span> : null}
									</span>
									<span className="text-xs text-muted-foreground">{r.description}</span>
									{r.id !== "full" ? (
										<span className="flex flex-wrap gap-1 pt-0.5">
											{r.caps.map((c) => (
												<span key={c} className={cn("rounded px-1 py-0.5 font-mono text-2xs", set.has(c) ? "bg-accent/15 text-accent" : "bg-surface-3 text-subtle")}>
													{c}
												</span>
											))}
										</span>
									) : null}
								</span>
							</label>
						</li>
					);
				})}
			</ul>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				className="inline-flex min-h-9 items-center gap-1 self-start rounded-md text-xs font-medium text-accent outline-none focus-visible:shadow-[0_0_0_2px_var(--ring)] coarse:min-h-11"
			>
				Fine-tune individual permissions <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
			</button>
			{open ? (
				<ul className="flex animate-fade-in flex-col divide-y rounded-xl shadow-[inset_0_0_0_1px_var(--border)]" aria-label="Capabilities">
					{CAPABILITIES.map((cap) => {
						const info = CAPABILITY_INFO[cap];
						const id = `${group}-raw-${cap}`;
						return (
							<li key={cap}>
								<label htmlFor={id} className={cn("flex min-h-11 cursor-pointer items-start gap-3 px-3 py-2.5", disabled && "cursor-not-allowed opacity-60")}>
									<input id={id} type="checkbox" checked={set.has(cap)} disabled={disabled} onChange={(e) => apply([cap], e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--accent)] coarse:size-5" />
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
			) : null}
		</div>
	);
}

/** Read-only chips for a granted/received set. */
export function CapabilityChips({ value, empty = "None" }: { value: readonly Capability[]; empty?: string }) {
	if (value.length === 0) return <span className="text-[13px] text-subtle">{empty}</span>;
	return (
		<div className="flex flex-col gap-2">
			<span className="text-[13px] font-medium">{summarizeCapabilities(value)}</span>
			<div className="flex flex-wrap gap-1.5">
				{value.map((c) => (
					<span key={c} title={CAPABILITY_INFO[c]?.description} className="rounded-md bg-surface-3 px-1.5 py-1 font-mono text-2xs text-muted-foreground">
						{c}
					</span>
				))}
			</div>
		</div>
	);
}
