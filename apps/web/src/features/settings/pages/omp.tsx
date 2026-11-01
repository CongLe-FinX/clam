import { useState } from "react";
import { CheckCircle2, Download, RefreshCw, XCircle } from "lucide-react";
import type { LoginProvider } from "@clam/contracts";
import { T, t } from "@/i18n";
import { qk } from "@/lib/queries";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { OmpLoginDialog } from "../components/omp-login";
import { ModelCatalog } from "../components/omp-models";
import { ProvidersList } from "../components/omp-providers";
import { RolesEditor } from "../components/omp-roles";
import { CopyButton, InlineError, KeyValue, PageBody, PageIntro, SettingsSection } from "../components/section";
import { useModelRoles, useOmpModels, useOmpOverview } from "../hooks";

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
