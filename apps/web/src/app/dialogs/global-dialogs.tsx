import { type AgentSession, type ModelInfo, type Project, type Workspace, routes } from "@clam/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CloudDownload, FolderPlus, FolderOpen, Info } from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DirPicker } from "@/components/dir-picker";
import { api, errorMessage } from "@/lib/api";
import { lazyPreload } from "@/lib/lazy-preload";
import { rememberInitialPrompt } from "@/lib/initial-prompt";
import { qk, useProjects, useWorkspaces } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { basename, cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Field } from "@/ui/field";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Textarea } from "@/ui/textarea";

const { Component: CloneForm, preload: loadCloneForm } = lazyPreload(() => import("@/features/git/clone-form.tsx"));
const { Component: InviteDialog, preload: loadInviteDialog } = lazyPreload(() => import("@/features/network/invite-dialog.tsx"));
const { Component: JoinDialog, preload: loadJoinDialog } = lazyPreload(() => import("@/features/network/join-dialog.tsx"));
const { Component: PairingRequestsDialog, preload: loadPairingRequestsDialog } = lazyPreload<{ onClose: () => void }>(() => import("@/features/network/pairing-requests.tsx").then((m) => ({ default: m.PairingRequestsDialog })));
const { Component: DelegateDialog, preload: loadDelegateDialog } = lazyPreload(() => import("@/features/tasks/delegate-dialog.tsx"));
const { Component: ContextEditorDialog, preload: loadContextEditorDialog } = lazyPreload(() => import("@/features/context/editor-dialog.tsx"));
const { Component: NewChatDialog, preload: loadNewChatDialog } = lazyPreload(() => import("@/features/chats/new-chat-dialog.tsx"));
const { Component: HandoverDialog, preload: loadHandoverDialog } = lazyPreload(() => import("@/features/shared/handover-dialog.tsx"));

/** Warms every dialog body so the first open of any of them paints without a Suspense round trip. */
export const preloadDialogBodies = (): Promise<unknown> => Promise.all([loadCloneForm(), loadInviteDialog(), loadJoinDialog(), loadPairingRequestsDialog(), loadDelegateDialog(), loadContextEditorDialog(), loadNewChatDialog(), loadHandoverDialog()]);

export default function GlobalDialogs() {
	const dialog = useUi((s) => s.dialog);
	const close = useUi((s) => s.closeDialog);
	if (!dialog) return null;
	switch (dialog.kind) {
		case "create-workspace":
			return <WorkspaceDialog onClose={close} />;
		case "edit-workspace":
			return <WorkspaceDialog workspaceId={dialog.workspaceId} onClose={close} />;
		case "create-project":
			return <ProjectDialog workspaceId={dialog.workspaceId} initialMode={dialog.mode} onClose={close} />;
		case "create-session":
			return <SessionDialog projectId={dialog.projectId} onClose={close} />;
		case "new-chat":
			return (
				<Suspense fallback={null}>
					<NewChatDialog onClose={close} />
				</Suspense>
			);
		case "invite-node":
			return (
				<Suspense fallback={null}>
					<InviteDialog workspaceId={dialog.workspaceId} onClose={close} />
				</Suspense>
			);
		case "join-node":
			return (
				<Suspense fallback={null}>
					<JoinDialog onClose={close} />
				</Suspense>
			);
		case "pairing-requests":
			return (
				<Suspense fallback={null}>
					<PairingRequestsDialog onClose={close} />
				</Suspense>
			);
		case "delegate-task":
			return (
				<Suspense fallback={null}>
					<DelegateDialog preset={dialog} onClose={close} />
				</Suspense>
			);
		case "create-context":
			return (
				<Suspense fallback={null}>
					<ContextEditorDialog workspaceId={dialog.workspaceId} projectId={dialog.projectId} onClose={close} />
				</Suspense>
			);
		case "handover":
			return (
				<Suspense fallback={null}>
					<HandoverDialog sessionId={dialog.sessionId} presetNodeId={dialog.toNodeId} onClose={close} />
				</Suspense>
			);
	}
}

// ───────────────────────── workspace ─────────────────────────

function WorkspaceDialog({ workspaceId, onClose }: { workspaceId?: string; onClose: () => void }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const existing = useWorkspaces().data?.find((w) => w.id === workspaceId);
	const [name, setName] = useState(existing?.name ?? "");
	const [description, setDescription] = useState(existing?.description ?? "");
	const seeded = useRef(Boolean(existing));
	useEffect(() => {
		if (existing && !seeded.current) {
			seeded.current = true;
			setName(existing.name);
			setDescription(existing.description);
		}
	}, [existing]);

	const save = useMutation({
		mutationFn: () =>
			workspaceId
				? api.patch<Workspace>(routes.workspace(workspaceId), { name: name.trim(), description })
				: api.post<Workspace>(routes.workspaces, { name: name.trim(), description }),
		onSuccess: (ws) => {
			void qc.invalidateQueries({ queryKey: qk.workspaces });
			void qc.invalidateQueries({ queryKey: qk.workspace(ws.id) });
			toast.success(workspaceId ? "Workspace updated" : `Workspace “${ws.name}” created`);
			onClose();
			if (!workspaceId) void navigate({ to: "/workspaces/$workspaceId", params: { workspaceId: ws.id } });
		},
		onError: (e) => toast.error(errorMessage(e)),
	});

	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{workspaceId ? "Edit workspace" : "New workspace"}</DialogTitle>
					<DialogDescription>A workspace groups related projects and the agents working on them.</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(e) => {
						e.preventDefault();
						if (name.trim()) save.mutate();
					}}
				>
					<Field label="Name">{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Payments platform" />}</Field>
					<Field label="Description" hint="Optional">
						{(id) => <Textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={3} />}
					</Field>
					<DialogFooter>
						<Button variant="ghost" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" loading={save.isPending} disabled={!name.trim()}>
							{workspaceId ? "Save changes" : "Create workspace"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

// ───────────────────────── project ─────────────────────────

function ProjectDialog({ workspaceId: initialWs, initialMode, onClose }: { workspaceId?: string; initialMode?: "existing" | "clone" | "empty"; onClose: () => void }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const workspaces = useWorkspaces();
	const [workspaceId, setWorkspaceId] = useState(initialWs ?? "");
	const [mode, setMode] = useState<"existing" | "clone" | "empty">(initialMode ?? "existing");
	const [path, setPath] = useState("");
	const [name, setName] = useState("");
	const [nameTouched, setNameTouched] = useState(false);
	useEffect(() => {
		if (!workspaceId && workspaces.data?.[0]) setWorkspaceId(workspaces.data[0].id);
	}, [workspaceId, workspaces.data]);
	useEffect(() => {
		if (!nameTouched) setName(mode === "empty" ? "" : path ? basename(path) : "");
	}, [path, nameTouched, mode]);

	const create = useMutation({
		// "empty": no path → CL Agent Mesh creates a managed folder under its data dir (no repository involved).
		mutationFn: () => api.post<Project>(routes.projects, mode === "empty" ? { workspaceId, name: name.trim() } : { workspaceId, name: name.trim(), path: path.trim() }),
		onSuccess: (p) => {
			void qc.invalidateQueries({ queryKey: qk.projectsAll });
			void qc.invalidateQueries({ queryKey: qk.workspaces });
			toast.success(`Project “${p.name}” added`);
			onClose();
			void navigate({ to: "/projects/$projectId", params: { projectId: p.id } });
		},
	});

	const ready = workspaceId && name.trim() && (mode === "empty" || path.trim());
	const workspaceField = initialWs ? null : (
		<Field label="Workspace">
			{() => (
				<Select value={workspaceId} onValueChange={setWorkspaceId}>
					<SelectTrigger>
						<SelectValue placeholder={workspaces.data?.length === 0 ? "Create a workspace first" : "Select workspace"} />
					</SelectTrigger>
					<SelectContent>
						{workspaces.data?.map((w) => (
							<SelectItem key={w.id} value={w.id}>
								{w.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
		</Field>
	);
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent className={cn(mode === "clone" && "max-w-xl")}>
				<DialogHeader>
					<DialogTitle>{mode === "clone" ? "Clone from GitHub" : mode === "empty" ? "New empty folder" : "Add project"}</DialogTitle>
					<DialogDescription>
						{mode === "clone"
							? "Clone a repository with one of your connected GitHub accounts into a new project."
							: mode === "empty"
								? "Start from nothing: CL Agent Mesh creates an empty folder for the project. No Git repository is needed."
								: "Point to an existing directory on this machine, with or without Git. Agents run with it as their working directory."}
					</DialogDescription>
				</DialogHeader>
				<div role="group" aria-label="How to add the project" className="flex rounded-lg bg-surface-2 p-0.5 text-xs font-medium">
					{(
						[
							["existing", "Existing directory"],
							["empty", "New empty folder"],
							["clone", "Clone from GitHub"],
						] as const
					).map(([id, label]) => (
						<button
							key={id}
							type="button"
							aria-pressed={mode === id}
							onClick={() => setMode(id)}
							className={cn(
								"inline-flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-10",
								mode === id ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:text-foreground",
							)}
						>
							{id === "clone" ? <CloudDownload className="size-3.5" aria-hidden /> : id === "empty" ? <FolderPlus className="size-3.5" aria-hidden /> : <FolderOpen className="size-3.5" aria-hidden />}
							<span className="truncate">{label}</span>
						</button>
					))}
				</div>
				{mode === "clone" ? (
					<Suspense
						fallback={
							<div className="flex flex-col gap-3" aria-busy>
								<Skeleton className="h-9" />
								<Skeleton className="h-9" />
								<Skeleton className="h-24" />
							</div>
						}
					>
						<CloneForm workspaceId={workspaceId} workspaceField={workspaceField} onClose={onClose} />
					</Suspense>
				) : (
					<form
						className="flex flex-col gap-4"
						onSubmit={(e) => {
							e.preventDefault();
							if (ready) create.mutate();
						}}
					>
						{workspaceField}
						{mode === "empty" ? (
							<p className="flex gap-2 rounded-lg bg-surface-2 p-3 text-xs text-muted-foreground">
								<Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent" />
								<span>
									The folder lives in this machine&apos;s CL Agent Mesh data directory. Agents can create and edit files there, and you can delegate tasks or share sessions from it to other machines without any repository — files travel as bundles you preview before applying.
								</span>
							</p>
						) : (
							<Field label="Directory" hint="Absolute path. Start typing to see local directories." error={create.error ? errorMessage(create.error) : null}>
								{() => (
									<DirPicker
										value={path}
										onChange={(v) => {
											setPath(v);
											create.reset();
										}}
										invalid={Boolean(create.error)}
									/>
								)}
							</Field>
						)}
						<Field label="Name" error={mode === "empty" && create.error ? errorMessage(create.error) : null}>
							{(id) => (
								<Input
									id={id}
									autoFocus={mode === "empty"}
									placeholder={mode === "empty" ? "e.g. Research notes" : undefined}
									value={name}
									onChange={(e) => {
										setNameTouched(true);
										setName(e.target.value);
									}}
									maxLength={80}
								/>
							)}
						</Field>
						<DialogFooter>
							<Button variant="ghost" onClick={onClose}>
								Cancel
							</Button>
							<Button type="submit" variant="primary" loading={create.isPending} disabled={!ready}>
								{mode === "empty" ? "Create project" : "Add project"}
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

// ───────────────────────── session ─────────────────────────

const DEFAULT_MODEL = "__default__";

function SessionDialog({ projectId: initialProject, onClose }: { projectId?: string; onClose: () => void }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const projects = useProjects();
	const [projectId, setProjectId] = useState(initialProject ?? "");
	const [title, setTitle] = useState("");
	const [model, setModel] = useState(DEFAULT_MODEL);
	const [prompt, setPrompt] = useState("");
	const models = useQuery({ queryKey: qk.ompModels, queryFn: ({ signal }) => api.get<ModelInfo[]>(routes.ompModels, undefined, { signal }), staleTime: 5 * 60_000 });
	useEffect(() => {
		if (!projectId && projects.data?.[0]) setProjectId(projects.data[0].id);
	}, [projectId, projects.data]);

	const create = useMutation({
		mutationFn: () =>
			api.post<AgentSession>(routes.sessions, {
				projectId,
				title: title.trim() || undefined,
				model: model === DEFAULT_MODEL ? undefined : model,
				prompt: prompt.trim() || undefined,
			}),
		onSuccess: (s) => {
			qc.setQueryData(qk.session(s.id), s);
			if (prompt.trim()) rememberInitialPrompt(s.id, prompt);
			void qc.invalidateQueries({ queryKey: qk.sessionsAll });
			void qc.invalidateQueries({ queryKey: qk.projectsAll });
			onClose();
			void navigate({ to: "/sessions/$sessionId", params: { sessionId: s.id } });
		},
		onError: (e) => toast.error(errorMessage(e)),
	});

	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>New agent session</DialogTitle>
					<DialogDescription>Starts an OMP runtime in the project directory.</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4 overflow-y-auto"
					onSubmit={(e) => {
						e.preventDefault();
						if (projectId) create.mutate();
					}}
				>
					<Field label="Project">
						{() => (
							<Select value={projectId} onValueChange={setProjectId}>
								<SelectTrigger>
									<SelectValue placeholder={projects.data?.length === 0 ? "Add a project first" : "Select project"} />
								</SelectTrigger>
								<SelectContent>
									{projects.data?.map((p) => (
										<SelectItem key={p.id} value={p.id}>
											{p.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					</Field>
					<Field label="Title" hint="Optional — defaults to the first prompt">
						{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />}
					</Field>
					<Field label="Model">
						{() => (
							<Select value={model} onValueChange={setModel}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={DEFAULT_MODEL}>OMP default</SelectItem>
									{models.data?.map((m) => (
										<SelectItem key={m.selector} value={m.selector}>
											<span className={cn("font-mono text-xs")}>{m.selector}</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					</Field>
					<Field label="First prompt" hint="Optional — sent as soon as the runtime is ready">
						{(id) => <Textarea id={id} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} />}
					</Field>
					<DialogFooter>
						<Button variant="ghost" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" loading={create.isPending} disabled={!projectId}>
							Start session
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
