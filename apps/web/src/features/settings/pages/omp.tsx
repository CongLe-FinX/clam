import { useState } from "react";
import { ArrowUpCircle, CheckCircle2, Download, Loader2, RefreshCw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { type LoginProvider, type OmpUpdateCheck, type OmpUpdateResult, routes } from "@clam/contracts";
import { T, t } from "@/i18n";
import { api, errorText } from "@/lib/api";
import { qk } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { OmpLoginDialog } from "../components/omp-login";
import { ModelCatalog } from "../components/omp-models";
import { ProvidersList } from "../components/omp-providers";
import { RolesEditor } from "../components/omp-roles";
import { CopyButton, InlineError, KeyValue, PageBody, PageIntro, SettingsSection } from "../components/section";
import { useModelRoles, useOmpModels, useOmpOverview } from "../hooks";

const UPDATE_KEY = ["local", "omp", "update"] as const;

/**
 * "Is there a newer OMP?" right where its version is shown: checked when the page opens (the server keeps the answer 10 min), checked again
 * on demand, and installed with one click through `omp update`. Agents already running keep their version until they restart.
 */
function OmpUpdatePanel() {
	const qc = useQueryClient();
	const check = useQuery({
		queryKey: UPDATE_KEY,
		queryFn: ({ signal }) => api.get<OmpUpdateCheck>(routes.ompUpdate, undefined, { signal }),
		staleTime: 10 * 60_000,
		retry: false,
	});
	const recheck = useMutation({
		mutationFn: () => api.get<OmpUpdateCheck>(routes.ompUpdate, { refresh: 1 }),
		onSuccess: (next) => qc.setQueryData(UPDATE_KEY, next),
		onError: (e) => toast.error(t("Could not check for OMP updates"), { description: errorText(e) }),
	});
	const install = useMutation({
		mutationFn: () => api.post<OmpUpdateResult>(routes.ompUpdate),
		onSuccess: (r) => {
			void qc.invalidateQueries({ queryKey: UPDATE_KEY });
			void qc.invalidateQueries({ queryKey: qk.ompProviders });
			void qc.invalidateQueries({ queryKey: qk.ompModels });
			if (!r.updated) {
				toast.info(t("OMP is already up to date"));
				return;
			}
			toast.success(t("OMP updated to {version}", { version: r.version?.replace(/^omp\//, "") ?? "?" }), {
				description: r.runningSessions > 0 ? t("{count, plural, one {# running session keeps} other {# running sessions keep}} the previous version until it restarts.", { count: r.runningSessions }) : undefined,
				duration: 8000,
			});
		},
		onError: (e) => toast.error(t("OMP update failed"), { description: errorText(e), duration: 12_000 }),
	});

	const data = check.data;
	const checking = check.isPending || recheck.isPending;
	const available = data?.available === true;
	return (
		<div
			className={cn(
				"mb-3 flex flex-wrap items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
				available ? "bg-accent-soft/60 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_35%,transparent)]" : "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)]",
			)}
		>
			<span className={cn("grid size-8 shrink-0 place-items-center rounded-full", available ? "bg-accent text-accent-foreground" : check.isError ? "bg-danger/12 text-danger" : "bg-success/12 text-success")}>
				{checking || install.isPending ? <Loader2 className="size-4 animate-spin" /> : available ? <ArrowUpCircle className="size-4" /> : check.isError ? <XCircle className="size-4" /> : <CheckCircle2 className="size-4" />}
			</span>
			<div className="min-w-0 flex-1">
				{install.isPending ? (
					<>
						<div className="font-medium">{t("Updating OMP to {version}…", { version: data?.latest ?? "" })}</div>
						<div className="text-xs text-muted-foreground">{t("Downloading and installing; this can take a minute. Running agents are not interrupted.")}</div>
					</>
				) : checking && !data ? (
					<div className="text-muted-foreground">{t("Checking for OMP updates…")}</div>
				) : check.isError ? (
					<>
						<div className="font-medium">{t("Could not check for OMP updates")}</div>
						<div className="truncate text-xs text-danger">{errorText(check.error)}</div>
					</>
				) : available ? (
					<>
						<div className="font-medium">{t("OMP {version} is available", { version: data.latest ?? "" })}</div>
						<div className="text-xs text-muted-foreground">{t("You have {current}. Agents that are running keep their version until they restart.", { current: data.current ?? "?" })}</div>
					</>
				) : data ? (
					<>
						<div className="font-medium">{t("OMP is up to date")}</div>
						<div className="text-xs text-muted-foreground">{t("Version {current} · checked {time}", { current: data.current ?? "?", time: relativeTime(data.checkedAt) })}</div>
					</>
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{available ? (
					<Button variant="primary" size="sm" loading={install.isPending} disabled={checking} onClick={() => install.mutate()}>
						<ArrowUpCircle /> {install.isPending ? t("Updating…") : t("Update to {version}", { version: data.latest ?? "" })}
					</Button>
				) : null}
				<Button variant="ghost" size="sm" loading={recheck.isPending} disabled={install.isPending || check.isPending} onClick={() => recheck.mutate()}>
					<RefreshCw /> {t("Check for new version")}
				</Button>
			</div>
		</div>
	);
}

export default function OmpPage() {
	const qc = useQueryClient();
	const overview = useOmpOverview();
	const models = useOmpModels();
	const roles = useModelRoles();
	const [loginFor, setLoginFor] = useState<LoginProvider | null>(null);

	const install = overview.data?.install;
	const notInstalled = install != null && !install.installed;

	return (
		<>
			<PageIntro
				title={t("OMP Providers & Login")}
				description={t("CL Agent Mesh runs agents on Oh My Pi (OMP). Sign-in, models and roles are managed through OMP's own CLI and RPC; credentials never pass through this app.")}
				actions={
					<Button
						variant="outline"
						onClick={() => {
							void qc.invalidateQueries({ queryKey: qk.ompProviders });
							void qc.invalidateQueries({ queryKey: qk.ompModels });
							void qc.invalidateQueries({ queryKey: qk.ompModelRoles });
						}}
					>
						<RefreshCw className="size-4" />
						{t("Refresh")}
					</Button>
				}
			/>
			<PageBody>
				<SettingsSection
					title={t("OMP installation")}
					actions={
						overview.data && (
							<Badge variant={install?.installed ? "success" : "danger"} className="gap-1">
								{install?.installed ? <CheckCircle2 /> : <XCircle />}
								{install?.installed ? t("Installed") : t("Not installed")}
							</Badge>
						)
					}
				>
					{overview.isPending && <Skeleton className="h-24" />}
					{overview.isError && <InlineError error={overview.error} onRetry={() => overview.refetch()} />}
					{install && install.installed && (
						<>
							<OmpUpdatePanel />
							<dl className="divide-y divide-border">
								<KeyValue label={t("Version")} mono>
									{install.version ?? t("unknown")}
								</KeyValue>
								<KeyValue label={t("Binary")} mono>
									{install.binaryPath ?? "—"}
								</KeyValue>
								<KeyValue label={t("Config directory")} mono>
									{install.configPath ?? "—"}
								</KeyValue>
								<KeyValue label={t("Default model")} mono>
									{overview.data?.defaultModel ?? t("Not set")}
								</KeyValue>
							</dl>
						</>
					)}
					{notInstalled && (
						<div className="space-y-3">
							<div className="flex items-start gap-2 text-sm">
								<Download className="mt-0.5 size-4 shrink-0 text-warning" />
								<div>
									<div className="font-medium">{t("OMP was not found on this machine.")}</div>
									{install.error && <div className="mt-1 break-words text-xs text-danger">{install.error}</div>}
									<p className="mt-1 text-xs text-muted-foreground">{t("Install it, then press Refresh. Agents cannot start without it.")}</p>
								</div>
							</div>
							<div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-2 p-2.5">
								<code className="min-w-0 truncate font-mono text-xs">bun install -g @oh-my-pi/pi-coding-agent</code>
								<CopyButton value="bun install -g @oh-my-pi/pi-coding-agent" />
							</div>
							<p className="text-xs text-muted-foreground">
								<T
									text="If OMP is installed in a non-standard location, make sure its <code>omp</code> binary is on the PATH of the process that runs CL Agent Mesh."
									tags={{ code: <span className="font-mono" /> }}
								/>
							</p>
						</div>
					)}
				</SettingsSection>

				{!notInstalled && (
					<>
						<SettingsSection title={t("Providers")} description={t("Providers OMP can sign in to. Add an account to make its models available to agents.")}>
							{overview.isPending && (
								<div className="space-y-2">
									<Skeleton className="h-14" />
									<Skeleton className="h-14" />
									<Skeleton className="h-14" />
								</div>
							)}
							{overview.data && <ProvidersList providers={overview.data.providers} onLogin={setLoginFor} />}
						</SettingsSection>

						<SettingsSection title={t("Model roles")} description={t("Which model OMP uses for each job. Changes are written to your OMP config.")}>
							{(roles.isPending || models.isPending) && (
								<div className="space-y-2">
									<Skeleton className="h-20" />
									<Skeleton className="h-20" />
								</div>
							)}
							{roles.isError && <InlineError error={roles.error} onRetry={() => roles.refetch()} />}
							{models.isError && <InlineError error={models.error} onRetry={() => models.refetch()} />}
							{roles.data && models.data && <RolesEditor roles={roles.data} models={models.data} />}
						</SettingsSection>

						<SettingsSection title={t("Model catalog")} description={t("Models available to the providers you are signed in to. Prices are USD per million tokens.")}>
							{models.isPending && <Skeleton className="h-72" />}
							{models.data && <ModelCatalog models={models.data} />}
						</SettingsSection>
					</>
				)}
			</PageBody>
			<OmpLoginDialog provider={loginFor} onClose={() => setLoginFor(null)} />
		</>
	);
}
