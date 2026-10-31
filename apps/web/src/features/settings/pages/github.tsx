import { useEffect, useState } from "react";
import { ExternalLink, FolderGit2, KeyRound, Plug, RefreshCw, Star, Terminal, Trash2, UserX } from "lucide-react";
import { toast } from "sonner";
import type { GithubAccount } from "@clam/contracts";
import { errorMessage } from "@/lib/api";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Skeleton } from "@/ui/skeleton";
import { StatusDot } from "@/ui/status-dot";
import { fmtAgo } from "@/features/usage/format";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { GithubDeviceFlowDialog } from "../components/github-device-flow";
import { GithubReposDialog } from "../components/github-repos";
import { InlineError, PageBody, PageIntro, SettingsSection } from "../components/section";
import {
	useDisconnectAccount,
	useGithubAccounts,
	useGithubConfig,
	useImportGh,
	useSetDefaultAccount,
	useUpdateGithubConfig,
	useVerifyAccount,
} from "../hooks";

function ClientIdCard() {
	const cfg = useGithubConfig();
	const update = useUpdateGithubConfig();
	const [value, setValue] = useState("");
	const [editing, setEditing] = useState(false);
	const configured = Boolean(cfg.data?.clientId);

	useEffect(() => {
		if (cfg.data) setValue(cfg.data.clientId ?? "");
	}, [cfg.data]);

	const save = () =>
		update.mutate(value.trim() === "" ? null : value.trim(), {
			onSuccess: () => {
				toast.success("OAuth client id saved");
				setEditing(false);
			},
			onError: (e) => toast.error("Could not save client id", { description: errorMessage(e) }),
		});

	return (
		<SettingsSection
			title="OAuth App"
			description="The device flow needs a GitHub OAuth App client id. Client ids are public; no client secret is used or stored."
			actions={configured && !editing ? <Badge variant="success">Configured</Badge> : <Badge variant="warning">Not configured</Badge>}
		>
			{cfg.isError && <InlineError error={cfg.error} onRetry={() => cfg.refetch()} />}
			{cfg.isPending && <Skeleton className="h-10" />}
			{cfg.data && (
				<div className="space-y-4">
					{configured && !editing ? (
						<div className="flex flex-wrap items-center gap-2">
							<code className="rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-xs">{cfg.data.clientId}</code>
							<Button size="sm" variant="outline" onClick={() => setEditing(true)}>
								Change
							</Button>
						</div>
					) : (
						<form
							className="flex flex-col gap-2 sm:flex-row"
							onSubmit={(e) => {
								e.preventDefault();
								save();
							}}
						>
							<Input
								value={value}
								onChange={(e) => setValue(e.target.value)}
								placeholder="Iv1.xxxxxxxxxxxxxxxx"
								aria-label="GitHub OAuth App client id"
								className="font-mono sm:max-w-sm"
								autoComplete="off"
								spellCheck={false}
							/>
							<div className="flex gap-2">
								<Button type="submit" loading={update.isPending} disabled={value.trim() === "" && !configured}>
									Save
								</Button>
								{configured && (
									<Button type="button" variant="ghost" onClick={() => (setEditing(false), setValue(cfg.data?.clientId ?? ""))}>
										Cancel
									</Button>
								)}
							</div>
						</form>
					)}
					{!configured && (
						<div className="rounded-lg border border-border bg-surface-1 p-3.5 text-sm">
							<div className="mb-2 font-medium">Create a GitHub OAuth App</div>
							<ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
								<li>
									Open{" "}
									<a className="inline-flex items-center gap-1 text-accent hover:underline" href="https://github.com/settings/developers" target="_blank" rel="noreferrer">
										github.com/settings/developers <ExternalLink className="size-3" />
									</a>{" "}
									→ <b className="text-foreground">OAuth Apps</b> → <b className="text-foreground">New OAuth App</b>.
								</li>
								<li>
									Name it “CL Agent Mesh”, set any homepage URL and <span className="font-mono">http://127.0.0.1:4317</span> as the callback URL (not used by the device flow).
								</li>
								<li>
									After creating it, tick <b className="text-foreground">Enable Device Flow</b> and save.
								</li>
								<li>Copy the <b className="text-foreground">Client ID</b> and paste it above.</li>
							</ol>
							<p className="mt-2 text-xs text-muted-foreground">
								Requested scopes: <span className="font-mono">{cfg.data.scopes.join(", ") || "—"}</span>
							</p>
						</div>
					)}
				</div>
			)}
		</SettingsSection>
	);
}

function AccountAvatar({ a }: { a: GithubAccount }) {
	const [broken, setBroken] = useState(false);
	return a.avatarUrl && !broken ? (
		<img
			src={a.avatarUrl}
			alt=""
			width={40}
			height={40}
			loading="lazy"
			referrerPolicy="no-referrer"
			onError={() => setBroken(true)}
			className="size-10 shrink-0 rounded-full border border-border bg-surface-2 object-cover"
		/>
	) : (
		<div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 font-mono text-sm uppercase">
			{a.login.slice(0, 2)}
		</div>
	);
}

function AccountCard({ a, onBrowse, onDisconnect }: { a: GithubAccount; onBrowse: () => void; onDisconnect: () => void }) {
	const setDefault = useSetDefaultAccount();
	const verify = useVerifyAccount();
	const statusDot = a.status === "connected" ? "ok" : a.status === "invalid" ? "down" : "degraded";
	return (
		<li className="rounded-lg border border-border bg-surface-1 p-3.5">
			<div className="flex items-start gap-3">
				<AccountAvatar a={a} />
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span className="truncate font-mono text-sm font-medium">{a.login}</span>
						{a.isDefault && (
							<Badge variant="accent" className="gap-1">
								<Star className="size-3" />
								Default
							</Badge>
						)}
						<Badge variant="outline" className="gap-1">
							{a.source === "gh-cli" ? <Terminal className="size-3" /> : <KeyRound className="size-3" />}
							{a.source === "gh-cli" ? "gh CLI" : "OAuth device"}
						</Badge>
					</div>
					<div className="truncate text-xs text-muted-foreground">
						{[a.name, a.email].filter(Boolean).join(" · ") || "No name or email visible with the granted scopes"}
					</div>
					<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
						<span className="inline-flex items-center gap-1.5">
							<StatusDot status={statusDot} />
							{a.status === "connected" ? "Connected" : a.status === "invalid" ? "Token invalid — reconnect" : "Not verified"}
						</span>
						<span className="text-muted-foreground">Verified {fmtAgo(a.lastVerifiedAt)}</span>
					</div>
					{a.scopes.length > 0 && (
						<div className="mt-2 flex flex-wrap gap-1">
							{a.scopes.map((s) => (
								<span key={s} className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
									{s}
								</span>
							))}
						</div>
					)}
				</div>
			</div>
			<div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
				<Button size="sm" variant="secondary" onClick={onBrowse}>
					<FolderGit2 className="size-3.5" />
					Repositories
				</Button>
				<Button
					size="sm"
					variant="outline"
					loading={verify.isPending}
					onClick={() =>
						verify.mutate(a.id, {
							onSuccess: (acc) =>
								acc.status === "connected" ? toast.success(`${acc.login} is connected`) : toast.error(`${acc.login}: token is no longer valid`, { description: "Disconnect and connect the account again." }),
							onError: (e) => toast.error("Verification failed", { description: errorMessage(e) }),
						})
					}
				>
					<RefreshCw className="size-3.5" />
					Verify
				</Button>
				{!a.isDefault && (
					<Button
						size="sm"
						variant="outline"
						onClick={() => setDefault.mutate(a.id, { onError: (e) => toast.error("Could not set default", { description: errorMessage(e) }) })}
					>
						<Star className="size-3.5" />
						Make default
					</Button>
				)}
				<Button size="sm" variant="ghost" className="ml-auto text-danger hover:text-danger" onClick={onDisconnect}>
					<Trash2 className="size-3.5" />
					Disconnect
				</Button>
			</div>
		</li>
	);
}

export default function GithubPage() {
	const cfg = useGithubConfig();
	const accounts = useGithubAccounts();
	const importGh = useImportGh();
	const disconnect = useDisconnectAccount();
	const [deviceOpen, setDeviceOpen] = useState(false);
	const [browse, setBrowse] = useState<GithubAccount | null>(null);
	const [toDisconnect, setToDisconnect] = useState<GithubAccount | null>(null);

	const canDevice = Boolean(cfg.data?.clientId);

	return (
		<>
			<PageIntro
				title="GitHub Accounts"
				description="Connect one or more GitHub accounts to this machine. Tokens are kept in this machine's secret store and never leave it. Other machines can use different accounts."
				actions={
					<div className="flex flex-wrap gap-2">
						{cfg.data?.ghCliAvailable && (
							<Button
								variant="outline"
								loading={importGh.isPending}
								onClick={() =>
									importGh.mutate(undefined, {
										onSuccess: (a) => toast.success(`Imported ${a.login} from the gh CLI`),
										onError: (e) => toast.error("gh import failed", { description: errorMessage(e) }),
									})
								}
							>
								<Terminal className="size-4" />
								Import from gh CLI
							</Button>
						)}
						<Button onClick={() => setDeviceOpen(true)} disabled={!canDevice} title={canDevice ? undefined : "Configure an OAuth App client id first"}>
							<Plug className="size-4" />
							Connect account
						</Button>
					</div>
				}
			/>
			<PageBody>
				<ClientIdCard />
				<SettingsSection title="Connected accounts" description="The default account is used for new repository links and pull requests unless a project selects another.">
					{accounts.isError && <InlineError error={accounts.error} onRetry={() => accounts.refetch()} />}
					{accounts.isPending && (
						<div className="space-y-3">
							<Skeleton className="h-32" />
						</div>
					)}
					{accounts.data && accounts.data.length === 0 && (
						<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-8 text-center">
							<UserX className="size-6 text-muted-foreground" />
							<div className="text-sm font-medium">No GitHub accounts connected</div>
							<p className="max-w-sm text-xs text-muted-foreground">
								{cfg.data?.ghCliAvailable
									? "Import the account the gh CLI is signed in with, or connect through the device flow."
									: canDevice
										? "Connect an account with the device flow."
										: "Add an OAuth App client id above to enable the device flow."}
							</p>
						</div>
					)}
					{accounts.data && accounts.data.length > 0 && (
						<ul className="space-y-3">
							{accounts.data.map((a) => (
								<AccountCard key={a.id} a={a} onBrowse={() => setBrowse(a)} onDisconnect={() => setToDisconnect(a)} />
							))}
						</ul>
					)}
				</SettingsSection>
			</PageBody>

			<GithubDeviceFlowDialog open={deviceOpen} onOpenChange={setDeviceOpen} />
			<GithubReposDialog account={browse} open={browse != null} onOpenChange={(o) => !o && setBrowse(null)} />
			<ConfirmDialog
				open={toDisconnect != null}
				onOpenChange={(o) => !o && setToDisconnect(null)}
				title={`Disconnect ${toDisconnect?.login ?? ""}?`}
				description="The stored token is deleted from this machine's secret store. Projects linked to this account keep their repository reference but cannot use it until an account is connected again."
				confirmLabel="Disconnect"
				danger
				loading={disconnect.isPending}
				onConfirm={() => {
					if (!toDisconnect) return;
					disconnect.mutate(toDisconnect.id, {
						onSuccess: () => toast.success(`Disconnected ${toDisconnect.login}`),
						onError: (e) => toast.error("Could not disconnect", { description: errorMessage(e) }),
						onSettled: () => setToDisconnect(null),
					});
				}}
			/>
		</>
	);
}
