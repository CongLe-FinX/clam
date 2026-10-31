import { type Project, routes, type SharedInvite } from "@clam/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, CloudDownload, Folder, FolderGit2, FolderPlus, FolderSync, GitBranch, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DirPicker } from "@/components/dir-picker";
import { projectsForRepo } from "@/features/tasks/format";
import { api, errorMessage } from "@/lib/api";
import { qk, useAgents, useProjects } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { basename, relativeTime } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { Field } from "@/ui/field";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { repoLabel } from "./format.ts";
import { useDecideInvite } from "./hooks.ts";
import { FILES_INFO, FilesInfoButton } from "./mode.tsx";

const ANY_AGENT = "__any__";
/** Folder sync targets that are not an existing project. */
const MANAGED = "__managed__";
const OTHER_FOLDER = "__folder__";

/** Participant side: an incoming invitation into a shared session — pick where the work lands and the agent, then accept, or decline. */
export function InviteCard({ invite }: { invite: SharedInvite }) {
	const projects = useProjects();
	const agents = useAgents();
	const qc = useQueryClient();
	const openDialog = useUi((s) => s.openDialog);
	const decide = useDecideInvite();
	const repo = invite.repo;
	const files = invite.vcs === "files" || repo === null;
	// Git: local projects whose linked repository matches. Files: the server's candidates (non-git projects of the invite's workspace),
	// else every local folder-type project.
	const matches = useMemo(() => {
		const all = projects.data ?? [];
		const byId = all.filter((p) => invite.candidateProjectIds.includes(p.id));
		if (files) return byId.length > 0 ? byId : all.filter((p) => p.vcs === "none");
		return byId.length > 0 ? byId : projectsForRepo(repo?.url ?? "", all);
	}, [projects.data, invite.candidateProjectIds, files, repo?.url]);
	const slug = repo ? repoLabel(repo.url) : "";
	const [projectId, setProjectId] = useState("");
	const [target, setTarget] = useState(MANAGED);
	const [path, setPath] = useState("");
	const [name, setName] = useState("");
	const [nameTouched, setNameTouched] = useState(false);
	const [agentId, setAgentId] = useState(invite.agentId ?? ANY_AGENT);
	const [declining, setDeclining] = useState(false);
	const [reason, setReason] = useState("");
	const pending = invite.state === "pending";

	useEffect(() => {
		if (!nameTouched) setName(path ? basename(path) : "");
	}, [path, nameTouched]);

	// A single matching clone is the obvious choice (auto-accept uses the same rule).
	useEffect(() => {
		if (!files && !projectId && matches.length === 1 && matches[0]) setProjectId(matches[0].id);
	}, [files, projectId, matches]);

	// Registers the picked folder as a project (the accept body only knows a project id), then the accept goes out.
	const register = useMutation({
		mutationFn: () => api.post<Project>(routes.projects, { workspaceId: invite.workspaceId, name: name.trim(), path: path.trim() }),
		onSuccess: () => void qc.invalidateQueries({ queryKey: qk.projectsAll }),
	});

	const who = `${invite.from.agentName ? `${invite.from.agentName}@` : ""}${invite.from.nodeName}`;
	const agent = agentId === ANY_AGENT ? undefined : agentId;
	const busy = decide.isPending || register.isPending;
	const folderReady = path.trim() !== "" && name.trim() !== "";
	const canAccept = files ? (target === OTHER_FOLDER ? folderReady : true) : Boolean(projectId);

	const accept = () => {
		const send = (pid: string | undefined) => decide.mutate({ id: invite.id, body: { decision: "accept", projectId: pid, agentId: agent } });
		if (!files) return send(projectId);
		if (target === MANAGED) return send(undefined);
		if (target === OTHER_FOLDER) return register.mutate(undefined, { onSuccess: (p) => send(p.id) });
		return send(target);
	};

	return (
		<Card className={pending ? "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_45%,transparent)]" : undefined}>
			<CardContent className="flex flex-col gap-3.5 pt-4">
				<div className="flex flex-col gap-1">
					<div className="flex items-start gap-2">
						<Users className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
						<h3 className="min-w-0 flex-1 text-sm font-semibold leading-snug">{invite.title}</h3>
						<span className="shrink-0 text-2xs text-subtle">{relativeTime(invite.createdAt)}</span>
					</div>
					{files ? (
						<>
							<p className="text-[13px] text-muted-foreground">
								<span className="font-medium text-foreground">{who}</span> wants one of your agents to join a shared session. You get a live view of their work and a shared discussion, and you can take over later.
							</p>
							<p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
								<FolderSync className="size-3.5 shrink-0 text-subtle" aria-hidden />
								<span className="font-medium text-foreground">Folder sync</span> · no repository
								<FilesInfoButton />
							</p>
						</>
					) : (
						<p className="text-[13px] text-muted-foreground">
							<span className="font-medium text-foreground">{who}</span> wants one of your agents to join a shared session on <code className="font-mono text-foreground">{slug}</code> (
							<GitBranch className="inline size-3 align-[-1px]" aria-hidden /> Git branch <code className="font-mono">{repo?.branch}</code>). You get a live view of their work and a shared discussion, and you can take over later.
						</p>
					)}
				</div>

				{!pending ? (
					<p className="text-xs text-subtle">{invite.state === "accepted" ? "You accepted this invitation." : invite.state === "declined" ? "You declined this invitation." : "This invitation expired."}</p>
				) : !files && matches.length === 0 && projects.isSuccess ? (
					<div className="flex flex-col gap-2 rounded-lg bg-surface-2 p-3 text-[13px]">
						<p>
							No project on this machine is linked to <code className="font-mono">{slug}</code>. The agent needs a local clone to work in.
						</p>
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" variant="primary" onClick={() => openDialog({ kind: "create-project", mode: "clone" })}>
								<CloudDownload /> Clone this repo
							</Button>
							<span className="text-xs text-subtle">Already cloned it? Link its GitHub repository on the project page, then accept here.</span>
						</div>
					</div>
				) : (
					<div className="flex flex-col gap-3">
						<div className="grid gap-3 sm:grid-cols-2">
							{files ? (
								<Field label="Where the files land" hint={target === MANAGED ? "A managed folder is created for you by CL Agent Mesh." : target === OTHER_FOLDER ? undefined : "Files that differ locally are reported, never silently overwritten."}>
									{() => (
										<Select value={target} onValueChange={setTarget}>
											<SelectTrigger>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value={MANAGED}>
													<span className="inline-flex items-center gap-1.5">
														<FolderPlus className="size-3.5 text-subtle" aria-hidden />
														New managed folder
													</span>
												</SelectItem>
												{matches.map((p) => (
													<SelectItem key={p.id} value={p.id}>
														<span className="inline-flex items-center gap-1.5">
															{p.vcs === "git" ? <FolderGit2 className="size-3.5 text-subtle" aria-hidden /> : <Folder className="size-3.5 text-subtle" aria-hidden />}
															{p.name}
															<span className="text-2xs text-subtle">{p.vcs === "git" ? "git" : p.managed ? "managed folder" : "folder"}</span>
														</span>
													</SelectItem>
												))}
												<SelectItem value={OTHER_FOLDER}>
													<span className="inline-flex items-center gap-1.5">
														<Folder className="size-3.5 text-subtle" aria-hidden />
														Another folder on this machine…
													</span>
												</SelectItem>
											</SelectContent>
										</Select>
									)}
								</Field>
							) : (
								<Field label="Work in project" hint={matches.length > 1 ? "Several projects match this repository — choose one." : undefined}>
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
							)}
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
													<span className="inline-flex items-center gap-1.5">
														<Bot className="size-3.5 text-subtle" aria-hidden />
														{a.name}
													</span>
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							</Field>
						</div>
						{files && target === OTHER_FOLDER ? (
							<div className="grid gap-3 sm:grid-cols-2">
								<Field label="Folder" hint="An existing directory on this machine. It is added as a project; nothing in it is overwritten silently.">
									{() => <DirPicker value={path} onChange={setPath} />}
								</Field>
								<Field label="Project name">
									{(id) => (
										<Input
											id={id}
											value={name}
											maxLength={80}
											onChange={(e) => {
												setNameTouched(true);
												setName(e.target.value);
											}}
											placeholder="Project name"
										/>
									)}
								</Field>
							</div>
						) : null}
						{files ? <p className="text-xs text-subtle">{FILES_INFO}</p> : null}
						{register.error ? (
							<p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
								{errorMessage(register.error)}
							</p>
						) : null}
					</div>
				)}

				{pending && declining ? (
					<Field label="Reason" hint="Optional. Shown to the other machine.">
						{(id) => <Input id={id} autoFocus value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} placeholder="e.g. I'm busy with a release" />}
					</Field>
				) : null}

				{pending ? (
					<div className="flex flex-wrap items-center gap-2">
						{declining ? (
							<>
								<Button variant="danger" loading={decide.isPending} onClick={() => decide.mutate({ id: invite.id, body: { decision: "decline", reason: reason.trim() || undefined } })}>
									<X /> Decline
								</Button>
								<Button variant="ghost" onClick={() => setDeclining(false)}>
									Back
								</Button>
							</>
						) : (
							<>
								<Button variant="primary" loading={busy} disabled={!canAccept} onClick={accept}>
									<Check /> Accept and join
								</Button>
								<Button variant="outline" onClick={() => setDeclining(true)} disabled={busy}>
									Decline…
								</Button>
							</>
						)}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}
