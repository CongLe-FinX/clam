import { type Project, routes, type SharedInvite } from "@clam/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, CloudDownload, Folder, FolderGit2, FolderPlus, FolderSync, GitBranch, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DirPicker } from "@/components/dir-picker";
import { projectsForRepo } from "@/features/tasks/format";
import { T, msg, t, tr } from "@/i18n";
import { api, errorText } from "@/lib/api";
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
const STATE_NOTE = { accepted: msg("You accepted this invitation."), declined: msg("You declined this invitation.") } as const;

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
								<T text="<b>{who}</b> wants one of your agents to join a shared session. You get a live view of their work and a shared discussion, and you can take over later." params={{ who }} tags={{ b: <span className="font-medium text-foreground" /> }} />
							</p>
							<p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
								<FolderSync className="size-3.5 shrink-0 text-subtle" aria-hidden />
								<T text="<b>Folder sync</b> · no repository" tags={{ b: <span className="font-medium text-foreground" /> }} />
								<FilesInfoButton />
							</p>
						</>
					) : (
						<p className="text-[13px] text-muted-foreground">
							<T
								text="<b>{who}</b> wants one of your agents to join a shared session on <repo>{slug}</repo> (<icon/> Git branch <code>{branch}</code>). You get a live view of their work and a shared discussion, and you can take over later."
								params={{ who, slug, branch: repo?.branch ?? "" }}
								tags={{
									b: <span className="font-medium text-foreground" />,
									repo: <code className="font-mono text-foreground" />,
									icon: <GitBranch className="inline size-3 align-[-1px]" aria-hidden />,
									code: <code className="font-mono" />,
								}}
							/>
						</p>
					)}
				</div>

				{!pending ? (
					<p className="text-xs text-subtle">{invite.state === "accepted" || invite.state === "declined" ? tr(STATE_NOTE[invite.state]) : t("This invitation expired.")}</p>
				) : !files && matches.length === 0 && projects.isSuccess ? (
					<div className="flex flex-col gap-2 rounded-lg bg-surface-2 p-3 text-[13px]">
						<p>
							<T text="No project on this machine is linked to <code>{slug}</code>. The agent needs a local clone to work in." params={{ slug }} tags={{ code: <code className="font-mono" /> }} />
						</p>
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" variant="primary" onClick={() => openDialog({ kind: "create-project", mode: "clone" })}>
								<CloudDownload /> {t("Clone this repo")}
							</Button>
							<span className="text-xs text-subtle">{t("Already cloned it? Link its GitHub repository on the project page, then accept here.")}</span>
						</div>
					</div>
				) : (
					<div className="flex flex-col gap-3">
						<div className="grid gap-3 sm:grid-cols-2">
							{files ? (
								<Field label={t("Where the files land")} hint={target === MANAGED ? t("A managed folder is created for you by CL Agent Mesh.") : target === OTHER_FOLDER ? undefined : t("Files that differ locally are reported, never silently overwritten.")}>
									{() => (
										<Select value={target} onValueChange={setTarget}>
											<SelectTrigger>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value={MANAGED}>
													<span className="inline-flex items-center gap-1.5">
														<FolderPlus className="size-3.5 text-subtle" aria-hidden />
														{t("New managed folder")}
													</span>
												</SelectItem>
												{matches.map((p) => (
													<SelectItem key={p.id} value={p.id}>
														<span className="inline-flex items-center gap-1.5">
															{p.vcs === "git" ? <FolderGit2 className="size-3.5 text-subtle" aria-hidden /> : <Folder className="size-3.5 text-subtle" aria-hidden />}
															{p.name}
															<span className="text-2xs text-subtle">{p.vcs === "git" ? "git" : p.managed ? t("managed folder") : t("folder")}</span>
														</span>
													</SelectItem>
												))}
												<SelectItem value={OTHER_FOLDER}>
													<span className="inline-flex items-center gap-1.5">
														<Folder className="size-3.5 text-subtle" aria-hidden />
														{t("Another folder on this machine…")}
													</span>
												</SelectItem>
											</SelectContent>
										</Select>
									)}
								</Field>
							) : (
								<Field label={t("Work in project")} hint={matches.length > 1 ? t("Several projects match this repository — choose one.") : undefined}>
									{() => (
										<Select value={projectId} onValueChange={setProjectId}>
											<SelectTrigger>
												<SelectValue placeholder={t("Select a project")} />
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
							<Field label={t("Agent")}>
								{() => (
									<Select value={agentId} onValueChange={setAgentId}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={ANY_AGENT}>{t("Any available agent")}</SelectItem>
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
								<Field label={t("Folder")} hint={t("An existing directory on this machine. It is added as a project; nothing in it is overwritten silently.")}>
									{() => <DirPicker value={path} onChange={setPath} />}
								</Field>
								<Field label={t("Project name")}>
									{(id) => (
										<Input
											id={id}
											value={name}
											maxLength={80}
											onChange={(e) => {
												setNameTouched(true);
												setName(e.target.value);
											}}
											placeholder={t("Project name")}
										/>
									)}
								</Field>
							</div>
						) : null}
						{files ? <p className="text-xs text-subtle">{tr(FILES_INFO)}</p> : null}
						{register.error ? (
							<p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
								{errorText(register.error)}
							</p>
						) : null}
					</div>
				)}

				{pending && declining ? (
					<Field label={t("Reason")} hint={t("Optional. Shown to the other machine.")}>
						{(id) => <Input id={id} autoFocus value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} placeholder={t("e.g. I'm busy with a release")} />}
					</Field>
				) : null}

				{pending ? (
					<div className="flex flex-wrap items-center gap-2">
						{declining ? (
							<>
								<Button variant="danger" loading={decide.isPending} onClick={() => decide.mutate({ id: invite.id, body: { decision: "decline", reason: reason.trim() || undefined } })}>
									<X /> {t("Decline")}
								</Button>
								<Button variant="ghost" onClick={() => setDeclining(false)}>
									{t("Back")}
								</Button>
							</>
						) : (
							<>
								<Button variant="primary" loading={busy} disabled={!canAccept} onClick={accept}>
									<Check /> {t("Accept and join")}
								</Button>
								<Button variant="outline" onClick={() => setDeclining(true)} disabled={busy}>
									{t("Decline…")}
								</Button>
							</>
						)}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}
