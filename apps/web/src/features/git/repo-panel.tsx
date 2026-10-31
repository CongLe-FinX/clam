import type { GitStatus, Project } from "@clam/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, FolderGit2, FolderOpen, GitFork, Link2Off, ShieldCheck, Sparkles } from "lucide-react";
import { CopyButton } from "@/components/code-block";
import { useGithubAccounts } from "@/features/settings/hooks";
import { cn, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { initClmesh } from "./ops.ts";
import { useGitUi } from "./store.ts";

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
	return (
		<section className={cn("flex flex-col gap-2.5 rounded-xl bg-surface-1 p-3.5 shadow-[inset_0_0_0_1px_var(--border)]", className)}>
			<h3 className="text-2xs font-semibold uppercase tracking-wider text-subtle">{title}</h3>
			{children}
		</section>
	);
}

export function RepoPanel({ project, status, onShowChanges }: { project: Project; status: GitStatus; onShowChanges: () => void }) {
	const qc = useQueryClient();
	const accounts = useGithubAccounts();
	const busy = useGitUi((s) => s.busy[project.id]);
	const repo = project.repository;
	const account = repo?.accountId ? accounts.data?.find((a) => a.id === repo.accountId) : undefined;
	const hasClmesh = status.files.some((f) => f.path.startsWith(".clmesh/"));

	return (
		<div className="scrollbar-thin flex h-full min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain p-3">
			<Card title="Linked repository">
				{repo ? (
					<>
						<a
							href={repo.htmlUrl}
							target="_blank"
							rel="noreferrer noopener"
							className="group flex min-w-0 items-center gap-2.5 rounded-lg bg-surface-2 px-3 py-2.5 outline-none transition-colors hover:bg-surface-3 focus-visible:shadow-[0_0_0_2px_var(--accent)]"
						>
							<GitFork aria-hidden className="size-5 shrink-0" />
							<span className="min-w-0 flex-1">
								<span className="block truncate font-mono text-[13px] font-medium">
									{repo.owner}/{repo.name}
								</span>
								<span className="block truncate text-2xs text-subtle">{repo.htmlUrl.replace(/^https?:\/\//, "")}</span>
							</span>
							<ExternalLink aria-hidden className="size-4 shrink-0 text-subtle group-hover:text-foreground" />
						</a>
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
							<dt className="text-muted-foreground">Default branch</dt>
							<dd className="text-right font-mono">{repo.defaultBranch ?? "—"}</dd>
							<dt className="text-muted-foreground">Account</dt>
							<dd className="text-right">
								{account ? (
									<span className="inline-flex items-center gap-1.5">
										<span className="font-medium">@{account.login}</span>
										{account.status !== "connected" ? <Badge variant="danger">{account.status}</Badge> : null}
									</span>
								) : repo.accountId ? (
									<span className="text-warning">Account removed</span>
								) : (
									<Link to="/settings/github" className="text-accent underline underline-offset-2">
										Choose in Settings
									</Link>
								)}
							</dd>
						</dl>
					</>
				) : (
					<div className="flex items-start gap-2.5 text-[13px] text-muted-foreground">
						<Link2Off aria-hidden className="mt-0.5 size-4 shrink-0 text-subtle" />
						<p>
							This project is not linked to a GitHub repository. Link one in{" "}
							<Link to="/settings/github" className="text-accent underline underline-offset-2">
								Settings → GitHub Accounts
							</Link>{" "}
							to enable pull requests and authenticated fetch/push.
						</p>
					</div>
				)}
			</Card>

			<Card title="Local checkout">
				<div className="flex min-w-0 items-center gap-1">
					<FolderOpen aria-hidden className="size-4 shrink-0 text-subtle" />
					<span className="min-w-0 flex-1 truncate font-mono text-xs" title={project.path}>
						{project.path}
					</span>
					<CopyButton text={project.path} label="Copy path" />
				</div>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
					<dt className="text-muted-foreground">Branch</dt>
					<dd className="truncate text-right font-mono">{status.branch ?? (status.detached ? "detached HEAD" : "—")}</dd>
					<dt className="text-muted-foreground">Upstream</dt>
					<dd className="truncate text-right font-mono">{status.upstream ?? <span className="font-sans text-subtle">none</span>}</dd>
					<dt className="text-muted-foreground">Last fetch</dt>
					<dd className="text-right">{status.lastFetchedAt ? relativeTime(status.lastFetchedAt) : <span className="text-subtle">never</span>}</dd>
				</dl>
				{status.remotes.length > 0 ? (
					<ul className="flex flex-col gap-1 border-t pt-2.5">
						{status.remotes.map((r) => (
							<li key={r.name} className="flex min-w-0 items-center gap-2 text-xs">
								<Badge variant="outline">{r.name}</Badge>
								<span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={r.url}>
									{r.url}
								</span>
								<CopyButton text={r.url} label={`Copy ${r.name} URL`} className="size-6" />
							</li>
						))}
					</ul>
				) : (
					<p className="border-t pt-2.5 text-xs text-subtle">No remotes configured.</p>
				)}
			</Card>

			<Card title=".clmesh">
				<p className="text-xs leading-relaxed text-muted-foreground">
					<code className="rounded bg-surface-3 px-1 font-mono text-2xs">.clmesh/</code> holds the project data CL Agent Mesh shares through Git: a README and a config file. Everything written is scanned for secrets and refused if anything looks like one. Nothing is committed for you.
				</p>
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" variant="outline" loading={busy === "clmesh"} onClick={() => void initClmesh(qc, project.id).then((r) => r && r.written.length > 0 && onShowChanges())}>
						<Sparkles /> {hasClmesh ? "Re-run initialization" : "Initialize .clmesh"}
					</Button>
					<span className="inline-flex items-center gap-1 text-2xs text-subtle">
						<ShieldCheck aria-hidden className="size-3.5" /> Existing files are never overwritten
					</span>
				</div>
			</Card>

			<p className="flex items-center gap-1.5 px-1 text-2xs text-subtle">
				<FolderGit2 aria-hidden className="size-3.5" /> Credentials stay in this machine's secret store — never in remote URLs, <code className="font-mono">.git/config</code> or process arguments.
			</p>
		</div>
	);
}
