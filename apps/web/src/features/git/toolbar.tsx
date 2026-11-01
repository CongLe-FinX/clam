import type { GitStatus } from "@clam/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CloudDownload, DownloadCloud, UploadCloud } from "lucide-react";
import { msg, t, tr } from "@/i18n";
import { relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Progress } from "@/ui/progress";
import { Tip } from "@/ui/tooltip";
import { BranchSwitcher } from "./branch-switcher.tsx";
import { runFetch, runPull, runPush } from "./ops.ts";
import { useGitUi } from "./store.ts";

export function GitToolbar({
	projectId,
	status,
	compact,
	branchOpen,
	onBranchOpenChange,
}: {
	projectId: string;
	status: GitStatus;
	compact: boolean;
	branchOpen: boolean;
	onBranchOpenChange: (o: boolean) => void;
}) {
	const qc = useQueryClient();
	const busy = useGitUi((s) => s.busy[projectId]);
	const op = useGitUi((s) => s.operations[projectId]);
	const canSync = status.branch !== null && !status.detached;
	const hasUpstream = status.upstream !== null;
	const nothingToPush = hasUpstream && status.ahead === 0;
	const working = busy !== null && busy !== undefined;

	const sync = [
		{
			key: "fetch" as const,
			label: msg("Fetch"),
			icon: CloudDownload,
			tip: status.lastFetchedAt ? t("Fetch from origin · last fetched {time}", { time: relativeTime(status.lastFetchedAt) }) : t("Fetch from origin"),
			disabled: status.remotes.length === 0,
			count: 0,
			run: () => void runFetch(qc, projectId),
		},
		{
			key: "pull" as const,
			label: msg("Pull"),
			icon: DownloadCloud,
			tip: !hasUpstream ? t("No upstream to pull from") : status.behind > 0 ? t("Pull {count, plural, one {# commit} other {# commits}} (fast-forward only)", { count: status.behind }) : t("Pull (fast-forward only)"),
			disabled: !canSync || !hasUpstream,
			count: status.behind,
			run: () => void runPull(qc, projectId),
		},
		{
			key: "push" as const,
			label: hasUpstream ? msg("Push") : msg("Publish"),
			icon: UploadCloud,
			tip: !hasUpstream ? t("Publish this branch to origin") : status.ahead > 0 ? t("Push {count, plural, one {# commit} other {# commits}} — never forced", { count: status.ahead }) : t("Nothing to push"),
			disabled: !canSync || nothingToPush || status.remotes.length === 0,
			count: status.ahead,
			run: () => void runPush(qc, projectId, { setUpstream: true }),
		},
	];

	return (
		<div className="shrink-0 border-b bg-surface-1/60">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2.5 py-2">
				<BranchSwitcher projectId={projectId} status={status} open={branchOpen} onOpenChange={onBranchOpenChange} disabled={working} />
				<div className="flex items-center gap-1" aria-label={t("Ahead and behind upstream")}>
					{status.ahead > 0 ? (
						<Tip label={t("{count, plural, one {# commit} other {# commits}} ahead of {upstream}", { count: status.ahead, upstream: status.upstream ?? t("upstream") })}>
							<Badge variant="accent" className="tabular">
								<ArrowUp aria-hidden />
								{status.ahead}
							</Badge>
						</Tip>
					) : null}
					{status.behind > 0 ? (
						<Tip label={t("{count, plural, one {# commit} other {# commits}} behind {upstream}", { count: status.behind, upstream: status.upstream ?? t("upstream") })}>
							<Badge variant="warning" className="tabular">
								<ArrowDown aria-hidden />
								{status.behind}
							</Badge>
						</Tip>
					) : null}
					{status.operation ? <Badge variant="danger">{t("{operation} in progress", { operation: status.operation })}</Badge> : null}
					{status.detached ? <Badge variant="warning">{t("detached")}</Badge> : null}
					{!hasUpstream && canSync && status.remotes.length > 0 ? <Badge variant="outline">{t("not published")}</Badge> : null}
				</div>
				<div className="ml-auto flex items-center gap-1">
					{sync.map(({ key, label, icon: Icon, tip, disabled, count, run }) => {
						const active = busy === key;
						return (
							<Tip key={key} label={tip}>
								<Button variant="outline" size={compact ? "icon" : "md"} aria-label={tr(label)} loading={active} disabled={disabled || (working && !active)} onClick={run} className="relative">
									{active ? null : <Icon />}
									{compact ? null : tr(label)}
									{count > 0 && !active ? <span className="tabular -mr-0.5 rounded bg-accent-soft px-1 font-mono text-2xs text-accent">{count}</span> : null}
									{compact && count > 0 && !active ? <span className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-accent px-1 font-mono text-[10px] leading-4 text-accent-foreground">{count}</span> : null}
								</Button>
							</Tip>
						);
					})}
				</div>
			</div>
			{working && op?.state === "running" ? (
				<div className="flex items-center gap-2 px-2.5 pb-2 text-2xs text-muted-foreground" role="status">
					<span className="shrink-0 capitalize">{op.phase ?? op.kind}</span>
					<Progress value={op.percent ?? 0} className="h-1 flex-1" />
					{op.percent !== null ? <span className="tabular w-8 shrink-0 text-right font-mono">{Math.round(op.percent)}%</span> : null}
				</div>
			) : null}
		</div>
	);
}
