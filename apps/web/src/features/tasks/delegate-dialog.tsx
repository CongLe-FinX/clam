import type { Project, TaskDeliverAs } from "@clam/contracts";
import { Info, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PeerStatusBadge } from "@/features/network/components";
import { PEER_STATUS_LABEL } from "@/features/network/format";
import { msg, T, t, tr, type Msg } from "@/i18n";
import { errorText } from "@/lib/api";
import { useDirectory, usePeers, useProjects, useWorkspaces } from "@/lib/queries";
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
import { InputFilesPicker } from "./input-files-picker.tsx";

const ANY = "__any__";
const NO_PROJECT = "__none__";
const DEFAULT_APPROVAL = "__default__";

const AGENT_STATUS_LABEL = { online: msg("Online"), busy: msg("Busy"), offline: msg("Offline") } as const;

const projectKind = (p: Project) => (p.repository ? `${p.repository.owner}/${p.repository.name}` : p.vcs === "git" ? t("git · no GitHub repository") : p.managed ? t("managed folder") : t("folder"));

const DELIVER_OPTIONS: ReadonlyArray<{ id: TaskDeliverAs; label: Msg; hint: Msg }> = [
	{ id: "branch", label: msg("Branch"), hint: msg("The executor works on a task branch of the project's GitHub repository and pushes it. You get a compare link.") },
	{ id: "files", label: msg("Files"), hint: msg("The executor works in its own folder and returns the changed files as a bundle. You preview and apply them.") },
	{ id: "summary", label: msg("Summary"), hint: msg("The executor answers with a written summary; no files come back.") },
];

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
	const workspaces = useWorkspaces();
	const create = useCreateTask();

	const usablePeers = useMemo(() => (peers.data ?? []).filter((p) => p.status !== "revoked"), [peers.data]);
	const [peerId, setPeerId] = useState(preset.peerId ?? "");
	const [agentKey, setAgentKey] = useState(preset.agentId ?? ANY);
	const [projectId, setProjectId] = useState(preset.projectId ?? "");
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [deliverPick, setDeliverPick] = useState<TaskDeliverAs | null>(null);
	const [wsPick, setWsPick] = useState("");
	const [inputPaths, setInputPaths] = useState<string[]>([]);
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

	const project = projects.data?.find((p) => p.id === projectId);
	const sortedProjects = useMemo(() => [...(projects.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [projects.data]);
	const branchOk = Boolean(project?.repository);
	// The default follows the chosen project until the user picks one explicitly (and a branch pick needs a linked repository).
	const deliverAs: TaskDeliverAs = deliverPick && (deliverPick !== "branch" || branchOk) ? deliverPick : branchOk ? "branch" : "files";
	const changeProject = (value: string) => {
		setProjectId(value === NO_PROJECT ? "" : value);
		setInputPaths([]);
	};
	const workspaceId = wsPick && workspaces.data?.some((w) => w.id === wsPick) ? wsPick : (workspaces.data?.find((w) => w.id === preset.workspaceId)?.id ?? workspaces.data?.[0]?.id ?? "");

	const cannotSend = peer !== undefined && !peer.receivedCapabilities.includes("tasks.send");
	const cost = maxCost.trim() === "" ? undefined : Number(maxCost);
	const costInvalid = cost !== undefined && !(cost > 0 && cost <= 1000);
	const ready = Boolean(peer && title.trim() && description.trim() && !cannotSend && !costInvalid && (deliverAs !== "branch" || branchOk) && (projectId !== "" || workspaceId !== ""));

	const submit = () => {
		if (!ready || !peer) return;
		create.mutate(
			{
				targetNodeId: peer.id,
				targetAgentId: agentKey === ANY ? undefined : agentKey,
				projectId: projectId || undefined,
				workspaceId: projectId ? undefined : workspaceId || undefined,
				title: title.trim(),
				description: description.trim(),
				deliverAs,
				inputPaths: projectId && inputPaths.length > 0 ? inputPaths : undefined,
				baseBranch: deliverAs === "branch" ? baseBranch.trim() || undefined : undefined,
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
					<DialogTitle>{t("Delegate a task")}</DialogTitle>
					<DialogDescription>{t("An agent on another machine does the work and reports back. Send it a project's files, or start it in a fresh folder. You can follow and discuss it on the task page.")}</DialogDescription>
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
							<T
								text="No machine is paired with this one yet. <invite>Invite a machine</invite> or <join>join one</join>."
								tags={{
									invite: (children) => (
										<button type="button" className="text-accent hover:underline" onClick={() => openDialog({ kind: "invite-node" })}>
											{children}
										</button>
									),
									join: (children) => (
										<button type="button" className="text-accent hover:underline" onClick={() => openDialog({ kind: "join-node" })}>
											{children}
										</button>
									),
								}}
							/>
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
										{usablePeers.map((p) => (
											<SelectItem key={p.id} value={p.id}>
												<span className="inline-flex items-center gap-2">
													<StatusDot status={p.status === "online" ? "online" : p.status === "degraded" ? "degraded" : "offline"} label={tr(PEER_STATUS_LABEL[p.status])} />
													{p.name}
												</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</Field>
						<Field label={t("Agent")} hint={t("Leave on “any” to let the machine pick.")}>
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
													<StatusDot status={a.status} label={tr(AGENT_STATUS_LABEL[a.status])} />
													{a.name}
													<span className="text-2xs text-subtle">{tr(AGENT_STATUS_LABEL[a.status])}</span>
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
							{t("{name} is not reachable right now. The task is stored on this machine and will be delivered when it is online.", { name: peer.name })}
						</p>
					) : null}
					{cannotSend ? (
						<p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
							{t("{name} has not allowed this machine to send tasks. Ask its owner to grant “tasks.send”.", { name: peer?.name ?? "" })}
						</p>
					) : null}

					<Field label={t("Project")} hint={t("Optional. Any local project works, with or without Git.")}>
						{() => (
							<Select value={projectId || NO_PROJECT} onValueChange={changeProject}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={NO_PROJECT}>{t("No project — run in a fresh folder on the executor")}</SelectItem>
									{sortedProjects.map((p) => (
										<SelectItem key={p.id} value={p.id}>
											<span className="inline-flex items-center gap-2">
												{p.name}
												<span className="font-mono text-2xs text-subtle">{projectKind(p)}</span>
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					</Field>
					{projects.isError ? (
						<p role="alert" className="flex items-center gap-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
							<span className="min-w-0 flex-1">{errorText(projects.error)}</span>
							<Button type="button" size="sm" variant="ghost" onClick={() => void projects.refetch()}>
								{t("Retry")}
							</Button>
						</p>
					) : null}
					{projectId ? (
						<div className="flex flex-col gap-1.5">
							<span className="text-[13px] font-medium">{t("Input files")}</span>
							<InputFilesPicker projectId={projectId} value={inputPaths} onChange={setInputPaths} />
						</div>
					) : null}
					{!projectId && (workspaces.data?.length ?? 0) > 0 ? (
						<Field label={t("Workspace")} hint={t("Where this task is filed on this machine. Without a project there is nothing to infer it from.")}>
							{() => (
								<Select value={workspaceId} onValueChange={setWsPick} disabled={(workspaces.data?.length ?? 0) < 2}>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{(workspaces.data ?? []).map((w) => (
											<SelectItem key={w.id} value={w.id}>
												{w.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</Field>
					) : null}

					<Field label={t("Title")}>{(id) => <Input id={id} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder={t("e.g. Add input validation to the signup form")} />}</Field>
					<Field label={t("Instructions")} hint={t("Markdown supported. Say what “done” looks like.")}>
						{(id) => <Textarea id={id} value={description} maxLength={50_000} rows={6} onChange={(e) => setDescription(e.target.value)} placeholder={t("What should the agent do? Include context, constraints and acceptance criteria.")} />}
					</Field>

					<fieldset className="flex flex-col gap-1.5">
						<legend className="mb-1.5 text-[13px] font-medium">{t("Deliver as")}</legend>
						<div role="radiogroup" aria-label={t("Deliver as")} className="grid gap-2 sm:grid-cols-3">
							{DELIVER_OPTIONS.map((o) => {
								const disabled = o.id === "branch" && !branchOk;
								return (
									<button
										key={o.id}
										type="button"
										role="radio"
										aria-checked={deliverAs === o.id}
										disabled={disabled}
										onClick={() => setDeliverPick(o.id)}
										className={cn(
											"flex min-h-11 flex-col items-start gap-1 rounded-lg p-3 text-left outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] disabled:cursor-not-allowed disabled:opacity-50",
											deliverAs === o.id ? "bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]" : "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-surface-3",
										)}
									>
										<span className="text-[13px] font-medium">{tr(o.label)}</span>
										<span className="text-xs text-muted-foreground">{disabled ? t("Needs a project with a linked GitHub repository.") : tr(o.hint)}</span>
									</button>
								);
							})}
						</div>
					</fieldset>
					{deliverAs === "branch" ? (
						<Field label={t("Base branch")} hint={t("The task branch starts from here.")}>
							{(id) => <Input id={id} value={baseBranch} maxLength={200} onChange={(e) => setBaseBranch(e.target.value)} placeholder={project?.repository?.defaultBranch ?? t("repository default")} className="font-mono text-xs" />}
						</Field>
					) : null}

					<div className="grid gap-3 sm:grid-cols-2">
						<Field label={t("Max cost (USD)")} hint={t("Optional. The run stops at this spend.")} error={costInvalid ? t("Enter an amount between 0 and 1000.") : null}>
							{(id) => <Input id={id} inputMode="decimal" type="number" min="0" max="1000" step="0.01" value={maxCost} onChange={(e) => setMaxCost(e.target.value)} placeholder={t("no limit")} aria-invalid={costInvalid || undefined} />}
						</Field>
						<Field label={t("Approval mode")} hint={t("The executor may only be stricter than its own setting.")}>
							{() => (
								<Select value={approval} onValueChange={setApproval}>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={DEFAULT_APPROVAL}>{t("Executor's setting")}</SelectItem>
										{APPROVAL_MODES.map((m) => (
											<SelectItem key={m.value} value={m.value}>
												{tr(m.label)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</Field>
					</div>

					{create.error ? (
						<p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
							{errorText(create.error)}
						</p>
					) : null}
					<DialogFooter className="sticky bottom-0 -mx-1 bg-overlay px-1 pt-1">
						<Button variant="ghost" onClick={onClose} disabled={create.isPending}>
							{t("Cancel")}
						</Button>
						<Button type="submit" variant="primary" loading={create.isPending} disabled={!ready}>
							<Send /> {t("Delegate")}
							{peer && peer.status !== "online" ? <Badge variant="warning">{t("queued")}</Badge> : null}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
