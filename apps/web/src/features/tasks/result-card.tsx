import { LOCAL_API_PREFIX, type Task, routes } from "@clam/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, GitBranch, GitPullRequest, Info, Paperclip } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { useGitStatus } from "@/features/git/hooks";
import { runFetch } from "@/features/git/ops";
import { CopyIconButton } from "@/features/network/components";
import { formatBytes } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";

const CreatePullRequestDialog = lazy(() => import("@/features/git/pull-requests.tsx").then((m) => ({ default: m.CreatePullRequestDialog })));

/** "Create PR" for a pushed task branch, in the delegating node's own project (M2 pull-request dialog). */
function CreatePrAction({ task, projectId, branch, summary }: { task: Task; projectId: string; branch: string; summary: string }) {
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [fetching, setFetching] = useState(false);
	const status = useGitStatus(projectId).data;
	const ready = status?.isRepo === true;
	// The executor pushed the branch from another machine: fetch it first so this clone knows it exists on the remote.
	const start = async () => {
		setFetching(true);
		await runFetch(qc, projectId);
		setFetching(false);
		setOpen(true);
	};
	return (
		<>
			<Button size="sm" variant="primary" onClick={() => void start()} loading={fetching} disabled={!ready} title={ready ? undefined : "The project must be a Git repository on this node"}>
				<GitPullRequest /> Create PR
			</Button>
			{open && status ? (
				<Suspense fallback={null}>
					<CreatePullRequestDialog
						projectId={projectId}
						// The branch lives on the remote (the executor pushed it): describe it as published so nothing is pushed from here.
						status={{ ...status, branch, detached: false, upstream: `origin/${branch}`, ahead: 0, behind: 0 }}
						prefill={{ title: task.title, body: `${summary}\n\n_Delegated task ${task.id} · executed by ${task.executor.agentName ?? "agent"}@${task.executor.nodeName}_` }}
						onClose={() => setOpen(false)}
						onCreated={() => setOpen(false)}
					/>
				</Suspense>
			) : null}
		</>
	);
}

export function ResultCard({ task }: { task: Task }) {
	const result = task.result;
	if (!result) return null;
	const failed = task.status === "failed";

	return (
		<Card className={failed ? "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--danger)_35%,transparent)]" : undefined}>
			<CardHeader>
				<CardTitle>{failed ? "Result — failed" : "Result"}</CardTitle>
				{result.autoCompleted ? <Badge variant="neutral">auto-completed</Badge> : null}
			</CardHeader>
			<CardContent className="flex flex-col gap-3.5 pt-3">
				{result.autoCompleted ? (
					<p className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
						<Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
						The agent finished without calling <code className="font-mono">mesh_complete</code>, so this is its final answer rather than a deliberate report.
					</p>
				) : null}
				<LazyMarkdown text={result.summary || "_No summary was provided._"} />

				{result.branch ? (
					<div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
						<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
							<GitBranch className="size-4 text-muted-foreground" aria-hidden />
							<code className="min-w-0 break-all font-mono text-xs">{result.branch}</code>
							<CopyIconButton value={result.branch} label="Copy branch name" />
							{result.commit ? <code className="font-mono text-2xs text-subtle">{result.commit.slice(0, 8)}</code> : null}
							<Badge variant={result.pushed ? "success" : "warning"} className="ml-auto">
								{result.pushed ? "Pushed" : "Not pushed"}
							</Badge>
						</div>
						{result.pushed ? (
							<div className="flex flex-wrap gap-2">
								{result.compareUrl ? (
									<Button asChild size="sm" variant="outline">
										<a href={result.compareUrl} target="_blank" rel="noreferrer noopener">
											<ExternalLink /> Compare on GitHub
										</a>
									</Button>
								) : null}
								{task.direction === "outgoing" && task.projectId ? <CreatePrAction task={task} projectId={task.projectId} branch={result.branch} summary={result.summary} /> : null}
							</div>
						) : (
							<p className="text-xs text-muted-foreground">The executor could not push this branch{result.artifacts.length > 0 ? " — apply the patch attached below instead." : "."}</p>
						)}
					</div>
				) : null}

				{result.artifacts.length > 0 ? (
					<div className="flex flex-col gap-1.5">
						<h3 className="text-2xs font-semibold uppercase tracking-wider text-subtle">Artifacts</h3>
						<ul className="flex flex-col gap-1">
							{result.artifacts.map((a) => (
								<li key={a.artifactId} className="flex min-h-9 items-center gap-2 rounded-lg bg-surface-2 px-2.5 text-[13px] coarse:min-h-11">
									<Paperclip className="size-3.5 shrink-0 text-subtle" aria-hidden />
									<span className="min-w-0 flex-1 truncate font-mono text-xs">{a.name}</span>
									<span className="tabular font-mono text-2xs text-subtle">{formatBytes(a.size)}</span>
									{task.direction === "outgoing" ? (
										<Button asChild size="icon-sm" variant="ghost" aria-label={`Download ${a.name}`}>
											<a href={`${LOCAL_API_PREFIX}${routes.taskArtifact(task.id, a.artifactId)}`} download={a.name}>
												<Download />
											</a>
										</Button>
									) : null}
								</li>
							))}
						</ul>
						{task.direction === "incoming" ? <p className="text-2xs text-subtle">The delegating node downloads artifacts from this node.</p> : null}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}
