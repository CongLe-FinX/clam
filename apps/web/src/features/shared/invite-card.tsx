import type { SharedInvite } from "@clam/contracts";
import { Bot, Check, CloudDownload, FolderGit2, GitBranch, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { projectsForRepo } from "@/features/tasks/format";
import { repoLabel } from "./format.ts";
import { useAgents, useProjects } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { relativeTime } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { Field } from "@/ui/field";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { useDecideInvite } from "./hooks.ts";

const ANY_AGENT = "__any__";

/** Participant side: an incoming invitation into a shared session — pick the local clone and agent, then accept, or decline. */
export function InviteCard({ invite }: { invite: SharedInvite }) {
	const projects = useProjects();
	const agents = useAgents();
	const openDialog = useUi((s) => s.openDialog);
	const decide = useDecideInvite();
	const matches = useMemo(() => {
		const byId = (projects.data ?? []).filter((p) => invite.candidateProjectIds.includes(p.id));
		return byId.length > 0 ? byId : projectsForRepo(invite.repo.url, projects.data ?? []);
	}, [projects.data, invite.candidateProjectIds, invite.repo.url]);
	const slug = repoLabel(invite.repo.url);
	const [projectId, setProjectId] = useState("");
	const [agentId, setAgentId] = useState(invite.agentId ?? ANY_AGENT);
	const [declining, setDeclining] = useState(false);
	const [reason, setReason] = useState("");
	const pending = invite.state === "pending";

	// A single matching clone is the obvious choice (auto-accept uses the same rule).
	useEffect(() => {
		if (!projectId && matches.length === 1 && matches[0]) setProjectId(matches[0].id);
	}, [projectId, matches]);

	const who = `${invite.from.agentName ? `${invite.from.agentName}@` : ""}${invite.from.nodeName}`;
	return (
		<Card className={pending ? "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_45%,transparent)]" : undefined}>
			<CardContent className="flex flex-col gap-3.5 pt-4">
				<div className="flex flex-col gap-1">
					<div className="flex items-start gap-2">
						<Users className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
						<h3 className="min-w-0 flex-1 text-sm font-semibold leading-snug">{invite.title}</h3>
						<span className="shrink-0 text-2xs text-subtle">{relativeTime(invite.createdAt)}</span>
					</div>
					<p className="text-[13px] text-muted-foreground">
						<span className="font-medium text-foreground">{who}</span> wants one of your agents to join a shared session on <code className="font-mono text-foreground">{slug}</code> (
						<GitBranch className="inline size-3 align-[-1px]" aria-hidden /> <code className="font-mono">{invite.repo.branch}</code>). You get a live view of their work and a shared discussion, and you can take over later.
					</p>
				</div>

				{!pending ? (
					<p className="text-xs text-subtle">{invite.state === "accepted" ? "You accepted this invitation." : invite.state === "declined" ? "You declined this invitation." : "This invitation expired."}</p>
				) : matches.length === 0 && projects.isSuccess ? (
					<div className="flex flex-col gap-2 rounded-lg bg-surface-2 p-3 text-[13px]">
						<p>
							No project on this node is linked to <code className="font-mono">{slug}</code>. The agent needs a local clone to work in.
						</p>
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" variant="primary" onClick={() => openDialog({ kind: "create-project", mode: "clone" })}>
								<CloudDownload /> Clone this repo
							</Button>
							<span className="text-xs text-subtle">Already cloned it? Link its GitHub repository on the project page, then accept here.</span>
						</div>
					</div>
				) : (
					<div className="grid gap-3 sm:grid-cols-2">
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
				)}

				{pending && declining ? (
					<Field label="Reason" hint="Optional. Shown to the other node.">
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
								<Button variant="primary" loading={decide.isPending} disabled={!projectId} onClick={() => decide.mutate({ id: invite.id, body: { decision: "accept", projectId, agentId: agentId === ANY_AGENT ? undefined : agentId } })}>
									<Check /> Accept and join
								</Button>
								<Button variant="outline" onClick={() => setDeclining(true)}>
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
