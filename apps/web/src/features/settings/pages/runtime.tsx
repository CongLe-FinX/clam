import { Link } from "@tanstack/react-router";
import { Cpu, RotateCw, Square } from "lucide-react";
import { toast } from "sonner";
import type { RuntimeState, RuntimeStatus } from "@clam/contracts";
import { RUNTIME_STATE_LABEL } from "@/components/session-status";
import { t, tr } from "@/i18n";
import { errorText } from "@/lib/api";
import { formatNumber } from "@/lib/utils";
import { useRuntime, useSessions } from "@/lib/queries";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";
import { StatusDot, type DotStatus } from "@/ui/status-dot";
import { fmtAgo, useNow } from "@/features/usage/format";
import { InlineError, PageBody, PageIntro, SettingsSection } from "../components/section";
import { useRuntimeActions, useSettings } from "../hooks";

const DOT: Record<RuntimeState, DotStatus> = {
	stopped: "offline",
	starting: "starting",
	ready: "online",
	busy: "busy",
	crashed: "crashed",
	restarting: "starting",
};

function RuntimeRow({ r, title, now }: { r: RuntimeStatus; title: string | undefined; now: number }) {
	const { stop, restart } = useRuntimeActions();
	const running = r.state === "ready" || r.state === "busy" || r.state === "starting" || r.state === "restarting";
	return (
		<li className="rounded-lg border border-border bg-surface-1 p-3.5">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<StatusDot status={DOT[r.state]} />
						<span className="truncate text-sm font-medium">{title ?? t("Session")}</span>
						<Badge variant={r.state === "crashed" ? "danger" : r.state === "busy" ? "warning" : r.state === "ready" ? "success" : "neutral"}>{tr(RUNTIME_STATE_LABEL[r.state])}</Badge>
					</div>
					<div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{r.sessionId}</div>
				</div>
				<div className="flex gap-1.5">
					{running && (
						<Button
							size="sm"
							variant="outline"
							loading={stop.isPending && stop.variables === r.sessionId}
							onClick={() => stop.mutate(r.sessionId, { onError: (e) => toast.error(t("Could not stop runtime"), { description: errorText(e) }) })}
						>
							<Square className="size-3.5" />
							{t("Stop")}
						</Button>
					)}
					<Button
						size="sm"
						variant="secondary"
						loading={restart.isPending && restart.variables === r.sessionId}
						onClick={() => restart.mutate(r.sessionId, { onError: (e) => toast.error(t("Could not restart runtime"), { description: errorText(e) }) })}
					>
						<RotateCw className="size-3.5" />
						{t("Restart")}
					</Button>
				</div>
			</div>
			<dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
				{[
					[t("PID"), r.pid != null ? String(r.pid) : "—"],
					[t("Started"), r.startedAt ? fmtAgo(r.startedAt, now) : "—"],
					[t("Last activity"), r.lastActivityAt ? fmtAgo(r.lastActivityAt, now) : "—"],
					[t("Restarts"), String(r.restarts)],
				].map(([k, v]) => (
					<div key={k}>
						<dt className="text-muted-foreground">{k}</dt>
						<dd className="font-mono">{v}</dd>
					</div>
				))}
			</dl>
			{r.lastError && <div className="mt-3 break-words rounded-md border border-danger/30 bg-danger/10 p-2 font-mono text-[11px] text-danger">{r.lastError}</div>}
		</li>
	);
}

export default function RuntimePage() {
	const runtime = useRuntime();
	const sessions = useSessions();
	const settings = useSettings();
	const now = useNow(5000);
	const titles = new Map((sessions.data ?? []).map((s) => [s.id, s.title]));
	const list = runtime.data ?? [];
	const active = list.filter((r) => r.state === "ready" || r.state === "busy" || r.state === "starting" || r.state === "restarting").length;

	return (
		<>
			<PageIntro
				title={t("Agent Runtime")}
				description={t("Each active session runs its own OMP process. Idle processes stop automatically and resume from the session on demand.")}
				actions={
					<Button variant="outline" asChild>
						<Link to={"/settings/general" as never}>{t("Limits & approval mode")}</Link>
					</Button>
				}
			/>
			<PageBody>
				<div className="grid grid-cols-3 gap-3">
					{[
						[t("Active"), String(active)],
						[t("Max concurrent"), settings.data ? String(settings.data.maxConcurrentRuntimes) : "—"],
						[t("Idle timeout"), settings.data ? t("{count} min", { count: formatNumber(settings.data.runtimeIdleTimeoutMin) }) : "—"],
					].map(([k, v]) => (
						<div key={k} className="rounded-lg border border-border bg-surface-1 p-3">
							<div className="text-xs text-muted-foreground">{k}</div>
							<div className="mt-1 font-mono text-lg font-semibold tabular-nums">{v}</div>
						</div>
					))}
				</div>
				<SettingsSection title={t("Processes")}>
					{runtime.isPending && <Skeleton className="h-24" />}
					{runtime.isError && <InlineError error={runtime.error} onRetry={() => runtime.refetch()} />}
					{runtime.data && list.length === 0 && (
						<div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
							<Cpu className="size-6" />
							{t("No agent processes are running. They start when you open a session.")}
						</div>
					)}
					{list.length > 0 && (
						<ul className="space-y-2">
							{list.map((r) => (
								<RuntimeRow key={r.sessionId} r={r} title={titles.get(r.sessionId)} now={now} />
							))}
						</ul>
					)}
				</SettingsSection>
			</PageBody>
		</>
	);
}
