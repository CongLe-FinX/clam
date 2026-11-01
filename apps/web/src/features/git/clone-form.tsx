import { type DirSuggestion, type GitOperation, type GithubRepo, routes } from "@clam/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, Lock, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DirPicker } from "@/components/dir-picker";
import { useDebounced } from "@/features/projects/session-list";
import { useGithubAccounts, useGithubRepos } from "@/features/settings/hooks";
import { t } from "@/i18n";
import { api, errorText } from "@/lib/api";
import { qk } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useTopic, ws } from "@/lib/ws";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { DialogFooter } from "@/ui/dialog";
import { Field } from "@/ui/field";
import { Input } from "@/ui/input";
import { Progress } from "@/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Skeleton } from "@/ui/skeleton";

function cloneDone(qc: QueryClient, openProject: (projectId: string) => void, projectId: string, label: string): void {
	void qc.invalidateQueries({ queryKey: qk.projectsAll });
	void qc.invalidateQueries({ queryKey: qk.workspaces });
	openProject(projectId);
	toast.success(t("Cloned {label}", { label }));
}

/** Keeps following a clone after its dialog is closed: one loading toast that turns into an "Open project" action. */
function trackInBackground(op: GitOperation, label: string, qc: QueryClient, openProject: (projectId: string) => void): void {
	const id = `clone-${op.id}`;
	toast.loading(t("Cloning {label}…", { label }), { id, description: op.phase ?? undefined });
	let off = () => {};
	let finished = false;
	const finish = (o: GitOperation) => {
		if (finished || o.state === "running") return false;
		finished = true;
		off();
		if (o.state === "succeeded" && o.projectId) {
			const projectId = o.projectId;
			void qc.invalidateQueries({ queryKey: qk.projectsAll });
			void qc.invalidateQueries({ queryKey: qk.workspaces });
			toast.success(t("Cloned {label}", { label }), { id, description: undefined, action: { label: t("Open project"), onClick: () => openProject(projectId) } });
		} else toast.error(t("Cloning {label} failed", { label }), { id, description: o.error ?? t("Unknown error"), duration: 12_000 });
		return true;
	};
	off = ws.subscribe(`git-op:${op.id}`, (ev) => {
		if (finish(ev.operation)) return;
		toast.loading(ev.operation.percent !== null ? t("Cloning {label}… {percent}%", { label, percent: Math.round(ev.operation.percent) }) : t("Cloning {label}…", { label }), { id, description: ev.operation.phase ?? undefined });
	});
	void api.get<GitOperation>(routes.gitOperation(op.id)).then(finish, () => undefined);
}

function useHomeDir(): string | null {
	const q = useQuery({
		queryKey: ["local", "fs-home"],
		queryFn: ({ signal }) => api.get<DirSuggestion[]>(routes.dirSuggestions, { prefix: "~/" }, { signal }),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const first = q.data?.[0]?.path;
	if (!first) return null;
	const i = first.lastIndexOf("/");
	return i > 0 ? first.slice(0, i) : null;
}

function RepoPicker({ accountId, selected, onSelect }: { accountId: string; selected: GithubRepo | null; onSelect: (r: GithubRepo | null) => void }) {
	const [search, setSearch] = useState("");
	const q = useDebounced(search, 250).trim();
	const repos = useGithubRepos(accountId, q, selected === null);
	const items = repos.data?.pages.flatMap((p) => p.items) ?? [];

	if (selected) {
		return (
			<div className="flex items-center gap-2.5 rounded-lg bg-accent-soft px-3 py-2">
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-1.5 font-mono text-[13px] font-medium">
						{selected.fullName}
						{selected.private ? <Lock aria-label={t("Private")} className="size-3 text-subtle" /> : null}
					</span>
					{selected.description ? <span className="block truncate text-2xs text-muted-foreground">{selected.description}</span> : null}
				</span>
				<Badge variant="outline">{selected.defaultBranch}</Badge>
				<Button variant="ghost" size="sm" onClick={() => onSelect(null)}>
					{t("Change")}
				</Button>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-2">
			<div className="relative">
				<Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
				<Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Search repositories (name or description)")} aria-label={t("Search repositories")} className="pl-8" autoComplete="off" spellCheck={false} />
			</div>
			<div className="scrollbar-thin max-h-48 overflow-y-auto rounded-lg shadow-[inset_0_0_0_1px_var(--border)]">
				{repos.isPending ? (
					<div className="flex flex-col gap-1 p-1.5" aria-busy>
						<Skeleton className="h-10" />
						<Skeleton className="h-10" />
						<Skeleton className="h-10" />
					</div>
				) : repos.error ? (
					<p role="alert" className="flex items-center gap-2 px-3 py-4 text-xs text-danger">
						<TriangleAlert className="size-4 shrink-0" /> {errorText(repos.error)}
					</p>
				) : items.length === 0 ? (
					<p className="px-3 py-6 text-center text-xs text-subtle">{q ? t("No repositories match “{query}”.", { query: q }) : t("This account has no repositories.")}</p>
				) : (
					<ul>
						{items.map((r) => (
							<li key={r.id}>
								<button type="button" onClick={() => onSelect(r)} className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none hover:bg-surface-2 focus-visible:bg-surface-2 coarse:py-3">
									<span className="min-w-0 flex-1">
										<span className="flex items-center gap-1.5 font-mono text-xs font-medium">
											<span className="truncate">{r.fullName}</span>
											{r.private ? <Lock aria-label={t("Private")} className="size-3 shrink-0 text-subtle" /> : null}
										</span>
										{r.description ? <span className="block truncate text-2xs text-subtle">{r.description}</span> : null}
									</span>
									{!r.permissions.push ? <Badge variant="neutral">{t("read-only")}</Badge> : null}
								</button>
							</li>
						))}
						{repos.hasNextPage ? (
							<li className="p-1.5">
								<Button variant="ghost" size="sm" className="w-full" loading={repos.isFetchingNextPage} onClick={() => void repos.fetchNextPage()}>
									{t("Load more")}
								</Button>
							</li>
						) : null}
					</ul>
				)}
			</div>
		</div>
	);
}

export default function CloneForm({ workspaceId, workspaceField, onClose }: { workspaceId: string; workspaceField: ReactNode; onClose: () => void }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const openProject = (projectId: string) => void navigate({ to: "/projects/$projectId", params: { projectId }, search: { tab: "git" } });
	const accounts = useGithubAccounts();
	const home = useHomeDir();
	const [accountId, setAccountId] = useState("");
	const [repo, setRepo] = useState<GithubRepo | null>(null);
	const [branch, setBranch] = useState("");
	const [path, setPath] = useState("");
	const [pathTouched, setPathTouched] = useState(false);
	const [op, setOp] = useState<GitOperation | null>(null);
	const finished = useRef(false);

	useEffect(() => {
		if (accountId || !accounts.data) return;
		const usable = accounts.data.filter((a) => a.status !== "invalid");
		const pick = usable.find((a) => a.isDefault) ?? usable[0];
		if (pick) setAccountId(pick.id);
	}, [accountId, accounts.data]);

	// Default target: ~/clam/<owner>/<repo> (made absolute with the machine's home directory).
	useEffect(() => {
		if (pathTouched) return;
		setPath(repo && home ? `${home}/clam/${repo.owner}/${repo.name}` : "");
	}, [repo, home, pathTouched]);

	const start = useMutation({
		mutationFn: () =>
			api.post<GitOperation>(routes.projectClone, {
				workspaceId,
				accountId,
				owner: repo?.owner,
				repo: repo?.name,
				path: path.trim(),
				branch: branch.trim() || undefined,
			}),
		onSuccess: (o) => setOp(o),
	});

	const settle = (o: GitOperation) => {
		setOp(o);
		if (o.state === "succeeded" && o.projectId && !finished.current) {
			finished.current = true;
			cloneDone(qc, openProject, o.projectId, repo?.fullName ?? t("repository"));
			onClose();
		}
	};
	const running = op?.state === "running";
	useTopic(running && op ? `git-op:${op.id}` : null, (e) => settle(e.operation));
	// Safety net for a missed event: poll the operation while it runs.
	useEffect(() => {
		if (!running || !op) return;
		const timer = setInterval(() => void api.get<GitOperation>(routes.gitOperation(op.id)).then(settle, () => undefined), 1500);
		return () => clearInterval(timer);
		// biome-ignore lint/correctness/useExhaustiveDependencies: settle only closes over stable props
	}, [running, op?.id]);

	const noAccounts = accounts.data !== undefined && accounts.data.filter((a) => a.status !== "invalid").length === 0;
	const ready = Boolean(workspaceId && accountId && repo && path.trim());

	if (op) {
		const failed = op.state === "failed";
		return (
			<div className="flex flex-col gap-4" aria-live="polite">
				<div className="flex items-center gap-2.5">
					{failed ? <TriangleAlert className="size-5 shrink-0 text-danger" /> : op.state === "succeeded" ? <CheckCircle2 className="size-5 shrink-0 text-success" /> : <RefreshCw className="size-5 shrink-0 animate-spin text-accent" />}
					<div className="min-w-0">
						<p className="truncate font-mono text-[13px] font-medium">{repo?.fullName}</p>
						<p className="truncate font-mono text-2xs text-subtle" title={path}>
							→ {path}
						</p>
					</div>
				</div>
				{failed ? (
					<div role="alert" className="flex flex-col gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-xs text-danger">
						<p className="font-medium">{t("Clone failed")}</p>
						<pre className="scrollbar-thin max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs">{op.error ?? t("git did not report an error.")}</pre>
					</div>
				) : (
					<div className="flex flex-col gap-1.5">
						<div className="flex items-center justify-between text-xs text-muted-foreground">
							<span>{op.phase ?? t("Starting…")}</span>
							<span className="tabular font-mono">{op.percent !== null ? `${Math.round(op.percent)}%` : ""}</span>
						</div>
						<Progress value={op.percent ?? 100} className={cn(op.percent === null && "animate-pulse")} />
						<p className="text-2xs text-subtle">{t("The clone keeps running on the machine if you close this dialog.")}</p>
					</div>
				)}
				<DialogFooter>
					{failed ? (
						<>
							<Button variant="ghost" onClick={onClose}>
								{t("Close")}
							</Button>
							<Button
								variant="primary"
								onClick={() => {
									setOp(null);
									start.reset();
								}}
							>
								{t("Try again")}
							</Button>
						</>
					) : (
						<Button
							variant="outline"
							onClick={() => {
								finished.current = true;
								trackInBackground(op, repo?.fullName ?? t("repository"), qc, openProject);
								onClose();
							}}
						>
							{t("Run in background")}
						</Button>
					)}
				</DialogFooter>
			</div>
		);
	}

	return (
		<form
			className="scrollbar-thin -mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1"
			onSubmit={(e) => {
				e.preventDefault();
				if (ready) start.mutate();
			}}
		>
			{workspaceField}
			{noAccounts ? (
				<p role="status" className="rounded-lg bg-warning/10 px-3 py-2.5 text-[13px] text-warning">
					{t("No usable GitHub account is connected.")}{" "}
					<Link to="/settings/github" onClick={onClose} className="font-medium underline underline-offset-2">
						{t("Connect one in Settings → GitHub Accounts")}
					</Link>
					.
				</p>
			) : (
				<Field label={t("GitHub account")}>
					{() => (
						<Select
							value={accountId}
							onValueChange={(v) => {
								setAccountId(v);
								setRepo(null);
							}}
						>
							<SelectTrigger>
								<SelectValue placeholder={accounts.isPending ? t("Loading accounts…") : t("Select account")} />
							</SelectTrigger>
							<SelectContent>
								{accounts.data?.map((a) => (
									<SelectItem key={a.id} value={a.id} disabled={a.status === "invalid"}>
										{t("@{login}{isDefault, select, true { · default} other {}}{invalid, select, true { · needs reconnect} other {}}", { login: a.login, isDefault: String(a.isDefault), invalid: String(a.status === "invalid") })}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</Field>
			)}
			{accountId ? (
				<Field label={t("Repository")}>
					{() => <RepoPicker accountId={accountId} selected={repo} onSelect={setRepo} />}
				</Field>
			) : null}
			{repo ? (
				<>
					<Field label={t("Branch")} hint={t("Optional — defaults to {branch}", { branch: repo.defaultBranch })}>
						{(id) => <Input id={id} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={repo.defaultBranch} className="font-mono text-xs" spellCheck={false} autoCapitalize="off" />}
					</Field>
					<Field label={t("Clone into")} hint={t("Must not exist or be empty. Start typing for directory suggestions.")} error={start.error ? errorText(start.error) : null}>
						{() => (
							<DirPicker
								value={path}
								onChange={(v) => {
									setPathTouched(true);
									setPath(v);
									start.reset();
								}}
								invalid={Boolean(start.error)}
							/>
						)}
					</Field>
				</>
			) : null}
			<DialogFooter>
				<Button variant="ghost" onClick={onClose}>
					{t("Cancel")}
				</Button>
				<Button type="submit" variant="primary" loading={start.isPending} disabled={!ready}>
					{t("Clone repository")}
				</Button>
			</DialogFooter>
		</form>
	);
}
