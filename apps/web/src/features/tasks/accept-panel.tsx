import type { Task } from "@clam/contracts";
import { Check, CloudDownload, FolderGit2, Paperclip, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAgents, useProjects } from "@/lib/queries";
import { formatBytes } from "@/lib/utils";
import { useUi } from "@/lib/store";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Field } from "@/ui/field";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { PartyChip } from "./components.tsx";
import { projectsForRepo, repoSlug } from "./format.ts";
import { useDecideTask } from "./hooks.ts";

const ANY_AGENT = "__any__";

/** Executor side: decide an offered task — pick the local clone to run in and accept, or reject with a reason. `reaccept` re-runs a blocked task. */
export function AcceptPanel({ task, reaccept }: { task: Task; reaccept?: boolean }) {
	const projects = useProjects();
	const agents = useAgents();
	const openDialog = useUi((s) => s.openDialog);
	const repo = task.repo;
	const matches = useMemo(() => (repo ? projectsForRepo(repo.url, projects.data ?? []) : []), [repo, projects.data]);
	const slug = repo ? (repoSlug(repo.url) ?? repo.url) : null;
	const decide = useDecideTask(task.id);
	const [projectId, setProjectId] = useState(task.projectId ?? "");
	const [agentId, setAgentId] = useState(task.executor.agentId ?? ANY_AGENT);
	const [rejecting, setRejecting] = useState(false);
	const [reason, setReason] = useState("");

	// A single matching clone is the obvious choice (auto-accept uses the same rule).
	useEffect(() => {
		if (!projectId && matches.length === 1 && matches[0]) setProjectId(matches[0].id);
	}, [projectId, matches]);

	const accept = () => decide.mutate({ decision: "accept", projectId: repo && projectId ? projectId : undefined, agentId: agentId === ANY_AGENT ? undefined : agentId });

	return (
		<Card className="shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning)_45%,transparent)]">
			<CardHeader>
				<CardTitle>{reaccept ? "Resolve and re-accept" : "Accept this task?"}</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-3.5 pt-3">
				<p className="text-[13px] text-muted-foreground">
					<PartyChip party={task.sender} role="sender" className="inline-flex align-middle" />{" "}
					{repo && slug ? (
						<>
							wants one of your agents to work on <code className="font-mono text-foreground">{slug}</code>
							{repo.branch ? (
								<>
									{" "}
									from <code className="font-mono text-foreground">{repo.branch}</code>
								</>
							) : null}
							. It runs in a local clone of that repository on this machine.
						</>
					) : (
						<>
							wants one of your agents to {task.deliverAs === "summary" ? "answer a question" : "work on a folder task"}. There is no repository: it runs in a fresh folder on this machine
							{task.deliverAs === "files" ? " and the changed files go back to the sender to preview and apply" : ""}.
						</>
					)}
				</p>
				{task.inputFiles ? (
					<p className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
						<Paperclip className="size-3.5 shrink-0" aria-hidden />
						Includes {task.inputFiles.fileCount} input {task.inputFiles.fileCount === 1 ? "file" : "files"} ({formatBytes(task.inputFiles.size)}), copied into the working folder.
					</p>
				) : null}
				{repo && matches.length === 0 && projects.isSuccess ? (
					<div className="flex flex-col gap-2 rounded-lg bg-surface-2 p-3 text-[13px]">
						<p>
							No project on this machine is linked to <code className="font-mono">{slug}</code>.
						</p>
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" variant="primary" onClick={() => openDialog({ kind: "create-project", workspaceId: task.workspaceId, mode: "clone" })}>
								<CloudDownload /> Clone this repo
							</Button>
							<span className="text-xs text-subtle">Already cloned it? Link its GitHub repository on the project page, then accept here.</span>
						</div>
					</div>
				) : (
					<div className="grid gap-3 sm:grid-cols-2">
						{repo ? (
							<Field label="Run in project" hint={matches.length > 1 ? "Several projects match this repository — choose one." : undefined}>
								{() => (
									<Select value={projectId} onValueChange={setProjectId}>
										<SelectTrigger>
											<SelectValue placeholder="Select a project" />
										</SelectTrigger>
										<SelectContent>
											{matches.map((p) => (
												<SelectItem key={p.id} value={p.id}>
													<span className="inline-flex items-center gap-1.5">
														<FolderGit2 className="size-3.5 text-subtle" aria-hidden />
														{p.name}
													</span>
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							</Field>
						) : null}
						{(agents.data?.length ?? 0) > 1 ? (
							<Field label="Agent">
								{() => (
									<Select value={agentId} onValueChange={setAgentId}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={ANY_AGENT}>Any available agent</SelectItem>
											{agents.data?.map((a) => (
												<SelectItem key={a.id} value={a.id}>
													{a.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							</Field>
						) : null}
					</div>
				)}
				{rejecting ? (
					<Field label="Reason" hint="Shown to the delegating node.">
						{(id) => <Input id={id} autoFocus value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} placeholder="e.g. I'm busy with a release" />}
					</Field>
				) : null}
				<div className="flex flex-wrap items-center gap-2">
					{rejecting ? (
						<>
							<Button variant="danger" loading={decide.isPending} disabled={!reason.trim()} onClick={() => decide.mutate({ decision: "reject", reason: reason.trim() })}>
								<X /> Reject task
							</Button>
							<Button variant="ghost" onClick={() => setRejecting(false)}>
								Back
							</Button>
						</>
					) : (
						<>
							<Button variant="primary" loading={decide.isPending} disabled={repo !== null && !projectId} onClick={accept}>
								<Check /> {reaccept ? "Re-accept" : "Accept"}
							</Button>
							{reaccept ? null : (
								<Button variant="outline" onClick={() => setRejecting(true)}>
									Reject…
								</Button>
							)}
						</>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
