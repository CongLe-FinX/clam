import type { GitStatus } from "@clam/contracts";
import { CircleCheck, ShieldAlert, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { useEffect } from "react";
import { t } from "@/i18n";
import { errorText } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { useConflictCheck } from "./hooks.ts";

/** Dry-run `git merge-tree` against the upstream plus the dirty-overlap test a pull would apply. Never touches the working tree. */
export function ConflictCheck({ projectId, status }: { projectId: string; status: GitStatus }) {
	const check = useConflictCheck(projectId);
	const { reset } = check;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a result is only valid for the commit it was computed on
	useEffect(() => reset(), [status.headSha, status.upstream, reset]);
	if (!status.upstream) return null;
	const r = check.data;
	const overlap = r?.dirtyOverlap ?? [];

	return (
		<div className="shrink-0 border-b px-2.5 py-1.5">
			<div className="flex items-center gap-2">
				<Button size="sm" variant="ghost" onClick={() => check.mutate()} loading={check.isPending} className="-ml-1.5">
					<ShieldCheck /> {t("Check for conflicts")}
				</Button>
				<span className="min-w-0 truncate text-2xs text-subtle">{t("against {upstream}", { upstream: status.upstream })}</span>
				{r ? (
					<button type="button" aria-label={t("Dismiss conflict report")} onClick={() => check.reset()} className="ml-auto grid size-6 place-items-center rounded-md text-subtle outline-none hover:bg-surface-3 hover:text-foreground coarse:size-9">
						<X className="size-3.5" />
					</button>
				) : null}
			</div>
			{check.error ? (
				<p role="alert" className="mt-1 text-xs text-danger">
					{errorText(check.error)}
				</p>
			) : null}
			{r ? (
				<div
					role="status"
					className={cn(
						"animate-slide-up mt-1.5 flex flex-col gap-1.5 rounded-lg px-3 py-2 text-xs",
						!r.clean ? "bg-danger/[0.09] text-danger" : overlap.length > 0 ? "bg-warning/[0.11] text-warning" : "bg-success/[0.10] text-success",
					)}
				>
					<p className="flex items-center gap-1.5 font-medium">
						{!r.clean ? <ShieldAlert className="size-4 shrink-0" /> : overlap.length > 0 ? <TriangleAlert className="size-4 shrink-0" /> : <CircleCheck className="size-4 shrink-0" />}
						{!r.clean
							? t("Merging with {against} would conflict in {count, plural, one {# file} other {# files}}", { against: r.against, count: r.conflicts.length })
							: overlap.length > 0
								? t("No merge conflicts, but a pull would be refused")
								: t("No conflicts with {against}", { against: r.against })}
						<span className="ml-auto shrink-0 font-mono text-2xs font-normal text-muted-foreground">
							↑{r.ahead} ↓{r.behind}
						</span>
					</p>
					{r.conflicts.length > 0 ? (
						<ul className="flex flex-col gap-0.5 text-foreground">
							{r.conflicts.map((c) => (
								<li key={c.path} className="flex items-baseline gap-2">
									<span className="min-w-0 truncate font-mono text-2xs">{c.path}</span>
									<span className="shrink-0 text-2xs text-muted-foreground">{c.type}</span>
								</li>
							))}
						</ul>
					) : null}
					{overlap.length > 0 ? (
						<div className="text-foreground">
							<p className="mb-0.5 text-2xs text-muted-foreground">{t("Uncommitted local files that are also changed upstream — commit or discard them before pulling:")}</p>
							<ul className="flex flex-col gap-0.5">
								{overlap.map((p) => (
									<li key={p} className="truncate font-mono text-2xs">
										{p}
									</li>
								))}
							</ul>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
