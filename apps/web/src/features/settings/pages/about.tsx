import { BookOpen, ExternalLink } from "lucide-react";
import { t } from "@/i18n";
import { Skeleton } from "@/ui/skeleton";
import { fmtDateTime } from "@/features/usage/format";
import { CopyButton, InlineError, KeyValue, PageBody, PageIntro, SettingsSection } from "../components/section";
import { useNodeInfo } from "../hooks";

export default function AboutPage() {
	const node = useNodeInfo();
	const n = node.data;

	return (
		<>
			<PageIntro title={t("About")} description={t("CL Agent Mesh — Distributed AI Agents. One Shared Workspace.")} />
			<PageBody>
				<SettingsSection title={t("This machine")}>
					{node.isPending && <Skeleton className="h-40" />}
					{node.isError && <InlineError error={node.error} onRetry={() => node.refetch()} />}
					{n && (
						<dl className="divide-y divide-border">
							<KeyValue label={t("Name")}>{n.name}</KeyValue>
							<KeyValue label={t("Version")} mono>
								{n.version}
							</KeyValue>
							<KeyValue label={t("Machine id")} mono>
								<span className="inline-flex flex-wrap items-center gap-2">
									{n.id}
									<CopyButton value={n.id} />
								</span>
							</KeyValue>
							<KeyValue label={t("Platform")} mono>
								{n.platform} · {n.arch}
							</KeyValue>
							<KeyValue label={t("Hostname")} mono>
								{n.hostname}
							</KeyValue>
							<KeyValue label={t("Listening on")} mono>
								{n.bindAddress}:{n.port}
							</KeyValue>
							<KeyValue label={t("Data directory")} mono>
								{n.dataDir}
							</KeyValue>
							<KeyValue label={t("Started")}>{fmtDateTime(n.startedAt)}</KeyValue>
						</dl>
					)}
				</SettingsSection>
				<SettingsSection title={t("Documentation")}>
					<ul className="space-y-1.5 text-sm">
						<li>
							<a className="inline-flex items-center gap-2 text-accent hover:underline" href="https://github.com/can1357/oh-my-pi" target="_blank" rel="noreferrer">
								<BookOpen className="size-4" />
								{t("Oh My Pi (OMP) — the agent runtime")}
								<ExternalLink className="size-3" />
							</a>
						</li>
					</ul>
					<p className="mt-3 text-xs text-muted-foreground">{t("Project documentation lives in the repository's docs/ directory.")}</p>
				</SettingsSection>
			</PageBody>
		</>
	);
}
