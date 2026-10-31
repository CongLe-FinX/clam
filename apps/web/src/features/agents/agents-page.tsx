import { type Agent, routes } from "@clam/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Bot, ChevronLeft, Pencil, RefreshCw, X } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { qk, useAgents, useWorkspace } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { EmptyState } from "@/ui/empty-state";
import { Field } from "@/ui/field";
import { Input, fieldClass } from "@/ui/input";
import { PageContainer, PageHeader } from "@/ui/page";
import { Skeleton } from "@/ui/skeleton";
import { StatusDot } from "@/ui/status-dot";

const MAX_CAPS = 32;
const MAX_CAP_LEN = 40;
const VISIBLE_CAPS = 8;

export default function AgentsPage() {
	const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string };
	const agents = useAgents();
	const [editing, setEditing] = useState<Agent | null>(null);

	return (
		<PageContainer>
			{workspaceId ? <WorkspaceCrumb workspaceId={workspaceId} /> : null}
			<PageHeader
				title="Agents"
				description="Agents are the identities OMP sessions run under on this node. Name them and describe what they're good at; this is only a label and never changes how a session behaves."
			/>
			{agents.isPending ? (
				<div aria-busy className="grid gap-3 sm:grid-cols-2">
					{Array.from({ length: 4 }, (_, i) => (
						<Skeleton key={i} className="h-36 rounded-xl" />
					))}
				</div>
			) : agents.error ? (
				<EmptyState
					icon={Bot}
					title="Could not load agents"
					description={errorMessage(agents.error)}
					action={
						<Button size="sm" variant="outline" onClick={() => void agents.refetch()}>
							<RefreshCw /> Retry
						</Button>
					}
				/>
			) : agents.data.length === 0 ? (
				<EmptyState icon={Bot} title="No agents yet" description="An agent identity is created when you start your first session." className="rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]" />
			) : (
				<ul className="grid gap-3 sm:grid-cols-2">
					{agents.data.map((a) => (
						<AgentCard key={a.id} agent={a} onEdit={() => setEditing(a)} />
					))}
				</ul>
			)}
			<EditAgentDialog agent={editing} onClose={() => setEditing(null)} />
		</PageContainer>
	);
}

function WorkspaceCrumb({ workspaceId }: { workspaceId: string }) {
	const ws = useWorkspace(workspaceId);
	return (
		<nav aria-label="Breadcrumb" className="-mb-2">
			<Link
				to="/workspaces/$workspaceId"
				params={{ workspaceId }}
				className="inline-flex items-center gap-1 rounded-md py-1 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:py-3"
			>
				<ChevronLeft className="size-3.5" />
				{ws.data ? ws.data.name : ws.isPending ? <Skeleton className="h-3 w-20" /> : "Workspace"}
			</Link>
		</nav>
	);
}

function AgentCard({ agent: a, onEdit }: { agent: Agent; onEdit: () => void }) {
	const shown = a.capabilities.slice(0, VISIBLE_CAPS);
	const extra = a.capabilities.length - shown.length;
	return (
		<li className="flex flex-col gap-3 rounded-xl bg-surface-1 p-4 shadow-[inset_0_0_0_1px_var(--border)] transition-shadow hover:shadow-[inset_0_0_0_1px_var(--border-strong)]">
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-2">
						<StatusDot status={a.status} label={a.status} />
						<h2 className="truncate text-sm font-semibold tracking-tight">{a.name}</h2>
					</div>
					<p className={cn("truncate text-xs", a.role ? "text-muted-foreground" : "text-subtle")}>{a.role || "No role set"}</p>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<Badge variant="outline" className="font-mono">
						{a.runtime}
					</Badge>
					<Button variant="ghost" size="icon-sm" aria-label={`Edit ${a.name}`} onClick={onEdit}>
						<Pencil />
					</Button>
				</div>
			</div>
			{a.capabilities.length > 0 ? (
				<ul className="flex flex-wrap gap-1.5" aria-label="Capabilities">
					{shown.map((c) => (
						<li key={c}>
							<Badge variant="neutral">{c}</Badge>
						</li>
					))}
					{extra > 0 ? (
						<li>
							<Badge variant="outline">+{extra}</Badge>
						</li>
					) : null}
				</ul>
			) : (
				<p className="text-xs text-subtle">No capabilities listed.</p>
			)}
			<div className="mt-auto flex items-center justify-between gap-2 border-t pt-2.5 text-xs text-subtle">
				<span className="capitalize">{a.status}</span>
				<span className="tabular">
					{a.activeSessions} active {a.activeSessions === 1 ? "session" : "sessions"}
				</span>
				<span className="hidden sm:inline">Since {relativeTime(a.createdAt)}</span>
			</div>
		</li>
	);
}

// ───────────────────────────── edit dialog ─────────────────────────────

function EditAgentDialog({ agent, onClose }: { agent: Agent | null; onClose: () => void }) {
	return (
		<Dialog open={agent !== null} onOpenChange={(o) => !o && onClose()}>
			<DialogContent>{agent ? <EditForm key={agent.id} agent={agent} onClose={onClose} /> : null}</DialogContent>
		</Dialog>
	);
}

function EditForm({ agent, onClose }: { agent: Agent; onClose: () => void }) {
	const qc = useQueryClient();
	const [name, setName] = useState(agent.name);
	const [role, setRole] = useState(agent.role);
	const [caps, setCaps] = useState<string[]>(agent.capabilities);
	const nameInvalid = name.trim().length === 0;

	const save = useMutation({
		mutationFn: (body: { name: string; role: string; capabilities: string[] }) => api.patch<Agent>(routes.agent(agent.id), body),
		onMutate: async (body) => {
			await qc.cancelQueries({ queryKey: qk.agents });
			const prev = qc.getQueryData<Agent[]>(qk.agents);
			qc.setQueryData<Agent[]>(qk.agents, (d) => d?.map((a) => (a.id === agent.id ? { ...a, ...body, capabilities: body.capabilities } : a)));
			onClose();
			return { prev };
		},
		onError: (e, _b, ctx) => {
			if (ctx?.prev) qc.setQueryData(qk.agents, ctx.prev);
			toast.error(`Could not update ${agent.name}`, { description: errorMessage(e) });
		},
		onSuccess: (next) => {
			qc.setQueryData<Agent[]>(qk.agents, (d) => d?.map((a) => (a.id === next.id ? next : a)));
			toast.success("Agent updated");
		},
		onSettled: () => void qc.invalidateQueries({ queryKey: qk.agents }),
	});

	return (
		<form
			className="flex min-h-0 flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				if (!nameInvalid) save.mutate({ name: name.trim(), role: role.trim(), capabilities: caps });
			}}
		>
			<DialogHeader>
				<DialogTitle>Edit agent</DialogTitle>
				<DialogDescription>Changes apply to this node only.</DialogDescription>
			</DialogHeader>
			<Field label="Name" error={nameInvalid ? "Name is required." : null}>
				{(id) => <Input id={id} value={name} maxLength={64} autoComplete="off" aria-invalid={nameInvalid} onChange={(e) => setName(e.target.value)} />}
			</Field>
			<Field label="Role" hint="Free text, e.g. “Backend”.">
				{(id) => <Input id={id} value={role} maxLength={120} autoComplete="off" onChange={(e) => setRole(e.target.value)} />}
			</Field>
			<Field label="Capabilities" hint="Press Enter or comma to add. Backspace removes the last one.">
				{(id) => <TagsInput id={id} value={caps} onChange={setCaps} />}
			</Field>
			<DialogFooter>
				<Button variant="ghost" onClick={onClose}>
					Cancel
				</Button>
				<Button type="submit" variant="primary" disabled={nameInvalid}>
					Save changes
				</Button>
			</DialogFooter>
		</form>
	);
}

function TagsInput({ id, value, onChange }: { id: string; value: string[]; onChange: (v: string[]) => void }) {
	const [draft, setDraft] = useState("");
	const ref = useRef<HTMLInputElement>(null);

	const add = (raw: string) => {
		const parts = raw
			.split(",")
			.map((s) => s.trim().slice(0, MAX_CAP_LEN))
			.filter(Boolean);
		if (parts.length === 0) return;
		const next = [...value];
		for (const p of parts) if (!next.some((x) => x.toLowerCase() === p.toLowerCase()) && next.length < MAX_CAPS) next.push(p);
		onChange(next);
		setDraft("");
	};
	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" || e.key === ",") {
			e.preventDefault();
			add(draft);
		} else if (e.key === "Backspace" && draft === "" && value.length > 0) {
			onChange(value.slice(0, -1));
		}
	};

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: forwards pointer focus to the real input
		<div
			onClick={() => ref.current?.focus()}
			className={cn(fieldClass, "flex min-h-8 flex-wrap items-center gap-1.5 py-1.5 coarse:min-h-11 focus-within:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)]")}
		>
			{value.map((t) => (
				<span key={t} className="inline-flex items-center gap-1 rounded-md bg-surface-3 py-0.5 pl-1.5 pr-0.5 text-xs">
					{t}
					<button
						type="button"
						aria-label={`Remove ${t}`}
						onClick={(e) => {
							e.stopPropagation();
							onChange(value.filter((x) => x !== t));
						}}
						className="grid size-4 place-items-center rounded text-subtle hover:bg-border-strong hover:text-foreground coarse:size-6"
					>
						<X className="size-3" />
					</button>
				</span>
			))}
			<input
				ref={ref}
				id={id}
				value={draft}
				onChange={(e) => (e.target.value.includes(",") ? add(e.target.value) : setDraft(e.target.value))}
				onKeyDown={onKeyDown}
				onBlur={() => add(draft)}
				maxLength={MAX_CAP_LEN * 2}
				placeholder={value.length === 0 ? "e.g. refactoring" : ""}
				disabled={value.length >= MAX_CAPS}
				className="min-w-24 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle"
			/>
		</div>
	);
}
