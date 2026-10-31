import type { Context } from "@clam/contracts";
import { ChevronDown, GitMerge, Pencil, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { lineDiff } from "@/lib/line-diff";
import { cn, relativeTime } from "@/lib/utils";
import { Button } from "@/ui/button";
import { MarkdownEditor } from "./editor.tsx";
import { type ResolveContextInput, useContextMutations } from "./hooks.ts";
import { authorLabel, DiffStat, DiffView } from "./versions.tsx";

function Side({ heading, meta, body, tone }: { heading: string; meta: string; body: string; tone: "mine" | "theirs" }) {
	return (
		<section aria-label={heading} className="flex min-w-0 flex-col gap-1.5">
			<div className="flex min-w-0 flex-col gap-0.5">
				<h4 className={cn("text-xs font-semibold", tone === "mine" ? "text-accent" : "text-warning")}>{heading}</h4>
				<p className="truncate text-2xs text-subtle" title={meta}>
					{meta}
				</p>
			</div>
			<pre className="scrollbar-thin max-h-72 min-h-16 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-1 p-3 font-mono text-xs leading-relaxed shadow-[inset_0_0_0_1px_var(--border)]">
				{body || <span className="text-subtle">(empty)</span>}
			</pre>
		</section>
	);
}

/**
 * Prominent conflict banner + resolution panel. Never merges automatically: the human picks
 * "Keep mine", "Keep theirs" or writes a merged text.
 */
export function ConflictResolver({ context, nodeNames, onResolved }: { context: Context; nodeNames: Map<string, string>; onResolved?: (c: Context) => void }) {
	const { resolve } = useContextMutations();
	const remote = context.sync.conflict;
	const [open, setOpen] = useState(true);
	const [merging, setMerging] = useState(false);
	const [merged, setMerged] = useState(context.body);
	const ops = useMemo(() => lineDiff(context.body, remote?.body ?? ""), [context.body, remote?.body]);
	const pendingKeep = resolve.isPending ? resolve.variables?.body.keep : undefined;
	const remoteName = remote ? (nodeNames.get(remote.nodeId) ?? remote.nodeName) : "Another machine";

	const run = (body: ResolveContextInput, done: string) =>
		resolve.mutate(
			{ id: context.id, body },
			{
				onSuccess: (c) => {
					toast.success(done, { description: "Both versions stay in History." });
					setMerging(false);
					onResolved?.(c);
				},
				onError: (e) => toast.error("Could not resolve the conflict", { description: errorMessage(e) }),
			},
		);

	return (
		<div role="alert" className="flex min-w-0 flex-col gap-3 rounded-xl bg-danger/10 p-3 shadow-[inset_0_0_0_1px_var(--danger)]">
			<div className="flex items-start gap-2.5">
				<TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<p className="text-[13px] font-semibold text-danger">Sync conflict — {remoteName} changed this at the same time</p>
					<p className="text-xs text-muted-foreground">
						Nothing was merged automatically. Look at both versions and choose which to keep, or write a merged one. Both versions stay in History.
					</p>
				</div>
				<Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="shrink-0">
					{open ? "Hide" : "Resolve"}
					<ChevronDown className={cn("transition-transform duration-150", open && "rotate-180")} aria-hidden />
				</Button>
			</div>
			{open ? (
				<div className="flex min-w-0 flex-col gap-4">
					{remote ? (
						<>
							<div className="grid min-w-0 gap-3 lg:grid-cols-2">
								<Side
									heading="Mine (this machine)"
									meta={`v${context.version} · ${authorLabel(context.author)} · ${relativeTime(context.updatedAt)}`}
									body={context.body}
									tone="mine"
								/>
								<Side
									heading={`Theirs (${remoteName})`}
									meta={`v${remote.version} · ${authorLabel(remote.author)} · ${relativeTime(remote.at)}`}
									body={remote.body}
									tone="theirs"
								/>
							</div>
							<div className="flex min-w-0 flex-col gap-1.5">
								<div className="flex items-center gap-2 text-xs text-muted-foreground">
									<span>Differences (mine → theirs)</span>
									<DiffStat ops={ops} />
								</div>
								<DiffView ops={ops} label="Differences between my version and theirs" />
							</div>
						</>
					) : (
						<p className="text-xs text-muted-foreground">The competing version is not available on this machine yet. You can keep your version.</p>
					)}
					{merging ? (
						<div className="flex min-w-0 flex-col gap-3 rounded-lg bg-surface-1/60 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
							<p className="text-xs font-medium">Merged text — starts from your version; copy what you need from theirs above.</p>
							<MarkdownEditor value={merged} onChange={setMerged} disabled={resolve.isPending} aria-label="Merged content (Markdown)" onSubmit={() => run({ keep: "merged", body: merged }, "Merged version saved")} autoFocus />
							<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
								<Button variant="ghost" disabled={resolve.isPending} onClick={() => setMerging(false)}>
									Cancel
								</Button>
								<Button variant="primary" loading={pendingKeep === "merged"} disabled={resolve.isPending} onClick={() => run({ keep: "merged", body: merged }, "Merged version saved")}>
									<GitMerge /> Save merged version
								</Button>
							</div>
						</div>
					) : (
						<div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
							<Button variant="outline" loading={pendingKeep === "local"} disabled={resolve.isPending} onClick={() => run({ keep: "local" }, "Kept your version")}>
								Keep mine
							</Button>
							{remote ? (
								<Button variant="outline" loading={pendingKeep === "remote"} disabled={resolve.isPending} onClick={() => run({ keep: "remote" }, `Kept ${remoteName}'s version`)}>
									Keep theirs
								</Button>
							) : null}
							<Button
								variant="outline"
								disabled={resolve.isPending}
								onClick={() => {
									setMerged(context.body);
									setMerging(true);
								}}
							>
								<Pencil /> Edit merged…
							</Button>
						</div>
					)}
				</div>
			) : null}
		</div>
	);
}
