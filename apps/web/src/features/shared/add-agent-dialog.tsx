import type { Capability, SharedSession } from "@clam/contracts";
import { GitBranch, Info, ShieldAlert, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PeerStatusBadge } from "@/features/network/components";
import { useUpdatePeer } from "@/features/network/hooks";
import { errorMessage } from "@/lib/api";
import { useDirectory, usePeers, useProject } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Field } from "@/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { StatusDot } from "@/ui/status-dot";
import { useAddParticipant } from "./hooks.ts";
import { teamOf } from "./format.ts";
import { FILES_INFO, ModeNote, projectShareMode, type ShareMode } from "./mode.tsx";

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
					toast.success(`Invited ${a ? `${a.name}@` : ""}${peer.name}`, { description: "It joins as soon as that machine accepts. You can follow it in the Team tab." });
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
					<DialogTitle>Add an agent to this session</DialogTitle>
					<DialogDescription>
						An agent on another machine joins your work: it follows this conversation live, works in its own clone or folder, and discusses with you and your agent in a shared thread. This session keeps being driven here; the other machine can continue it if this one goes offline.
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
								No machine is paired with this one yet.{" "}
								<button type="button" className="text-accent hover:underline" onClick={() => openDialog({ kind: "invite-node" })}>
									Invite a machine
								</button>{" "}
								or{" "}
								<button type="button" className="text-accent hover:underline" onClick={() => openDialog({ kind: "join-node" })}>
									join one
								</button>
								.
							</span>
						</div>
					) : null}
					<div className="grid gap-3 sm:grid-cols-2">
						<Field label="Machine">
							{() => (
								<Select value={peerId} onValueChange={setPeerId} disabled={noNodes}>
									<SelectTrigger>
										<SelectValue placeholder="Choose a machine" />
									</SelectTrigger>
									<SelectContent>
										{usable.map((p) => (
											<SelectItem key={p.id} value={p.id} disabled={inTeam.has(p.id)}>
												<span className="inline-flex items-center gap-2">
													<StatusDot status={p.status === "online" ? "online" : p.status === "degraded" ? "degraded" : "offline"} label={p.status} />
													{p.name}
													{inTeam.has(p.id) ? <span className="text-2xs text-subtle">already in the team</span> : null}
												</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</Field>
						<Field label="Agent" hint="Leave on “any” to let that machine choose.">
							{() => (
								<Select value={agentKey} onValueChange={setAgentKey} disabled={!peer}>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={ANY}>Any available agent</SelectItem>
										{agents.map((a) => (
											<SelectItem key={a.agentId} value={a.agentId}>
												<span className="inline-flex items-center gap-2">
													<StatusDot status={a.status} label={a.status} />
													{a.name}
													<span className="text-2xs text-subtle">{a.status}</span>
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
							{peer.name} is not reachable right now, so the invitation cannot be delivered yet.
						</p>
					) : null}
					{peer && !theyAllow ? (
						<div role="alert" className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-xs text-danger">
							<ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
							<span>
								{peer.name} has not allowed this machine to share sessions with it (<code className="font-mono">sessions.share</code>). Ask its owner to grant it under Machines → {peer.name}'s permissions for this machine; the invitation will be refused until then.
							</span>
						</div>
					) : null}
					{peer && !weAllow ? (
						<div role="alert" className="flex flex-col gap-2 rounded-lg bg-warning/10 px-3 py-2.5 text-xs text-warning">
							<span className="flex items-start gap-2">
								<ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
								<span>
									{peer.name} is not allowed to share sessions with this machine yet (<code className="font-mono">sessions.share</code>, not granted by default). It needs that to send its mirror updates, discussion messages and to take over.
								</span>
							</span>
							<Button
								type="button"
								size="sm"
								variant="outline"
								className="self-start"
								loading={updatePeer.isPending}
								onClick={() => updatePeer.mutate({ id: peer.id, grantedCapabilities: [...peer.grantedCapabilities, SHARE] }, { onSuccess: () => toast.success(`${peer.name} may now share sessions with this machine`) })}
							>
								Grant sessions.share to {peer.name}
							</Button>
						</div>
					) : null}
					{mode === "files" ? (
						<ModeNote
							mode="files"
							copy={{ git: "", files: `${FILES_INFO} Every checkpoint bundles the working folder; the other machine applies it into a local folder (a managed folder is created for you, or it picks an existing local folder when it accepts) — files that differ locally are reported, never silently overwritten.` }}
						/>
					) : mode === "git" && project?.repository ? (
						<p className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-xs text-muted-foreground">
							<GitBranch className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
							<span>
								<strong className="font-medium text-foreground">Git branch.</strong> The team works on <code className="font-mono">{project.repository.owner}/{project.repository.name}</code>. A shared branch is created from the project's current HEAD and pushed with this machine's GitHub account.
							</span>
						</p>
					) : null}

					{add.error ? (
						<p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
							{errorMessage(add.error)}
						</p>
					) : null}
					<DialogFooter className="sticky bottom-0 -mx-1 bg-overlay px-1 pt-1">
						<Button type="button" variant="ghost" onClick={onClose} disabled={add.isPending}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" loading={add.isPending} disabled={!ready}>
							<UserPlus /> Add to session
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
