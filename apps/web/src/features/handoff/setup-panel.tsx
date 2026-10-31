import type { Handoff, SetupCommand } from "@clam/contracts";
import { Check, Loader2, ShieldQuestion, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import type { HandoffActions } from "./actions.ts";

const STATE: Record<SetupCommand["state"], { label: string; variant: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
	pending_approval: { label: "Needs approval", variant: "warning" },
	approved: { label: "Approved", variant: "accent" },
	denied: { label: "Denied", variant: "danger" },
	running: { label: "Running", variant: "accent" },
	succeeded: { label: "Succeeded", variant: "success" },
	failed: { label: "Failed", variant: "danger" },
	skipped: { label: "Skipped", variant: "neutral" },
};
const PURPOSE: Record<SetupCommand["purpose"], string> = { install: "Install", setup: "Setup", check: "Check" };

function OutputTail({ text }: { text: string }) {
	const ref = useRef<HTMLPreElement>(null);
	// Follow the output while it grows.
	useEffect(() => {
		const el = ref.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [text]);
	return (
		<pre
			ref={ref}
			tabIndex={0}
			aria-label="Command output"
			className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-0 p-2.5 font-mono text-xs leading-relaxed text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			{text}
		</pre>
	);
}

/** Commands the target wants to run while setting up: reviewed and approved here unless the machine's policy is automatic. */
export function SetupPanel({ h, actions }: { h: Handoff; actions: HandoffActions }) {
	if (h.setup.length === 0) return null;
	const canApprove = h.actions.includes("approve_setup");
	const canDeny = h.actions.includes("deny_setup");
	const pending = h.setup.filter((c) => c.state === "pending_approval");
	const busy = actions.setup.isPending;
	const decide = (approve: string[], deny: string[]) => actions.setup.mutate({ approve, deny });

	return (
		<Card className={cn(pending.length > 0 && canApprove && "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning)_45%,transparent)]")}>
			<CardHeader>
				<div className="min-w-0">
					<CardTitle className="flex items-center gap-1.5">
						<ShieldQuestion className="size-4 text-subtle" aria-hidden /> Setup commands
					</CardTitle>
					<p className="mt-1 text-xs text-muted-foreground">
						{h.role === "target"
							? "These run in the restored folder on this machine. Read them before approving; they come from the source's project."
							: "The target machine runs these to set up the work. It reviews them first."}
					</p>
				</div>
				{canApprove && pending.length > 1 ? (
					<Button size="sm" variant="primary" loading={busy} onClick={() => decide(pending.map((c) => c.id), [])}>
						<Check /> Approve all
					</Button>
				) : null}
			</CardHeader>
			<CardContent className="flex flex-col gap-3 pt-3">
				{h.setup.map((c) => {
					const s = STATE[c.state];
					return (
						<div key={c.id} className="flex flex-col gap-2 rounded-lg bg-surface-2 p-3">
							<div className="flex flex-wrap items-center gap-1.5">
								<Badge variant={s.variant}>
									{c.state === "running" ? <Loader2 className="animate-spin" aria-hidden /> : null}
									{s.label}
								</Badge>
								<Badge variant="outline">{PURPOSE[c.purpose]}</Badge>
								{c.exitCode !== null ? (
									<Badge variant={c.exitCode === 0 ? "success" : "danger"} className="font-mono">
										exit {c.exitCode}
									</Badge>
								) : null}
							</div>
							<code className="break-all font-mono text-[13px] leading-snug">
								<span className="select-none text-subtle">$ </span>
								{c.command}
							</code>
							<span className="break-all font-mono text-2xs text-subtle">in {c.cwd}</span>
							{c.outputTail ? <OutputTail text={c.outputTail} /> : null}
							{c.state === "pending_approval" && (canApprove || canDeny) ? (
								<div className="flex flex-wrap gap-2">
									{canApprove ? (
										<Button size="sm" variant={pending.length > 1 ? "secondary" : "primary"} disabled={busy} onClick={() => decide([c.id], [])}>
											<Check /> Approve
										</Button>
									) : null}
									{canDeny ? (
										<Button size="sm" variant="outline" className="text-danger" disabled={busy} onClick={() => decide([], [c.id])}>
											<X /> Deny
										</Button>
									) : null}
								</div>
							) : null}
						</div>
					);
				})}
			</CardContent>
		</Card>
	);
}
