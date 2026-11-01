import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, FolderGit2, Link2, Lock, Search, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import type { GithubAccount, GithubRepo, Project, RepoPermissionCheck } from "@clam/contracts";
import { t } from "@/i18n";
import { errorText } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { Input } from "@/ui/input";
import { Skeleton } from "@/ui/skeleton";
import { fmtAgo } from "@/features/usage/format";
import { useGithubRepos, useLinkRepository, useProjects, useRepoCheck } from "../hooks";
import { InlineError } from "./section";

const ROW_HEIGHT = 104;

function useDebounced<T>(value: T, ms: number): T {
	const [v, setV] = useState(value);
	useEffect(() => {
		const id = setTimeout(() => setV(value), ms);
		return () => clearTimeout(id);
	}, [value, ms]);
	return v;
}

function PermChip({ ok, label }: { ok: boolean; label: string }) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]",
				ok ? "border-success/30 bg-success/10 text-success" : "border-danger/30 bg-danger/10 text-danger",
			)}
		>
			{ok ? <Check className="size-3" /> : <X className="size-3" />}
			{label}
		</span>
	);
}

function RepoRow({
	repo,
	account,
	projects,
	check,
	checking,
	onCheck,
	onLink,
}: {
	repo: GithubRepo;
	account: GithubAccount;
	projects: Project[];
	check: RepoPermissionCheck | undefined;
	checking: boolean;
	onCheck: () => void;
	onLink: (p: Project) => void;
}) {
	const linked = projects.filter((p) => p.repository?.externalId === repo.id);
	return (
		<div className="flex h-full flex-col justify-center gap-1.5 border-b border-border/60 px-1 py-2">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<a
							href={repo.htmlUrl}
							target="_blank"
							rel="noreferrer"
							className="truncate font-mono text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
						>
							{repo.fullName}
						</a>
					</div>
					<div className="truncate text-xs text-muted-foreground">{repo.description ?? t("No description")}</div>
				</div>
				<div className="flex shrink-0 gap-1.5">
					<Button size="sm" variant="outline" loading={checking} onClick={onCheck} aria-label={t("Check access to {repo}", { repo: repo.fullName })}>
						<ShieldCheck className="size-3.5" />
						<span className="hidden sm:inline">{t("Check access")}</span>
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button size="sm" variant="secondary" aria-label={t("Link {repo} to a project", { repo: repo.fullName })}>
								<Link2 className="size-3.5" />
								<span className="hidden sm:inline">{t("Link")}</span>
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="max-h-72 w-64 overflow-y-auto">
							<DropdownMenuLabel>{t("Link to project")}</DropdownMenuLabel>
							<DropdownMenuSeparator />
							{projects.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">{t("No projects yet. Create one first.")}</div>}
							{projects.map((p) => (
								<DropdownMenuItem key={p.id} onSelect={() => onLink(p)}>
									<span className="min-w-0 flex-1 truncate">{p.name}</span>
									{p.repository?.externalId === repo.id && <Check className="size-3.5 text-accent" />}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
			<div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
				{repo.private && (
					<Badge variant="outline" className="gap-1">
						<Lock className="size-3" />
						{t("Private")}
					</Badge>
				)}
				{linked.length > 0 && <Badge variant="accent">{t("Linked")}</Badge>}
				<span>{repo.pushedAt ? t("Pushed {when}", { when: fmtAgo(repo.pushedAt) }) : t("Never pushed")}</span>
				<span className="font-mono">{repo.defaultBranch}</span>
				{check ? (
					<span className="flex flex-wrap gap-1">
						<PermChip ok={check.clone} label={t("Clone")} />
						<PermChip ok={check.fetch} label={t("Fetch")} />
						<PermChip ok={check.push} label={t("Push")} />
						<PermChip ok={check.createPr} label={t("Create PR")} />
					</span>
				) : (
					<span className="flex gap-1">
						{repo.permissions.pull && <span>{t("pull")}</span>}
						{repo.permissions.push && <span>{t("push")}</span>}
						{repo.permissions.admin && <span>{t("admin")}</span>}
					</span>
				)}
			</div>
			<span className="sr-only">{account.login}</span>
		</div>
	);
}

export function GithubReposDialog({ account, open, onOpenChange }: { account: GithubAccount | null; open: boolean; onOpenChange: (o: boolean) => void }) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex h-[min(86dvh,720px)] max-w-2xl flex-col gap-3">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<FolderGit2 className="size-4" />
						{account ? t("Repositories · {login}", { login: account.login }) : t("Repositories")}
					</DialogTitle>
					<DialogDescription>{t("Check clone, fetch, push and pull-request access, or link a repository to a project.")}</DialogDescription>
				</DialogHeader>
				{open && account && <ReposBody account={account} />}
			</DialogContent>
		</Dialog>
	);
}

function ReposBody({ account }: { account: GithubAccount }) {
	const [q, setQ] = useState("");
	const dq = useDebounced(q.trim(), 300);
	const repos = useGithubRepos(account.id, dq);
	const projects = useProjects();
	const link = useLinkRepository();
	const checker = useRepoCheck();
	const [checks, setChecks] = useState<Record<string, RepoPermissionCheck>>({});
	const [checkingId, setCheckingId] = useState<string | null>(null);

	const items = useMemo(() => repos.data?.pages.flatMap((p) => p.items) ?? [], [repos.data]);
	const scrollRef = useRef<HTMLDivElement>(null);
	const virt = useVirtualizer({ count: items.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_HEIGHT, overscan: 6 });
	const vItems = virt.getVirtualItems();
	const last = vItems[vItems.length - 1];

	useEffect(() => {
		if (last && last.index >= items.length - 5 && repos.hasNextPage && !repos.isFetchingNextPage) void repos.fetchNextPage();
	}, [last?.index, items.length, repos.hasNextPage, repos.isFetchingNextPage, repos]);

	const doCheck = (r: GithubRepo) => {
		setCheckingId(r.id);
		checker.mutate(
			{ accountId: account.id, owner: r.owner, repo: r.name },
			{
				onSuccess: (res) => setChecks((c) => ({ ...c, [r.id]: res })),
				onError: (e) => toast.error(t("Access check failed for {repo}", { repo: r.fullName }), { description: errorText(e) }),
				onSettled: () => setCheckingId(null),
			},
		);
	};

	const doLink = (r: GithubRepo, p: Project) =>
		link.mutate(
			{
				projectId: p.id,
				repository: { owner: r.owner, name: r.name, externalId: r.id, htmlUrl: r.htmlUrl, defaultBranch: r.defaultBranch, accountId: account.id },
			},
			{
				onSuccess: () => toast.success(t("Linked {repo} to {project}", { repo: r.fullName, project: p.name })),
				onError: (e) => toast.error(t("Could not link repository"), { description: errorText(e) }),
			},
		);

	return (
		<>
			<div className="relative">
				<Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search repositories")} className="pl-8" aria-label={t("Search repositories")} />
			</div>
			{repos.isError && <InlineError error={repos.error} onRetry={() => repos.refetch()} />}
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
				{repos.isPending && (
					<div className="space-y-2">
						{Array.from({ length: 5 }, (_, i) => (
							<Skeleton key={i} className="h-20" />
						))}
					</div>
				)}
				{!repos.isPending && items.length === 0 && !repos.isError && (
					<div className="py-10 text-center text-sm text-muted-foreground">{dq ? t("No repositories match “{query}”.", { query: dq }) : t("This account has no accessible repositories.")}</div>
				)}
				<div style={{ height: virt.getTotalSize(), position: "relative" }}>
					{vItems.map((v) => {
						const r = items[v.index]!;
						return (
							<div key={r.id} className="absolute inset-x-0 top-0" style={{ height: v.size, transform: `translateY(${v.start}px)` }}>
								<RepoRow
									repo={r}
									account={account}
									projects={projects.data ?? []}
									check={checks[r.id]}
									checking={checkingId === r.id}
									onCheck={() => doCheck(r)}
									onLink={(p) => doLink(r, p)}
								/>
							</div>
						);
					})}
				</div>
				{repos.isFetchingNextPage && <Skeleton className="mt-2 h-16" />}
			</div>
		</>
	);
}
