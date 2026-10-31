import { CloudDownload, Info, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PeerStatusBadge } from "@/features/network/components";
import { errorMessage } from "@/lib/api";
import { useDirectory, usePeers, useProjects } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Field } from "@/ui/field";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { StatusDot } from "@/ui/status-dot";
import { Textarea } from "@/ui/textarea";
import { APPROVAL_MODES } from "./format.ts";
import { useCreateTask } from "./hooks.ts";

const ANY = "__any__";
const DEFAULT_APPROVAL = "__default__";

export interface DelegatePreset {
	workspaceId?: string;
	projectId?: string;
	peerId?: string;
	agentId?: string;
}

export default function DelegateDialog({ preset, onClose }: { preset: DelegatePreset; onClose: () => void }) {
	const openDialog = useUi((s) => s.openDialog);
	const peers = usePeers();
	const directory = useDirectory();
	const projects = useProjects();
	const create = useCreateTask();

	const usablePeers = useMemo(() => (peers.data ?? []).filter((p) => p.status !== "revoked"), [peers.data]);
	const [peerId, setPeerId] = useState(preset.peerId ?? "");
	const [agentKey, setAgentKey] = useState(preset.agentId ?? ANY);
	const [projectId, setProjectId] = useState(preset.projectId ?? "");
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [deliverAs, setDeliverAs] = useState<"branch" | "summary">("branch");
	const [baseBranch, setBaseBranch] = useState("");
	const [maxCost, setMaxCost] = useState("");
	const [approval, setApproval] = useState(DEFAULT_APPROVAL);

	useEffect(() => {
		if (!peerId && usablePeers.length === 1 && usablePeers[0]) setPeerId(usablePeers[0].id);
	}, [peerId, usablePeers]);

	const peer = usablePeers.find((p) => p.id === peerId);
	const agents = useMemo(() => (directory.data ?? []).filter((a) => a.nodeId === peerId).sort((a, b) => a.name.localeCompare(b.name)), [directory.data, peerId]);
	useEffect(() => {
		// A preselected agent that is not on the chosen node (or no longer listed) falls back to "any".
		if (agentKey !== ANY && directory.isSuccess && !agents.some((a) => a.agentId === agentKey)) setAgentKey(ANY);
	}, [agentKey, agents, directory.isSuccess]);

	const linked = useMemo(() => (projects.data ?? []).filter((p) => p.repository !== null), [projects.data]);
	useEffect(() => {
		if (!projectId && linked.length > 0) {
			const inWs = preset.workspaceId ? linked.find((p) => p.workspaceId === preset.workspaceId) : undefined;
			setProjectId((inWs ?? (linked.length === 1 ? linked[0] : undefined))?.id ?? "");
		}
	}, [projectId, linked, preset.workspaceId]);
	const project = projects.data?.find((p) => p.id === projectId);

	const cannotSend = peer !== undefined && !peer.receivedCapabilities.includes("tasks.send");
	const cost = maxCost.trim() === "" ? undefined : Number(maxCost);
	const costInvalid = cost !== undefined && !(cost > 0 && cost <= 1000);
	const ready = Boolean(peer && project?.repository && title.trim() && description.trim() && !cannotSend && !costInvalid);

	const submit = () => {
		if (!ready || !peer) return;
		create.mutate(
			{
				targetNodeId: peer.id,
				targetAgentId: agentKey === ANY ? undefined : agentKey,
				projectId,
				title: title.trim(),
				description: description.trim(),
				deliverAs,
				baseBranch: baseBranch.trim() || undefined,
				constraints: {
					...(cost !== undefined ? { maxCostUsd: cost } : {}),
					...(approval !== DEFAULT_APPROVAL ? { approvalMode: approval as (typeof APPROVAL_MODES)[number]["value"] } : {}),
				},
			},
			{ onSuccess: onClose },
		);
	};

	const noNodes = peers.isSuccess && usablePeers.length === 0;
	return (
		<Dialog open onOpenChange={(o) => !o && !create.isPending && onClose()}>
			<DialogContent sheetOnMobile className="max-w-xl">
				<DialogHeader>
					<DialogTitle>Delegate a task</DialogTitle>
					<DialogDescription>An agent on another node does the work in its own clone of the project's GitHub repository and reports back. You can follow and discuss it on the task page.</DialogDescription>
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
								No node is paired with this one yet.{" "}
								<button type="button" className="text-accent hover:underline" onClick={() => openDialog({ kind: "invite-node" })}>
									Invite a node
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
						<Field label="Node">
							{() => (
								<Select value={peerId} onValueChange={setPeerId} disabled={noNodes}>
									<SelectTrigger>
										<SelectValue placeholder="Choose a node" />
									</SelectTrigger>
									<SelectContent>
										{usablePeers.map((p) => (
											<SelectItem key={p.id} value={p.id}>
												<span className="inline-flex items-center gap-2">
													<StatusDot status={p.status === "online" ? "online" : p.status === "degraded" ? "degraded" : "offline"} label={p.status} />
													{p.name}
												</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</Field>
						<Field label="Agent" hint="Leave on “any” to let the node pick.">
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
							{peer.name} is not reachable right now. The task is stored on this node and will be delivered when it is online.
						</p>
					) : null}
					{cannotSend ? (
						<p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
							{peer?.name} has not allowed this node to send tasks. Ask its owner to grant “tasks.send”.
						</p>
					) : null}

					<Field label="Project" hint="The executor works in its own clone of this project's GitHub repository.">
						{() => (
							<Select value={projectId} onValueChange={setProjectId}>
								<SelectTrigger>
									<SelectValue placeholder={linked.length === 0 ? "No project has a GitHub repository" : "Choose a project"} />
								</SelectTrigger>
								<SelectContent>
									{(projects.data ?? []).map((p) => (
										<SelectItem key={p.id} value={p.id} disabled={!p.repository}>
											<span className="inline-flex items-center gap-2">
												{p.name}
												<span className="font-mono text-2xs text-subtle">{p.repository ? `${p.repository.owner}/${p.repository.name}` : "no GitHub repository"}</span>
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					</Field>
					{projects.isSuccess && linked.length === 0 ? (
						<div role="status" className="flex flex-col gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-[13px]">
							<p className="text-muted-foreground">Delegated work happens on a GitHub repository, so the task's project needs a linked repository. Clone one, or link an existing project's repository on its page.</p>
							<Button size="sm" variant="outline" className="self-start" onClick={() => openDialog({ kind: "create-project", workspaceId: preset.workspaceId, mode: "clone" })}>
								<CloudDownload /> Clone from GitHub
							</Button>
						</div>
					) : null}

					<Field label="Title">{(id) => <Input id={id} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Add input validation to the signup form" />}</Field>
					<Field label="Instructions" hint="Markdown supported. Say what “done” looks like.">
						{(id) => <Textarea id={id} value={description} maxLength={50_000} rows={6} onChange={(e) => setDescription(e.target.value)} placeholder="What should the agent do? Include context, constraints and acceptance criteria." />}
					</Field>

					<div className="grid gap-3 sm:grid-cols-2">
						<Field label="Deliver as">
							{() => (
								<div role="radiogroup" aria-label="Deliver as" className="flex rounded-lg bg-surface-2 p-0.5 text-xs font-medium">
									{(
										[
											["branch", "Branch"],
											["summary", "Summary only"],
										] as const
									).map(([id, label]) => (
										<button
											key={id}
											type="button"
											role="radio"
											aria-checked={deliverAs === id}
											onClick={() => setDeliverAs(id)}
											className={cn(
												"inline-flex h-7 flex-1 items-center justify-center rounded-md px-3 outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-10",
												deliverAs === id ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:text-foreground",
											)}
										>
											{label}
										</button>
									))}
								</div>
							)}
						</Field>
						<Field label="Base branch" hint={deliverAs === "branch" ? "The task branch starts from here." : "Where the agent starts reading."}>
							{(id) => <Input id={id} value={baseBranch} maxLength={200} onChange={(e) => setBaseBranch(e.target.value)} placeholder={project?.repository?.defaultBranch ?? "repository default"} className="font-mono text-xs" />}
						</Field>
					</div>
					<p className="-mt-2 text-xs text-subtle">
						{deliverAs === "branch" ? "The executor commits its changes to a new task branch and pushes it with its own GitHub account; you get a compare link and can open a pull request." : "The executor answers with a written summary and does not change git."}
					</p>

					<div className="grid gap-3 sm:grid-cols-2">
						<Field label="Max cost (USD)" hint="Optional. The run stops at this spend." error={costInvalid ? "Enter an amount between 0 and 1000." : null}>
							{(id) => <Input id={id} inputMode="decimal" type="number" min="0" max="1000" step="0.01" value={maxCost} onChange={(e) => setMaxCost(e.target.value)} placeholder="no limit" aria-invalid={costInvalid || undefined} />}
						</Field>
						<Field label="Approval mode" hint="The executor may only be stricter than its own setting.">
							{() => (
								<Select value={approval} onValueChange={setApproval}>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={DEFAULT_APPROVAL}>Executor's setting</SelectItem>
										{APPROVAL_MODES.map((m) => (
											<SelectItem key={m.value} value={m.value}>
												{m.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</Field>
					</div>

					{create.error ? (
						<p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
							{errorMessage(create.error)}
						</p>
					) : null}
					<DialogFooter className="sticky bottom-0 -mx-1 bg-overlay px-1 pt-1">
						<Button variant="ghost" onClick={onClose} disabled={create.isPending}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" loading={create.isPending} disabled={!ready}>
							<Send /> Delegate
							{peer && peer.status !== "online" ? <Badge variant="warning">queued</Badge> : null}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
