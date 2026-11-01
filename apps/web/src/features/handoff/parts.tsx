import type { Handoff } from "@clam/contracts";
import { ArrowRight, Clock, Server, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { renderServerText, t, tr } from "@/i18n";
import { cn, formatDateTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { FAILURE_TEXT, STATE_META, clockOf, partyText, timeLeft } from "./meta.ts";

export function useNow(intervalMs = 1000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}

export function StateChip({ state, className }: { state: Handoff["state"]; className?: string }) {
	const m = STATE_META[state];
	return (
		<Badge variant={m.variant} className={className}>
			{tr(m.label)}
		</Badge>
	);
}

export function RoleChip({ role }: { role: Handoff["role"] }) {
	return <Badge variant="outline">{role === "source" ? t("Outgoing") : t("Incoming")}</Badge>;
}

/** `source → target`, with “this machine” marked on the local end. */
export function NodeFlow({ h, className }: { h: Handoff; className?: string }) {
	const end = (p: Handoff["source"], mine: boolean) => (
		<span className="inline-flex min-w-0 items-center gap-1.5">
			<Server className="size-3.5 shrink-0 text-subtle" aria-hidden />
			<span className="truncate">{partyText(p)}</span>
			{mine ? <span className="shrink-0 rounded bg-surface-3 px-1 text-2xs text-subtle">{t("this machine")}</span> : null}
		</span>
	);
	return (
		<span className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-muted-foreground", className)}>
			{end(h.source, h.role === "source")}
			<ArrowRight className="size-3.5 shrink-0 text-subtle" aria-label={t("hands off to")} />
			{end(h.target, h.role === "target")}
		</span>
	);
}

/** Live countdown to the offer expiry / restore deadline. Renders nothing once the handoff is settled. */
export function Countdown({ h, now, withLabel }: { h: Handoff; now: number; withLabel?: boolean }) {
	const clock = clockOf(h);
	if (!clock) return null;
	const left = timeLeft(clock.at, now);
	return (
		<span
			className={cn("tabular inline-flex items-center gap-1 whitespace-nowrap font-mono text-2xs", left.overdue ? "text-danger" : left.soon ? "text-warning" : "text-muted-foreground")}
			title={t("{label}: {date}", { label: tr(clock.label), date: formatDateTime(clock.at) })}
		>
			<Clock className="size-3" aria-hidden />
			{withLabel ? t("{label} · ", { label: tr(clock.label) }) : null}
			{left.text}
		</span>
	);
}

export function FailureBadge({ h }: { h: Handoff }) {
	if (!h.failure) return null;
	return (
		<Badge variant="danger" title={renderServerText(h.failure.detail, h.failure.i18n)}>
			<TriangleAlert aria-hidden />
			{tr(FAILURE_TEXT[h.failure.code].title)}
		</Badge>
	);
}
