import type { Handoff } from "@clam/contracts";
import { FileArchive, GitBranch } from "lucide-react";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { KeyValue } from "@/features/settings/components/section";
import { formatBytes } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";

const short = (s: string, n = 10): string => (s.length > n ? s.slice(0, n) : s);

function Mono({ children }: { children: string }) {
	return <code className="break-all rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">{children}</code>;
}

/** What travels (files), what the target needs (environment) and what the agent was doing (summary). */
export function ManifestCard({ h }: { h: Handoff }) {
	const env = h.environment;
	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle>What is being handed over</CardTitle>
					{h.manifestSha256 ? (
						<span className="font-mono text-2xs text-subtle" title={`Manifest sha-256 ${h.manifestSha256}`}>
							manifest {short(h.manifestSha256, 8)}
						</span>
					) : null}
				</CardHeader>
				<CardContent className="pt-1">
					<dl className="divide-y">
						<KeyValue label="Files travel as">
							{h.vcs === "git" ? (
								<span className="inline-flex items-center gap-1.5">
									<GitBranch className="size-3.5 text-subtle" aria-hidden /> Git branch
								</span>
							) : h.vcs === "files" ? (
								<span className="inline-flex items-center gap-1.5">
									<FileArchive className="size-3.5 text-subtle" aria-hidden /> Folder bundle (no Git needed)
								</span>
							) : (
								"Nothing (context only)"
							)}
						</KeyValue>
						{h.git ? (
							<>
								<KeyValue label="Repository">{h.git.repoUrl}</KeyValue>
								<KeyValue label="Branch">
									<Mono>{h.git.branch}</Mono>
								</KeyValue>
								<KeyValue label="Commit">
									<Mono>{short(h.git.commit, 12)}</Mono>
								</KeyValue>
								<KeyValue label="Delivery">
									<span className="flex flex-wrap gap-1.5">
										<Badge variant={h.git.pushed ? "success" : "warning"}>{h.git.pushed ? "Pushed" : "Not pushed"}</Badge>
										{h.git.patch ? <Badge variant="accent">Includes uncommitted changes as a patch</Badge> : null}
									</span>
								</KeyValue>
							</>
						) : null}
						{h.files ? (
							<>
								<KeyValue label="Bundle">
									{h.files.fileCount} {h.files.fileCount === 1 ? "file" : "files"} · {formatBytes(h.files.size)}
								</KeyValue>
								<KeyValue label="Checksum" mono>
									{short(h.files.sha256, 16)}…
								</KeyValue>
							</>
						) : null}
						<KeyValue label="Ownership">
							epoch {h.fromEpoch} → {h.toEpoch}
						</KeyValue>
						<KeyValue label="Transcript">{h.includeTranscript ? "The old agent transcript is included for reading" : "Not included (only a summary travels)"}</KeyValue>
					</dl>
				</CardContent>
			</Card>

			{env ? (
				<Card>
					<CardHeader>
						<CardTitle>Environment the work expects</CardTitle>
					</CardHeader>
					<CardContent className="pt-1">
						<dl className="divide-y">
							{env.os || env.arch ? <KeyValue label="Source machine">{[env.os, env.arch].filter(Boolean).join(" · ")}</KeyValue> : null}
							<KeyValue label="Runtimes">
								{env.runtimes.length === 0 ? (
									<span className="text-subtle">None detected</span>
								) : (
									<span className="flex flex-wrap gap-1.5">
										{env.runtimes.map((r) => (
											<Badge key={r.name} variant="neutral">
												{r.name} {r.versionRange}
											</Badge>
										))}
									</span>
								)}
							</KeyValue>
							<KeyValue label="Package manager">
								{env.packageManager ? (
									<span className="flex flex-col gap-1">
										<span>
											{env.packageManager.name}
											{env.packageManager.lockfile ? <span className="text-subtle"> · {env.packageManager.lockfile}</span> : null}
										</span>
										<Mono>{env.packageManager.installCommand}</Mono>
									</span>
								) : (
									<span className="text-subtle">{env.projects?.length ? "None in the top folder" : "None detected"}</span>
								)}
							</KeyValue>
							{env.projects?.length ? (
								<KeyValue label="Projects in folders">
									<span className="flex flex-col gap-1.5">
										{env.projects.map((p) => (
											<span key={`${p.path}:${p.packageManager.installCommand}`} className="flex flex-col gap-0.5">
												<span>
													<Mono>{`${p.path}/`}</Mono>
													<span className="text-subtle"> · {p.packageManager.name}</span>
												</span>
												<Mono>{p.packageManager.installCommand}</Mono>
											</span>
										))}
									</span>
								</KeyValue>
							) : null}
							<KeyValue label="Setup commands">
								{env.setupCommands.length === 0 ? (
									<span className="text-subtle">None declared</span>
								) : (
									<span className="flex flex-col gap-1">
										{env.setupCommands.map((c) => (
											<Mono key={c}>{c}</Mono>
										))}
									</span>
								)}
							</KeyValue>
							<KeyValue label="Required env vars">
								{env.requiredEnvVars.length === 0 ? (
									<span className="text-subtle">None</span>
								) : (
									<span className="flex flex-col gap-1.5">
										<span className="flex flex-wrap gap-1.5">
											{env.requiredEnvVars.map((v) => (
												<Badge key={v} variant="outline" className="font-mono">
													{v}
												</Badge>
											))}
										</span>
										<span className="text-xs text-subtle">Names only. Values never travel; set them on the target.</span>
									</span>
								)}
							</KeyValue>
							<KeyValue label="Check command">{env.checkCommand ? <Mono>{env.checkCommand}</Mono> : <span className="text-subtle">None</span>}</KeyValue>
						</dl>
					</CardContent>
				</Card>
			) : null}

			{h.conversationSummary ? (
				<Card>
					<CardHeader>
						<CardTitle>Conversation summary</CardTitle>
						<span className="text-2xs text-subtle">scanned for secrets</span>
					</CardHeader>
					<CardContent className="pt-3">
						<LazyMarkdown text={h.conversationSummary} />
					</CardContent>
				</Card>
			) : null}
		</>
	);
}
