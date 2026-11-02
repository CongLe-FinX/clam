import { type GitStatus, parseCheckoutId, type PullRequest, routes } from "@clam/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, CircleDashed, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Plus, RefreshCw, UploadCloud, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { msg, T, t, tr, type Msg } from "@/i18n";
import { ApiError, api, errorText } from "@/lib/api";
import { useProject } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { EmptyState } from "@/ui/empty-state";
import { Field } from "@/ui/field";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Skeleton } from "@/ui/skeleton";
import { Switch } from "@/ui/switch";
import { Textarea } from "@/ui/textarea";
import { Tip } from "@/ui/tooltip";
import { gk, type PullState, useBranches, usePullRequests } from "./hooks.ts";
import { runPush } from "./ops.ts";
import { normalizeRemoteBranch } from "./status-utils.ts";

const STATES: Array<{ id: PullState; label: Msg }> = [
	{ id: "open", label: msg("Open") },
	{ id: "closed", label: msg("Closed") },
	{ id: "all", label: msg("All") },
];

function prIcon(pr: PullRequest) {
	if (pr.state === "merged") return <GitMerge className="size-4 text-accent" aria-label={t("Merged")} />;
	if (pr.state === "closed") return <GitPullRequestClosed className="size-4 text-danger" aria-label={t("Closed")} />;
	if (pr.draft) return <GitPullRequestDraft className="size-4 text-subtle" aria-label={t("Draft")} />;
	return <GitPullRequest className="size-4 text-success" aria-label={t("Open")} />;
}

function ChecksBadge({ checks }: { checks: NonNullable<PullRequest["checks"]> }) {
	switch (checks) {
		case "success":
			return (
				<Badge variant="success">
					<CheckCircle2 aria-hidden /> {t("Checks passing")}
				</Badge>
			);
		case "failure":
			return (
				<Badge variant="danger">
					<XCircle aria-hidden /> {t("Checks failing")}
				</Badge>
			);
		case "pending":
			return (
				<Badge variant="warning">
					<CircleDashed aria-hidden /> {t("Checks running")}
				</Badge>
			);
		default:
			return <Badge variant="neutral">{t("No checks")}</Badge>;
	}
}

function PullRow({ pr }: { pr: PullRequest }) {
	return (
		<li className="flex gap-2.5 border-b px-3 py-2.5 transition-colors hover:bg-surface-2">
			<span className="pt-0.5">{prIcon(pr)}</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<div className="flex min-w-0 items-start gap-2">
					<a href={pr.htmlUrl} target="_blank" rel="noreferrer noopener" className="min-w-0 flex-1 text-[13px] font-medium leading-snug outline-none hover:underline focus-visible:underline">
						{pr.title} <span className="font-normal text-subtle">#{pr.number}</span>
					</a>
					<Tip label={t("Open on GitHub")}>
						<a href={pr.htmlUrl} target="_blank" rel="noreferrer noopener" aria-label={t("Open pull request #{number} on GitHub", { number: pr.number })} className="grid size-6 shrink-0 place-items-center rounded-md text-subtle outline-none hover:bg-surface-3 hover:text-foreground coarse:size-9">
							<ExternalLink className="size-3.5" />
						</a>
					</Tip>
				</div>
				<div className="flex min-w-0 flex-wrap items-center gap-1.5">
					<Badge variant={pr.state === "open" ? "success" : pr.state === "merged" ? "accent" : "danger"}>
						{pr.state === "open" ? t("Open") : pr.state === "merged" ? t("Merged") : t("Closed")}
					</Badge>
					{pr.draft ? <Badge variant="neutral">{t("Draft")}</Badge> : null}
					{pr.checks ? <ChecksBadge checks={pr.checks} /> : null}
					{pr.state === "open" ? (
						pr.mergeable === false ? (
							<Badge variant="danger">
								<AlertCircle aria-hidden /> {t("Conflicts")}
							</Badge>
						) : pr.mergeable === true ? (
							<Badge variant="success">{t("Mergeable")}</Badge>
						) : (
							<Badge variant="neutral">{t("Checking mergeability…")}</Badge>
						)
					) : null}
				</div>
				<p className="truncate font-mono text-2xs text-subtle">
					<span className="text-muted-foreground">{pr.head}</span> → {pr.base} · {pr.author} · {relativeTime(pr.updatedAt)}
				</p>
			</div>
		</li>
	);
}

export function PullRequestsPanel({ projectId, status, onCreate, active }: { projectId: string; status: GitStatus; onCreate: () => void; active: boolean }) {
	const [state, setState] = useState<PullState>("open");
	const q = usePullRequests(projectId, state, active);
	const hasGithub = status.remotes.some((r) => r.github);
	const noRepo = q.error instanceof ApiError && (q.error.code === "no_repository" || q.error.code === "no_github_account");

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b px-2.5 py-2">
				<div role="group" aria-label={t("Pull request state")} className="flex rounded-lg bg-surface-2 p-0.5">
					{STATES.map((s) => (
						<button
							key={s.id}
							type="button"
							aria-pressed={state === s.id}
							onClick={() => setState(s.id)}
							className={cn("h-6 rounded-md px-2.5 text-xs font-medium outline-none transition-colors coarse:h-9", state === s.id ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:text-foreground")}
						>
							{tr(s.label)}
						</button>
					))}
				</div>
				<Tip label={t("Refresh")}>
					<Button variant="ghost" size="icon-sm" aria-label={t("Refresh pull requests")} onClick={() => void q.refetch()} disabled={q.isFetching}>
						<RefreshCw className={cn(q.isFetching && "animate-spin")} />
					</Button>
				</Tip>
				<Button variant="primary" size="sm" className="ml-auto" onClick={onCreate} disabled={!hasGithub || !status.branch}>
					<Plus /> {t("New")}
				</Button>
			</div>
			<div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain">
				{q.isPending ? (
					<div className="flex flex-col gap-2 p-3" aria-busy>
						<Skeleton className="h-16" />
						<Skeleton className="h-16" />
					</div>
				) : q.error ? (
					<EmptyState
						icon={GitPullRequest}
						title={noRepo ? t("No GitHub repository linked") : t("Could not load pull requests")}
						description={errorText(q.error)}
						action={
							noRepo ? undefined : (
								<Button size="sm" variant="outline" onClick={() => void q.refetch()}>
									<RefreshCw /> {t("Retry")}
								</Button>
							)
						}
					/>
				) : q.data.length === 0 ? (
					<EmptyState
						icon={GitPullRequest}
						title={state === "open" ? t("No open pull requests") : state === "closed" ? t("No closed pull requests") : t("No pull requests")}
						description={hasGithub ? t("Push a branch and open a pull request from here.") : t("This repository has no GitHub remote.")}
						className="py-10"
					/>
				) : (
					<ul>
						{q.data.map((pr) => (
							<PullRow key={pr.number} pr={pr} />
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

// ───────────────────────────── create ─────────────────────────────

export function CreatePullRequestDialog({
	projectId,
	status,
	prefill,
	onClose,
	onCreated,
}: {
	projectId: string;
	status: GitStatus;
	/** Title/description to start from (e.g. a delegated task's result) instead of the current branch's last commit. */
	prefill?: { title: string; body: string };
	onClose: () => void;
	onCreated: (pr: PullRequest) => void;
}) {
	const qc = useQueryClient();
	const project = useProject(parseCheckoutId(projectId).projectId).data;
	const branches = useBranches(projectId);
	const head = status.branch;
	const defaultBase = project?.repository?.defaultBranch ?? "main";
	const [base, setBase] = useState("");
	const [title, setTitle] = useState(prefill?.title ?? "");
	const [titleTouched, setTitleTouched] = useState(Boolean(prefill));
	const [body, setBody] = useState(prefill?.body ?? "");
	const [draft, setDraft] = useState(false);
	const [error, setError] = useState<{ message: string; url?: string; ssoUrl?: string } | null>(null);

	const baseOptions = useMemo(() => {
		const names = new Set<string>([defaultBase]);
		for (const b of branches.data ?? []) if (!b.name.endsWith("/HEAD")) names.add(normalizeRemoteBranch(b.name));
		if (head) names.delete(head);
		return [...names].sort((a, b) => (a === defaultBase ? -1 : b === defaultBase ? 1 : a.localeCompare(b)));
	}, [branches.data, defaultBase, head]);
	useEffect(() => {
		if (!base && baseOptions.length > 0) setBase(baseOptions.includes(defaultBase) ? defaultBase : (baseOptions[0] ?? ""));
	}, [base, baseOptions, defaultBase]);

	const subject = branches.data?.find((b) => b.current && !b.remote)?.subject;
	useEffect(() => {
		if (!titleTouched && subject) setTitle(subject);
	}, [subject, titleTouched]);

	const needsPush = !status.upstream || status.ahead > 0;
	const sameAsBase = head !== null && head === base;

	const create = useMutation({
		mutationFn: async () => {
			if (needsPush) {
				const pushed = await runPush(qc, projectId, { setUpstream: true, quiet: true });
				if (!pushed) throw new Error(t("The push failed — see the notice in the Git panel for the remote's message."));
				if (pushed.result === "rejected") throw new Error(pushed.message || t("The push was rejected."));
			}
			return api.post<PullRequest>(routes.gitPullRequests(projectId), { title: title.trim(), body, base, head: head ?? undefined, draft });
		},
		onSuccess: (pr) => {
			void qc.invalidateQueries({ queryKey: gk.pullsRoot(projectId) });
			toast.success(t("Pull request #{number} created", { number: pr.number }), { description: pr.title, action: { label: t("Open"), onClick: () => window.open(pr.htmlUrl, "_blank", "noopener,noreferrer") } });
			onCreated(pr);
		},
		onError: (e) => {
			const d = e instanceof ApiError && e.details && typeof e.details === "object" ? (e.details as { url?: unknown; ssoUrl?: unknown }) : {};
			setError({ message: errorText(e), url: typeof d.url === "string" ? d.url : undefined, ssoUrl: typeof d.ssoUrl === "string" ? d.ssoUrl : undefined });
		},
	});

	const ready = Boolean(head && base && title.trim() && !sameAsBase && !status.detached);
	return (
		<Dialog open onOpenChange={(o) => !o && !create.isPending && onClose()}>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<DialogTitle>{t("Create pull request")}</DialogTitle>
					<DialogDescription>
						{head ? (
							<T
								text="Open a pull request from <b>{head}</b> into <b>{base}</b>."
								params={{ head, base: base || defaultBase }}
								tags={{ b: <span className="font-mono text-foreground" /> }}
							/>
						) : (
							t("Check out a branch first.")
						)}
					</DialogDescription>
				</DialogHeader>
				<form
					className="scrollbar-thin -mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1"
					onSubmit={(e) => {
						e.preventDefault();
						setError(null);
						if (ready) create.mutate();
					}}
				>
					<div className="grid gap-3 sm:grid-cols-2">
						<Field label={t("Base branch")} hint={t("Merge into")}>
							{() => (
								<Select value={base} onValueChange={setBase}>
									<SelectTrigger>
										<SelectValue placeholder={t("Select base")} />
									</SelectTrigger>
									<SelectContent>
										{baseOptions.map((b) => (
											<SelectItem key={b} value={b}>
												<span className="font-mono text-xs">{b}</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</Field>
						<Field label={t("Compare branch")} hint={t("Current branch")}>
							{(id) => <Input id={id} value={head ?? ""} readOnly className="font-mono text-xs" />}
						</Field>
					</div>
					{sameAsBase ? (
						<p role="alert" className="text-xs text-danger">
							{t("The compare branch is the base branch. Create or switch to another branch first.")}
						</p>
					) : null}
					<Field label={t("Title")}>
						{(id) => (
							<Input
								id={id}
								autoFocus
								value={title}
								maxLength={256}
								onChange={(e) => {
									setTitleTouched(true);
									setTitle(e.target.value);
								}}
								placeholder={t("Summarize the change")}
							/>
						)}
					</Field>
					<Field label={t("Description")} hint={t("Markdown supported. Optional.")}>
						{(id) => <Textarea id={id} value={body} onChange={(e) => setBody(e.target.value)} rows={5} />}
					</Field>
					<label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
						<Switch checked={draft} onCheckedChange={setDraft} aria-label={t("Create as draft")} />
						<span>
							{t("Create as draft")}
							<span className="block text-xs text-subtle">{t("Draft pull requests cannot be merged until marked ready.")}</span>
						</span>
					</label>
					{needsPush ? (
						<p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning" role="status">
							<UploadCloud className="mt-0.5 size-4 shrink-0" />
							{status.upstream
								? t("{count, plural, one {# commit is} other {# commits are}} not pushed yet. They will be pushed to {upstream} first.", { count: status.ahead, upstream: status.upstream })
								: t("{branch} is not on GitHub yet. It will be pushed (and set to track origin) before the pull request is created.", { branch: head ?? t("This branch") })}
						</p>
					) : null}
					{error ? (
						<div role="alert" className="flex flex-col gap-1.5 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
							<p className="whitespace-pre-wrap break-words font-mono">{error.message}</p>
							{error.url ? (
								<a href={error.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline underline-offset-2">
									{t("Open the existing pull request")} <ExternalLink className="size-3" />
								</a>
							) : null}
							{error.ssoUrl ? (
								<a href={error.ssoUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline underline-offset-2">
									{t("Authorize the token for SSO")} <ExternalLink className="size-3" />
								</a>
							) : null}
						</div>
					) : null}
					<DialogFooter>
						<Button variant="ghost" onClick={onClose} disabled={create.isPending}>
							{t("Cancel")}
						</Button>
						<Button type="submit" variant="primary" loading={create.isPending} disabled={!ready}>
							{needsPush ? <UploadCloud /> : <GitPullRequest />}
							{needsPush ? (draft ? t("Push & create draft PR") : t("Push & create PR")) : draft ? t("Create draft PR") : t("Create pull request")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
