import type { TunnelMode, TunnelState } from "@clam/contracts";
import { AlertTriangle, CheckCircle2, CircleSlash, Cloud, ExternalLink, KeyRound, Play, Square, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CopyIconButton } from "@/features/network/components";
import { TUNNEL_MODE_LABEL, TUNNEL_STATE } from "@/features/network/format";
import { tunnelBusy, useTunnelActions } from "@/features/network/hooks";
import { T, msg, renderServerText, t, tr, type Msg } from "@/i18n";
import { errorText } from "@/lib/api";
import { PreviewSection } from "@/features/preview/preview-section";
import { useTunnel } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field } from "@/ui/field";
import { Input } from "@/ui/input";
import { Skeleton } from "@/ui/skeleton";
import { StatusDot } from "@/ui/status-dot";
import { Switch } from "@/ui/switch";
import { CopyButton, InlineError, KeyValue, PageBody, PageIntro, SettingsSection } from "../components/section";

interface Draft {
	mode: TunnelMode;
	hostname: string;
	autoStart: boolean;
	/** New token typed by the user (write-only; never read back from the server). */
	token: string;
	replacingToken: boolean;
	deleteToken: boolean;
}

const fromConfig = (c: TunnelState["config"]): Draft => ({ mode: c.mode, hostname: c.hostname ?? "", autoStart: c.autoStart, token: "", replacingToken: false, deleteToken: false });

/** Accepts `https://Agent.Example.com/` and returns `agent.example.com`. */
const normalizeHostname = (raw: string): string => raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[/?#].*$/, "").toLowerCase();
const HOSTNAME_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const MODES: { id: TunnelMode; title: Msg; summary: Msg }[] = [
	{ id: "off", title: TUNNEL_MODE_LABEL.off, summary: msg("Nothing is exposed. This machine is reachable from this machine only; you can still join machines that are reachable.") },
	{ id: "quick", title: TUNNEL_MODE_LABEL.quick, summary: msg("No Cloudflare account. You get a random https://….trycloudflare.com address that changes every time the tunnel starts; paired machines are told the new address automatically. Meant for trying things out.") },
	{ id: "named", title: TUNNEL_MODE_LABEL.named, summary: msg("A stable hostname such as agentA.conglt.io.vn on your own Cloudflare account. Needs a tunnel token from the Cloudflare dashboard and a public hostname routed to this machine.") },
];

const INSTALL_HINTS: { os: string; cmd: string; note?: Msg }[] = [
	{ os: "macOS", cmd: "brew install cloudflared" },
	{ os: "Debian / Ubuntu", cmd: "sudo apt install cloudflared", note: msg("after adding Cloudflare's apt repository") },
	{ os: "Windows", cmd: "winget install --id Cloudflare.cloudflared" },
];

export default function TunnelPage() {
	const tunnel = useTunnel();
	const tn = tunnel.data;
	const [draft, setDraft] = useState<Draft | null>(null);
	const actions = useTunnelActions();

	if (tunnel.isPending)
		return (
			<>
				<PageIntro title={t("Cloudflare Tunnel")} />
				<PageBody>
					<Skeleton className="h-40" />
					<Skeleton className="h-64" />
				</PageBody>
			</>
		);
	if (!tn)
		return (
			<>
				<PageIntro title={t("Cloudflare Tunnel")} />
				<PageBody>
					<InlineError error={tunnel.error} onRetry={() => tunnel.refetch()} />
				</PageBody>
			</>
		);

	const d = draft ?? fromConfig(tn.config);
	const patch = (p: Partial<Draft>) => setDraft({ ...d, ...p });
	const host = normalizeHostname(d.hostname);
	const tokenStored = tn.config.hasToken && !d.deleteToken && !d.replacingToken;
	const tokenOk = tokenStored || d.token.trim().length >= 20;
	const hostError = d.mode === "named" && host !== "" && !HOSTNAME_RE.test(host) ? t("Enter a hostname like agenta.example.com (no path, no port).") : null;
	const valid = d.mode !== "named" || (HOSTNAME_RE.test(host) && tokenOk);
	const dirty =
		draft !== null &&
		(d.mode !== tn.config.mode || d.autoStart !== tn.config.autoStart || d.token !== "" || d.deleteToken || (d.mode === "named" && host !== (tn.config.hostname ?? "")));
	const savedReady = tn.config.mode === "quick" || (tn.config.mode === "named" && tn.config.hasToken && Boolean(tn.config.hostname));
	const busy = tunnelBusy(tn.state);
	const origin = `http://${tn.networkListener.host}:${tn.networkListener.port}`;

	const wasStopped = tn.state === "stopped";
	const save = () =>
		actions.save.mutate(
			{
				mode: d.mode,
				hostname: d.mode === "named" ? host : undefined,
				token: d.token.trim() ? d.token.trim() : d.deleteToken ? null : undefined,
				autoStart: d.autoStart,
			},
			{
				onSuccess: (saved) => {
					setDraft(null);
					toast.success(wasStopped && saved.state !== "stopped" ? t("Tunnel settings saved and the tunnel started") : t("Tunnel settings saved"));
				},
			},
		);

	return (
		<>
			<PageIntro title={t("Cloudflare Tunnel")} description={t("Lets other machines reach this one over HTTPS without opening any port. The tunnel exposes the signed machine-to-machine API only — never this web interface.")} />
			<PageBody>
				{tn.config.mode === "off" && !busy && tn.cloudflared.installed ? (
					<div className="flex flex-wrap items-center gap-3 rounded-2xl bg-accent-soft p-4 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_40%,transparent)]">
						<span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground">
							<Zap className="size-5" />
						</span>
						<span className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
							<strong className="text-[14px] font-semibold">{t("Get an address in one click")}</strong>
							<span className="text-[13px] text-muted-foreground">{t("A quick tunnel needs no account and gives this machine a temporary https address, so another machine can pair with it. For a permanent address use a named tunnel below.")}</span>
						</span>
						<Button
							variant="primary"
							loading={actions.save.isPending || actions.start.isPending}
							onClick={() => actions.save.mutate({ mode: "quick", autoStart: false }, { onSuccess: () => actions.start.mutate() })}
						>
							<Cloud /> {t("Start a quick tunnel")}
						</Button>
					</div>
				) : null}
				<SettingsSection
					title={t("Status")}
					actions={
						<Badge variant={actions.stop.isPending ? "warning" : TUNNEL_STATE[tn.state].variant} className="gap-1.5">
							<StatusDot status={tn.state === "running" ? "online" : tn.state === "error" ? "crashed" : tn.state === "stopped" ? "offline" : "starting"} label={tr(TUNNEL_STATE[tn.state].label)} className="size-1.5 [&>span]:size-1.5" />
							{actions.stop.isPending ? t("Stopping…") : tr(TUNNEL_STATE[tn.state].label)}
						</Badge>
					}
				>
					<div className="flex flex-col gap-4">
						{tn.externalConnector ? (
							<div role="status" className="flex items-start gap-2.5 rounded-xl bg-success/10 p-3 text-[13px]">
								<CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
								<span className="min-w-0 break-words">
									<strong className="block font-semibold">{t("Served by another cloudflared on this machine or network")}</strong>
									<span className="text-muted-foreground">{t("{hostname} already reaches this machine through a connector CLAM did not start, so CLAM's own connector is optional. Start it only if you want CLAM to run the tunnel itself.", { hostname: tn.config.hostname ?? "" })}</span>
								</span>
							</div>
						) : tn.state === "stopped" && tn.config.mode !== "off" ? (
							<div role="status" className="flex items-start gap-2.5 rounded-xl bg-warning/10 p-3 text-[13px]">
								<AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
								<span className="min-w-0 break-words text-muted-foreground">{t("The tunnel is stopped. Saved settings are not live until it is started — press Start tunnel, or turn on “Start automatically”.")}</span>
							</div>
						) : null}
						{tn.publicUrl ? (
							<div className="flex flex-col gap-1.5 rounded-xl bg-surface-2 p-3.5 shadow-[inset_0_0_0_1px_var(--border-strong)]">
								<span className="text-2xs font-semibold uppercase tracking-wider text-subtle">{t("Public address of this machine")}</span>
								<div className="flex flex-wrap items-center gap-2">
									<span className="min-w-0 flex-1 select-all break-all font-mono text-[15px]">{tn.publicUrl}</span>
									<CopyButton value={tn.publicUrl} />
									<Button asChild size="sm" variant="outline">
										<a href={tn.publicUrl} target="_blank" rel="noreferrer noopener">
											<ExternalLink /> {t("Open")}
										</a>
									</Button>
								</div>
								{tn.config.mode === "quick" ? <p className="text-xs text-muted-foreground">{t("Quick tunnel addresses change on every start. Connected machines are informed automatically; for invitations always copy the current address.")}</p> : null}
							</div>
						) : null}
						{tn.lastError ? (
							<div role="alert" className="flex items-start gap-2.5 rounded-xl bg-danger/10 p-3 text-[13px]">
								<AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
								<span className="min-w-0 break-words text-danger/90">{renderServerText(tn.lastError, tn.lastErrorI18n)}</span>
							</div>
						) : null}
						<dl className="divide-y">
							<KeyValue label={t("Connections")} mono>
								{tn.state === "stopped" ? "—" : t("{count} to the Cloudflare edge", { count: tn.connections })}
							</KeyValue>
							<KeyValue label={t("Process")} mono>
								{tn.pid ? t("pid {pid}", { pid: tn.pid }) : "—"}
							</KeyValue>
							<KeyValue label={t("Started")}>{tn.startedAt ? relativeTime(tn.startedAt) : "—"}</KeyValue>
							<KeyValue label={t("Network listener")} mono>
								<span className="inline-flex items-center gap-1">
									{tn.networkListener.host}:{tn.networkListener.port}
									<CopyIconButton value={`${tn.networkListener.host}:${tn.networkListener.port}`} label={t("Copy listener address")} />
								</span>
							</KeyValue>
						</dl>
						<p className="text-xs text-subtle">
							<T
								text="The network listener serves only <code>/api/v1</code> on loopback; the tunnel forwards to it. Everything else (UI, local API, WebSocket) stays on the UI port."
								tags={{ code: <span className="font-mono" /> }}
							/>
						</p>
						<div className="flex flex-wrap items-center gap-2">
							{busy ? (
								<Button variant="outline" loading={actions.stop.isPending} onClick={() => actions.stop.mutate()}>
									<Square /> {t("Stop tunnel")}
								</Button>
							) : (
								<Button variant="primary" loading={actions.start.isPending} disabled={!tn.cloudflared.installed || !savedReady || dirty} onClick={() => actions.start.mutate()}>
									<Play /> {t("Start tunnel")}
								</Button>
							)}
							{!busy && tn.config.mode === "named" && tn.config.hostname ? (
								<Button variant="outline" loading={actions.probe.isPending} onClick={() => actions.probe.mutate()}>
									{t("Check hostname")}
								</Button>
							) : null}
							{!busy && !tn.cloudflared.installed ? <span className="text-xs text-warning">{t("Install cloudflared first.")}</span> : null}
							{!busy && tn.cloudflared.installed && !savedReady ? <span className="text-xs text-muted-foreground">{tn.config.mode === "off" ? t("Choose and save a mode below.") : t("Save a hostname and token for the named tunnel first.")}</span> : null}
							{!busy && dirty && savedReady ? <span className="text-xs text-muted-foreground">{t("Save your changes first.")}</span> : null}
						</div>
					</div>
				</SettingsSection>

				<SettingsSection
					title="cloudflared"
					actions={
						<Badge variant={tn.cloudflared.installed ? "success" : "warning"} className="gap-1">
							{tn.cloudflared.installed ? <CheckCircle2 /> : <CircleSlash />}
							{tn.cloudflared.installed ? t("Detected") : t("Not installed")}
						</Badge>
					}
				>
					{tn.cloudflared.installed ? (
						<dl className="divide-y">
							<KeyValue label={t("Version")} mono>
								{tn.cloudflared.version ?? t("unknown")}
							</KeyValue>
							<KeyValue label={t("Binary")} mono>
								{tn.cloudflared.binaryPath ?? "—"}
							</KeyValue>
						</dl>
					) : (
						<div className="space-y-2 text-sm">
							<p className="text-muted-foreground">
								<T
									text="<code>cloudflared</code> was not found on the PATH. Install it, then reload this page:"
									tags={{ code: <span className="font-mono" /> }}
								/>
							</p>
							{INSTALL_HINTS.map(({ os, cmd, note }) => (
								<div key={os} className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 p-2.5">
									<span className="min-w-0">
										<span className="block text-2xs uppercase tracking-wider text-subtle">{os}</span>
										<code className="break-all font-mono text-xs">{cmd}</code>
										{note ? <span className="block text-2xs text-subtle">{tr(note)}</span> : null}
									</span>
									<CopyIconButton value={cmd} label={t("Copy {os} install command", { os })} />
								</div>
							))}
							<a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
								{t("Other platforms")} <ExternalLink className="size-3" />
							</a>
						</div>
					)}
				</SettingsSection>

				<SettingsSection title={t("Configuration")} description={t("How this machine is published. If the tunnel is running, saved changes restart it.")}>
					<div className="flex flex-col gap-5">
						<div role="radiogroup" aria-label={t("Tunnel mode")} className="grid gap-2.5 md:grid-cols-3">
							{MODES.map((m) => {
								const on = d.mode === m.id;
								return (
									<button
										key={m.id}
										type="button"
										role="radio"
										aria-checked={on}
										onClick={() => patch({ mode: m.id })}
										className={cn(
											"flex min-h-11 flex-col gap-1.5 rounded-xl p-3.5 text-left outline-none transition-[background-color,box-shadow] focus-visible:shadow-[0_0_0_2px_var(--accent)]",
											on ? "bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--accent)]" : "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-surface-3",
										)}
									>
										<span className="flex items-center gap-2 text-[13px] font-semibold">
											<span className={cn("grid size-4 place-items-center rounded-full shadow-[inset_0_0_0_1.5px_var(--border-strong)]", on && "shadow-[inset_0_0_0_1.5px_var(--accent)]")}>{on ? <span className="size-2 rounded-full bg-accent" /> : null}</span>
											{tr(m.title)}
										</span>
										<span className="text-xs text-muted-foreground">{tr(m.summary)}</span>
									</button>
								);
							})}
						</div>

						{d.mode === "named" ? (
							<div className="flex flex-col gap-4 rounded-xl bg-surface-2 p-3.5 shadow-[inset_0_0_0_1px_var(--border)]">
								<ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-muted-foreground">
									<li>
										<T
											text="In the Cloudflare dashboard open <b>Zero Trust → Networks → Tunnels</b> and create a tunnel (type <em>Cloudflared</em>)."
											tags={{ b: <strong className="text-foreground" />, em: <em /> }}
										/>
									</li>
									<li>
										<T text="Copy the <b>tunnel token</b> and paste it below." tags={{ b: <strong className="text-foreground" /> }} />
									</li>
									<li>
										<T
											text="Add a <b>public hostname</b> (for example <code>agentA.conglt.io.vn</code>) with service type <b>HTTP</b> pointing at:"
											tags={{ b: <strong className="text-foreground" />, code: <span className="font-mono" /> }}
										/>
									</li>
								</ol>
								<div className="flex items-center justify-between gap-2 rounded-lg bg-surface-1 p-2.5 shadow-[inset_0_0_0_1px_var(--border-strong)]">
									<div className="min-w-0">
										<div className="text-2xs uppercase tracking-wider text-subtle">{t("Origin to configure")}</div>
										<code className="break-all font-mono text-sm" data-testid="tunnel-origin">{origin}</code>
										<div className="font-mono text-2xs text-subtle">{t("service: HTTP · URL: {address}", { address: `${tn.networkListener.host}:${tn.networkListener.port}` })}</div>
									</div>
									<CopyIconButton value={origin} label={t("Copy origin")} />
								</div>
								<Field label={t("Public hostname")} hint={t("The hostname you routed to the origin above.")} error={hostError}>
									{(id) => <Input id={id} value={d.hostname} onChange={(e) => patch({ hostname: e.target.value })} placeholder={t("agenta.example.com")} autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-invalid={Boolean(hostError)} className="font-mono" />}
								</Field>
								<div className="flex flex-col gap-1.5">
									<span className="text-xs font-medium text-muted-foreground">{t("Tunnel token")}</span>
									{tokenStored ? (
										<div className="flex flex-wrap items-center gap-2">
											<Badge variant="success" className="gap-1">
												<KeyRound /> {t("Token stored securely")}
											</Badge>
											<Button size="sm" variant="outline" onClick={() => patch({ replacingToken: true })}>
												{t("Replace")}
											</Button>
											<Button size="sm" variant="ghost" className="text-danger" onClick={() => patch({ deleteToken: true })}>
												<Trash2 /> {t("Delete")}
											</Button>
										</div>
									) : (
										<>
											{d.deleteToken ? <p className="text-xs text-warning">{t("The stored token will be deleted when you save.")}</p> : null}
											<Input
												type="password"
												value={d.token}
												onChange={(e) => patch({ token: e.target.value })}
												placeholder={tn.config.hasToken && d.replacingToken ? t("Paste the new token") : t("Paste the token from the Cloudflare dashboard")}
												autoComplete="off"
												spellCheck={false}
												aria-label={t("Tunnel token")}
												className="font-mono"
											/>
											<p className="text-xs text-subtle">{t("Write-only. It goes to the OS secret store and is never shown again or written to logs.")}</p>
											{tn.config.hasToken && (d.replacingToken || d.deleteToken) ? (
												<Button size="sm" variant="ghost" className="self-start" onClick={() => patch({ replacingToken: false, deleteToken: false, token: "" })}>
													{t("Keep the stored token")}
												</Button>
											) : null}
										</>
									)}
								</div>
							</div>
						) : null}

						<label className="flex min-h-11 items-center justify-between gap-4">
							<span className="flex flex-col">
								<span className="text-[13px] font-medium">{t("Start automatically")}</span>
								<span className="text-xs text-muted-foreground">{t("Start the tunnel when this machine's server starts and whenever you save these settings while it is stopped.")}</span>
							</span>
							<Switch checked={d.autoStart} onCheckedChange={(v) => patch({ autoStart: v })} disabled={d.mode === "off"} aria-label={t("Start automatically")} />
						</label>

						{actions.save.error ? (
							<p role="alert" className="text-xs text-danger">
								{errorText(actions.save.error)}
							</p>
						) : null}
						<div className="flex items-center gap-2">
							<Button variant="primary" loading={actions.save.isPending} disabled={!dirty || !valid} onClick={save}>
								{t("Save configuration")}
							</Button>
							{dirty ? (
								<Button variant="ghost" onClick={() => setDraft(null)}>
									{t("Discard")}
								</Button>
							) : null}
						</div>
					</div>
				</SettingsSection>

				<PreviewSection tn={tn} />
			</PageBody>
		</>
	);
}
