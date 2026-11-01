import type { Task } from "@clam/contracts";
import { Info, Plus, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PeerStatusBadge } from "@/features/network/components";
import { t, tr } from "@/i18n";
import { PEER_STATUS_LABEL } from "@/features/network/format";
import { ApiError, errorText } from "@/lib/api";
import { useDirectory, usePeers } from "@/lib/queries";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Field } from "@/ui/field";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { StatusDot } from "@/ui/status-dot";
import { Switch } from "@/ui/switch";
import { useCreateHandoff } from "./actions.ts";

const ANY = "__any__";
const MAX_COMMANDS = 20;
const MAX_LEN = 500;

function ToggleRow({ id, label, hint, checked, onChange, tone }: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; tone?: "warning" }) {
	return (
		<div className="flex items-start justify-between gap-4">
			<div className="min-w-0">
				<label htmlFor={id} className="text-[13px] font-medium">
					{label}
				</label>
				<p className={tone === "warning" && checked ? "mt-0.5 text-xs text-warning" : "mt-0.5 text-xs text-subtle"}>{hint}</p>
			</div>
			<Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-0.5" />
		</div>
	);
}

/** Executor side: hand a running or blocked task over to another machine. */
export default function HandOffDialog({ task, onClose }: { task: Task; onClose: () => void }) {
	const peers = usePeers();
	const directory = useDirectory();
	const create = useCreateHandoff();

	// Handing off needs the peer to accept handoffs from this machine.
	const candidates = useMemo(() => (peers.data ?? []).filter((p) => p.status !== "revoked"), [peers.data]);
	const [peerId, setPeerId] = useState("");
	const [agentKey, setAgentKey] = useState(ANY);
	const [stopRunning, setStopRunning] = useState(false);
	const [includeTranscript, setIncludeTranscript] = useState(false);
	const [commands, setCommands] = useState<string[]>([]);
	const [draft, setDraft] = useState("");
	const [checkCommand, setCheckCommand] = useState("");

	const capable = (p: (typeof candidates)[number]) => p.receivedCapabilities.includes("handoff.receive");
	useEffect(() => {
		if (!peerId) {
			const only = candidates.filter(capable);
			if (only.length === 1 && only[0]) setPeerId(only[0].id);
		}
	}, [peerId, candidates]);

	const peer = candidates.find((p) => p.id === peerId);
	const agents = useMemo(() => (directory.data ?? []).filter((a) => a.nodeId === peerId).sort((a, b) => a.name.localeCompare(b.name)), [directory.data, peerId]);
	useEffect(() => {
		if (agentKey !== ANY && directory.isSuccess && !agents.some((a) => a.agentId === agentKey)) setAgentKey(ANY);
	}, [agentKey, agents, directory.isSuccess]);

	const busy = create.error instanceof ApiError && create.error.code === "session_busy";
	const cannotReceive = peer !== undefined && !capable(peer);
	const ready = peer !== undefined && !cannotReceive;

	const addCommand = () => {
		const c = draft.trim();
		if (!c || c.length > MAX_LEN || commands.length >= MAX_COMMANDS || commands.includes(c)) return;
		setCommands([...commands, c]);
		setDraft("");
	};

	const submit = () => {
		if (!ready || !peer) return;
		const pending = draft.trim();
		const extra = pending && !commands.includes(pending) && commands.length < MAX_COMMANDS ? [...commands, pending] : commands;
		create.mutate(
			{
				taskId: task.id,
				targetNodeId: peer.id,
				targetAgentId: agentKey === ANY ? undefined : agentKey,
				stopRunning,
				includeTranscript,
				setupCommands: extra,
				checkCommand: checkCommand.trim() || undefined,
			},
			{ onSuccess: onClose },
		);
	};

	const noNodes = peers.isSuccess && candidates.length === 0;
	return (
		<Dialog open onOpenChange={(o) => !o && !create.isPending && onClose()}>
			<DialogContent sheetOnMobile className="max-w-xl">
				<DialogHeader>
					<DialogTitle>{t("Hand off “{title}”", { title: task.title })}</DialogTitle>
					<DialogDescription>
						{t(
							"Another machine takes over this task. It restores the files and context, sets up dependencies (you and the target review the commands), validates, and starts a new agent session. This machine keeps the task until the target confirms it is ready.",
						)}
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
							<span>{t("No machine is paired with this one yet. Pair a machine in Agent Network first.")}</span>
						</div>
					) : null}
					<div className="grid gap-3 sm:grid-cols-2">
						<Field label={t("Target machine")}>
							{(id) => (
								<Select value={peerId} onValueChange={setPeerId} disabled={noNodes}>
									<SelectTrigger id={id}>
										<SelectValue placeholder={t("Choose a machine")} />
									</SelectTrigger>
									<SelectContent>
										{candidates.map((p) => (
											<SelectItem key={p.id} value={p.id} disabled={!capable(p)}>
												<span className="inline-flex items-center gap-2">
													<StatusDot status={p.status === "online" ? "online" : p.status === "degraded" ? "degraded" : "offline"} label={tr(PEER_STATUS_LABEL[p.status])} />
													{p.name}
													{!capable(p) ? <span className="text-2xs text-subtle">{t("can’t receive handoffs")}</span> : null}
												</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</Field>
						<Field label={t("Agent")} hint={t("Leave on “any” to let the machine pick.")}>
							{(id) => (
								<Select value={agentKey} onValueChange={setAgentKey} disabled={!peer}>
									<SelectTrigger id={id}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={ANY}>{t("Any available agent")}</SelectItem>
										{agents.map((a) => (
											<SelectItem key={a.agentId} value={a.agentId}>
												<span className="inline-flex items-center gap-2">
													<StatusDot status={a.status} />
													{a.name}
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
							{t("{name} is not reachable right now. The offer is delivered when it is online.", { name: peer.name })}
						</p>
					) : null}
					{cannotReceive ? (
						<p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
							{t("{name} has not allowed this machine to hand work over. Ask its owner to grant “handoff.receive”.", { name: peer?.name ?? "" })}
						</p>
					) : null}

					<div className="flex flex-col gap-3.5 rounded-xl bg-surface-2 p-3.5">
						<ToggleRow
							id="handoff-stop"
							label={t("Stop the running turn first")}
							checked={stopRunning}
							onChange={setStopRunning}
							hint={
								busy
									? t("The agent is in the middle of a turn. Turn this on to abort it and hand off what exists so far, or wait until the turn settles.")
									: t("If the agent is mid-turn the handoff is refused. Turn this on to abort that turn (work already written to files is kept).")
							}
							tone={busy ? "warning" : undefined}
						/>
						<ToggleRow
							id="handoff-transcript"
							label={t("Include the conversation transcript")}
							checked={includeTranscript}
							onChange={setIncludeTranscript}
							tone="warning"
							hint={includeTranscript ? t("The full transcript, including tool output, is sent to the target. It may contain file contents or secrets printed by commands.") : t("Off: only a secret-scanned summary travels.")}
						/>
					</div>

					<Field label={t("Extra setup commands")} hint={t("Optional. The target shows each one and asks before running it.")}>
						{(id) => (
							<div className="flex flex-col gap-2">
								{commands.length > 0 ? (
									<ul className="flex flex-col gap-1.5">
										{commands.map((c) => (
											<li key={c} className="flex items-center gap-2 rounded-lg bg-surface-2 py-1 pl-2.5 pr-1">
												<code className="min-w-0 flex-1 break-all font-mono text-xs">{c}</code>
												<Button type="button" size="icon-sm" variant="ghost" aria-label={t("Remove {command}", { command: c })} onClick={() => setCommands(commands.filter((x) => x !== c))}>
													<X />
												</Button>
											</li>
										))}
									</ul>
								) : null}
								<div className="flex gap-2">
									<Input
										id={id}
										value={draft}
										maxLength={MAX_LEN}
										placeholder="pnpm install"
										className="font-mono"
										onChange={(e) => setDraft(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												addCommand();
											}
										}}
									/>
									<Button type="button" variant="outline" onClick={addCommand} disabled={draft.trim() === "" || commands.length >= MAX_COMMANDS}>
										<Plus /> {t("Add")}
									</Button>
								</div>
							</div>
						)}
					</Field>
					<Field label={t("Check command")} hint={t("Optional. Runs on the target to prove the workspace works before it takes over.")}>
						{(id) => <Input id={id} value={checkCommand} maxLength={MAX_LEN} placeholder="pnpm test" className="font-mono" onChange={(e) => setCheckCommand(e.target.value)} />}
					</Field>

					{create.isError ? (
						<p role="alert" className="flex items-start gap-2 break-words rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
							<TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
							{errorText(create.error)}
						</p>
					) : null}
					<DialogFooter className="sticky bottom-0 bg-overlay pt-2">
						<Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
							{t("Cancel")}
						</Button>
						<Button type="submit" variant="primary" disabled={!ready} loading={create.isPending}>
							{t("Hand off")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
