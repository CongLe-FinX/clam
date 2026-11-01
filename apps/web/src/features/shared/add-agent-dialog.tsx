import type { Capability, SharedSession } from "@clam/contracts";
import { GitBranch, Info, ShieldAlert, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PeerStatusBadge } from "@/features/network/components";
import { useUpdatePeer } from "@/features/network/hooks";
import { T, msg, t, tr } from "@/i18n";
import { errorText } from "@/lib/api";
import { PEER_STATUS_LABEL } from "@/features/network/format";
import { useDirectory, usePeers, useProject } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Field } from "@/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { StatusDot } from "@/ui/status-dot";
import { useAddParticipant } from "./hooks.ts";
import { teamOf } from "./format.ts";
import { ModeNote, projectShareMode, type ShareMode } from "./mode.tsx";

const AGENT_STATUS = { online: msg("Online"), busy: msg("Busy"), offline: msg("Offline") } as const;
const ADD_FILES_COPY = msg("The working folder travels machine to machine as a bundle together with the session snapshot; nothing needs a Git repository. Every checkpoint bundles the working folder; the other machine applies it into a local folder (a managed folder is created for you, or it picks an existing local folder when it accepts) — files that differ locally are reported, never silently overwritten.");
const ANY = "__any__";
const SHARE: Capability = "sessions.share";

/** Driver side: pick an agent@node from the Agent Directory and invite it into this session (the first invite turns the session into a shared one). */
export default function AddAgentDialog({ sessionId, projectId, shared, onClose, onAdded }: { sessionId: string; projectId: string; shared: SharedSession | null; onClose: () => void; onAdded?: (s: SharedSession) => void }) {
	const openDialog = useUi((s) => s.openDialog);
	const peers = usePeers();
	const directory = useDirectory();
	const project = useProject(projectId).data;
	const add = useAddParticipant(sessionId);
	const updatePeer = useUpdatePeer();

	const inTeam = useMemo(() => new Set(shared ? teamOf(shared).map((p) => p.nodeId) : []), [shared]);
	const usable = useMemo(() => (peers.data ?? []).filter((p) => p.status !== "revoked"), [peers.data]);
	const [peerId, setPeerId] = useState("");
	const [agentKey, setAgentKey] = useState(ANY);

	useEffect(() => {
		if (peerId) return;
		const first = usable.filter((p) => !inTeam.has(p.id));
		if (first.length === 1 && first[0]) setPeerId(first[0].id);
	}, [peerId, usable, inTeam]);

	const peer = usable.find((p) => p.id === peerId);
	const agents = useMemo(() => (directory.data ?? []).filter((a) => a.nodeId === peerId).sort((a, b) => a.name.localeCompare(b.name)), [directory.data, peerId]);
	useEffect(() => {
		if (agentKey !== ANY && directory.isSuccess && !agents.some((a) => a.agentId === agentKey)) setAgentKey(ANY);
	}, [agentKey, agents, directory.isSuccess]);

	const theyAllow = peer ? peer.receivedCapabilities.includes(SHARE) : true;
	const weAllow = peer ? peer.grantedCapabilities.includes(SHARE) : true;
	const mode: ShareMode | null = shared ? shared.vcs : project ? projectShareMode(project) : null;
	const ready = Boolean(peer);
	const noNodes = peers.isSuccess && usable.length === 0;

	const submit = () => {
		if (!ready || !peer) return;
		add.mutate(
			{ nodeId: peer.id, agentId: agentKey === ANY ? undefined : agentKey },
			{
				onSuccess: (s) => {
					const a = agents.find((x) => x.agentId === agentKey);
					toast.success(t("Invited {name}", { name: `${a ? `${a.name}@` : ""}${peer.name}` }), { description: t("It joins as soon as that machine accepts. You can follow it in the Team tab.") });
					onAdded?.(s);
					onClose();
				},
			},
		);
	};

	return (
		<Dialog open onOpenChange={(o) => !o && !add.isPending && onClose()}>
			<DialogContent sheetOnMobile className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("Add an agent to this session")}</DialogTitle>
					<DialogDescription>
						{t("An agent on another machine joins your work: it follows this conversation live, works in its own clone or folder, and discusses with you and your agent in a shared thread. This session keeps being driven here; the other machine can continue it if this one goes offline.")}
					</DialogDescription>
				</DialogHeader>
				<form
					className="scrollbar-thin -mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1"
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					{noNodes ? (
						<div role="status" className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-[13px] text-muted-foreground">
							<Info className="mt-0.5 size-4 shrink-0" aria-hidden />
							<span>
								<T
									text="No machine is paired with this one yet. <invite>Invite a machine</invite> or <join>join one</join>."
									tags={{
										invite: (c) => (
											<button type="button" className="text-accent hover:underline" onClick={() => openDialog({ kind: "invite-node" })}>
												{c}
											</button>
										),
										join: (c) => (
											<button type="button" className="text-accent hover:underline" onClick={() => openDialog({ kind: "join-node" })}>
												{c}
											</button>
										),
									}}
								/>
							</span>
						</div>
					) : null}
					<div className="grid gap-3 sm:grid-cols-2">
						<Field label={t("Machine")}>
							{() => (
								<Select value={peerId} onValueChange={setPeerId} disabled={noNodes}>
									<SelectTrigger>
										<SelectValue placeholder={t("Choose a machine")} />
									</SelectTrigger>
									<SelectContent>
										{usable.map((p) => (
											<SelectItem key={p.id} value={p.id} disabled={inTeam.has(p.id)}>
												<span className="inline-flex items-center gap-2">
													<StatusDot status={p.status === "online" ? "online" : p.status === "degraded" ? "degraded" : "offline"} label={tr(PEER_STATUS_LABEL[p.status])} />
													{p.name}
													{inTeam.has(p.id) ? <span className="text-2xs text-subtle">{t("already in the team")}</span> : null}
												</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</Field>
						<Field label={t("Agent")} hint={t("Leave on “any” to let that machine choose.")}>
							{() => (
								<Select value={agentKey} onValueChange={setAgentKey} disabled={!peer}>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={ANY}>{t("Any available agent")}</SelectItem>
										{agents.map((a) => (
											<SelectItem key={a.agentId} value={a.agentId}>
												<span className="inline-flex items-center gap-2">
													<StatusDot status={a.status} />
													{a.name}
													<span className="text-2xs text-subtle">{tr(AGENT_STATUS[a.status])}</span>
												</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</Field>
					</div>

					{peer && peer.status !== "online" ? (
						<p role="status" className="flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
							<PeerStatusBadge status={peer.status} />
							{t("{name} is not reachable right now, so the invitation cannot be delivered yet.", { name: peer.name })}
						</p>
					) : null}
					{peer && !theyAllow ? (
						<div role="alert" className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-xs text-danger">
							<ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
							<span>
								<T
									text="{name} has not allowed this machine to share sessions with it (<code>sessions.share</code>). Ask its owner to grant it under Machines → {name}'s permissions for this machine; the invitation will be refused until then."
									params={{ name: peer.name }}
									tags={{ code: <code className="font-mono" /> }}
								/>
							</span>
						</div>
					) : null}
					{peer && !weAllow ? (
						<div role="alert" className="flex flex-col gap-2 rounded-lg bg-warning/10 px-3 py-2.5 text-xs text-warning">
							<span className="flex items-start gap-2">
								<ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
								<span>
									<T
										text="{name} is not allowed to share sessions with this machine yet (<code>sessions.share</code>, not granted by default). It needs that to send its mirror updates, discussion messages and to take over."
										params={{ name: peer.name }}
										tags={{ code: <code className="font-mono" /> }}
									/>
								</span>
							</span>
							<Button
								type="button"
								size="sm"
								variant="outline"
								className="self-start"
								loading={updatePeer.isPending}
								onClick={() => updatePeer.mutate({ id: peer.id, grantedCapabilities: [...peer.grantedCapabilities, SHARE] }, { onSuccess: () => toast.success(t("{name} may now share sessions with this machine", { name: peer.name })) })}
							>
								{t("Grant sessions.share to {name}", { name: peer.name })}
							</Button>
						</div>
					) : null}
					{mode === "files" ? (
						<ModeNote
							mode="files"
							copy={{ files: ADD_FILES_COPY }}
						/>
					) : mode === "git" && project?.repository ? (
						<p className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-xs text-muted-foreground">
							<GitBranch className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
							<span>
								<T
									text="<b>Git branch.</b> The team works on <code>{repo}</code>. A shared branch is created from the project's current HEAD and pushed with this machine's GitHub account."
									params={{ repo: `${project.repository.owner}/${project.repository.name}` }}
									tags={{ b: <strong className="font-medium text-foreground" />, code: <code className="font-mono" /> }}
								/>
							</span>
						</p>
					) : null}

					{add.error ? (
						<p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
							{errorText(add.error)}
						</p>
					) : null}
					<DialogFooter className="sticky bottom-0 -mx-1 bg-overlay px-1 pt-1">
						<Button type="button" variant="ghost" onClick={onClose} disabled={add.isPending}>
							{t("Cancel")}
						</Button>
						<Button type="submit" variant="primary" loading={add.isPending} disabled={!ready}>
							<UserPlus /> {t("Add to session")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
