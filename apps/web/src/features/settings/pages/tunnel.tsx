import type { TunnelMode, TunnelState } from "@clam/contracts";
import { AlertTriangle, CheckCircle2, CircleSlash, ExternalLink, KeyRound, Play, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CopyIconButton } from "@/features/network/components";
import { tunnelBusy, useTunnelActions } from "@/features/network/hooks";
import { errorMessage } from "@/lib/api";
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

const MODES: { id: TunnelMode; title: string; summary: string }[] = [
	{ id: "off", title: "Off", summary: "Nothing is exposed. This node is reachable from this machine only; you can still join nodes that are reachable." },
	{ id: "quick", title: "Quick tunnel", summary: "No Cloudflare account. You get a random https://….trycloudflare.com address that changes every time the tunnel starts; paired nodes are told the new address automatically. Meant for trying things out." },
	{ id: "named", title: "Named tunnel", summary: "A stable hostname such as agentA.conglt.io.vn on your own Cloudflare account. Needs a tunnel token from the Cloudflare dashboard and a public hostname routed to this node." },
];

const INSTALL_HINTS: { os: string; cmd: string; note?: string }[] = [
	{ os: "macOS", cmd: "brew install cloudflared" },
	{ os: "Debian / Ubuntu", cmd: "sudo apt install cloudflared", note: "after adding Cloudflare's apt repository" },
	{ os: "Windows", cmd: "winget install --id Cloudflare.cloudflared" },
];

const STATE_LABEL: Record<TunnelState["state"], { label: string; variant: "success" | "warning" | "danger" | "neutral" }> = {
	stopped: { label: "Stopped", variant: "neutral" },
	starting: { label: "Starting…", variant: "warning" },
	running: { label: "Running", variant: "success" },
	reconnecting: { label: "Reconnecting…", variant: "warning" },
	error: { label: "Error", variant: "danger" },
};

export default function TunnelPage() {
	const tunnel = useTunnel();
	const t = tunnel.data;
	const [draft, setDraft] = useState<Draft | null>(null);
	const actions = useTunnelActions();

	if (tunnel.isPending)
		return (
			<>
				<PageIntro title="Cloudflare Tunnel" />
				<PageBody>
					<Skeleton className="h-40" />
					<Skeleton className="h-64" />
				</PageBody>
			</>
		);
	if (!t)
		return (
			<>
				<PageIntro title="Cloudflare Tunnel" />
				<PageBody>
					<InlineError error={tunnel.error} onRetry={() => tunnel.refetch()} />
				</PageBody>
			</>
		);

	const d = draft ?? fromConfig(t.config);
	const patch = (p: Partial<Draft>) => setDraft({ ...d, ...p });
	const host = normalizeHostname(d.hostname);
	const tokenStored = t.config.hasToken && !d.deleteToken && !d.replacingToken;
	const tokenOk = tokenStored || d.token.trim().length >= 20;
	const hostError = d.mode === "named" && host !== "" && !HOSTNAME_RE.test(host) ? "Enter a hostname like agenta.example.com (no path, no port)." : null;
	const valid = d.mode !== "named" || (HOSTNAME_RE.test(host) && tokenOk);
	const dirty =
		draft !== null &&
		(d.mode !== t.config.mode || d.autoStart !== t.config.autoStart || d.token !== "" || d.deleteToken || (d.mode === "named" && host !== (t.config.hostname ?? "")));
	const savedReady = t.config.mode === "quick" || (t.config.mode === "named" && t.config.hasToken && Boolean(t.config.hostname));
	const busy = tunnelBusy(t.state);
	const origin = `http://${t.networkListener.host}:${t.networkListener.port}`;

	const save = () =>
		actions.save.mutate(
			{
				mode: d.mode,
				hostname: d.mode === "named" ? host : undefined,
				token: d.token.trim() ? d.token.trim() : d.deleteToken ? null : undefined,
				autoStart: d.autoStart,
			},
			{
				onSuccess: () => {
					setDraft(null);
					toast.success("Tunnel settings saved");
				},
			},
		);

	return (
		<>
			<PageIntro title="Cloudflare Tunnel" description="Lets other nodes reach this one over HTTPS without opening any port. The tunnel exposes the signed node-to-node API only — never this web interface." />
			<PageBody>
				<SettingsSection
					title="Status"
					actions={
						<Badge variant={STATE_LABEL[t.state].variant} className="gap-1.5">
							<StatusDot status={t.state === "running" ? "online" : t.state === "error" ? "crashed" : t.state === "stopped" ? "offline" : "starting"} label={t.state} className="size-1.5 [&>span]:size-1.5" />
							{STATE_LABEL[t.state].label}
						</Badge>
					}
				>
					<div className="flex flex-col gap-4">
						{t.publicUrl ? (
							<div className="flex flex-col gap-1.5 rounded-xl bg-surface-2 p-3.5 shadow-[inset_0_0_0_1px_var(--border-strong)]">
								<span className="text-2xs font-semibold uppercase tracking-wider text-subtle">Public address of this node</span>
								<div className="flex flex-wrap items-center gap-2">
									<span className="min-w-0 flex-1 select-all break-all font-mono text-[15px]">{t.publicUrl}</span>
									<CopyButton value={t.publicUrl} />
									<Button asChild size="sm" variant="outline">
										<a href={t.publicUrl} target="_blank" rel="noreferrer noopener">
											<ExternalLink /> Open
										</a>
									</Button>
								</div>
								{t.config.mode === "quick" ? <p className="text-xs text-muted-foreground">Quick tunnel addresses change on every start. Connected nodes are informed automatically; for invitations always copy the current address.</p> : null}
							</div>
						) : null}
						{t.lastError ? (
							<div role="alert" className="flex items-start gap-2.5 rounded-xl bg-danger/10 p-3 text-[13px]">
								<AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
								<span className="min-w-0 break-words text-danger/90">{t.lastError}</span>
							</div>
						) : null}
						<dl className="divide-y">
							<KeyValue label="Connections" mono>
								{t.state === "stopped" ? "—" : `${t.connections} to the Cloudflare edge`}
							</KeyValue>
							<KeyValue label="Process" mono>
								{t.pid ? `pid ${t.pid}` : "—"}
							</KeyValue>
							<KeyValue label="Started">{t.startedAt ? relativeTime(t.startedAt) : "—"}</KeyValue>
							<KeyValue label="Network listener" mono>
								<span className="inline-flex items-center gap-1">
									{t.networkListener.host}:{t.networkListener.port}
									<CopyIconButton value={`${t.networkListener.host}:${t.networkListener.port}`} label="Copy listener address" />
								</span>
							</KeyValue>
						</dl>
						<p className="text-xs text-subtle">The network listener serves only <span className="font-mono">/api/v1</span> on loopback; the tunnel forwards to it. Everything else (UI, local API, WebSocket) stays on the UI port.</p>
						<div className="flex flex-wrap items-center gap-2">
							{busy ? (
								<Button variant="outline" loading={actions.stop.isPending} onClick={() => actions.stop.mutate()}>
									<Square /> Stop tunnel
								</Button>
							) : (
								<Button variant="primary" loading={actions.start.isPending} disabled={!t.cloudflared.installed || !savedReady || dirty} onClick={() => actions.start.mutate()}>
									<Play /> Start tunnel
								</Button>
							)}
							{!busy && !t.cloudflared.installed ? <span className="text-xs text-warning">Install cloudflared first.</span> : null}
							{!busy && t.cloudflared.installed && !savedReady ? <span className="text-xs text-muted-foreground">{t.config.mode === "off" ? "Choose and save a mode below." : "Save a hostname and token for the named tunnel first."}</span> : null}
							{!busy && dirty && savedReady ? <span className="text-xs text-muted-foreground">Save your changes first.</span> : null}
						</div>
					</div>
				</SettingsSection>

				<SettingsSection
					title="cloudflared"
					actions={
						<Badge variant={t.cloudflared.installed ? "success" : "warning"} className="gap-1">
							{t.cloudflared.installed ? <CheckCircle2 /> : <CircleSlash />}
							{t.cloudflared.installed ? "Detected" : "Not installed"}
						</Badge>
					}
				>
					{t.cloudflared.installed ? (
						<dl className="divide-y">
							<KeyValue label="Version" mono>
								{t.cloudflared.version ?? "unknown"}
							</KeyValue>
							<KeyValue label="Binary" mono>
								{t.cloudflared.binaryPath ?? "—"}
							</KeyValue>
						</dl>
					) : (
						<div className="space-y-2 text-sm">
							<p className="text-muted-foreground">
								<span className="font-mono">cloudflared</span> was not found on the PATH. Install it, then reload this page:
							</p>
							{INSTALL_HINTS.map(({ os, cmd, note }) => (
								<div key={os} className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 p-2.5">
									<span className="min-w-0">
										<span className="block text-2xs uppercase tracking-wider text-subtle">{os}</span>
										<code className="break-all font-mono text-xs">{cmd}</code>
										{note ? <span className="block text-2xs text-subtle">{note}</span> : null}
									</span>
									<CopyIconButton value={cmd} label={`Copy ${os} install command`} />
								</div>
							))}
							<a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
								Other platforms <ExternalLink className="size-3" />
							</a>
						</div>
					)}
				</SettingsSection>

				<SettingsSection title="Configuration" description="How this node is published. If the tunnel is running, saved changes restart it.">
					<div className="flex flex-col gap-5">
						<div role="radiogroup" aria-label="Tunnel mode" className="grid gap-2.5 md:grid-cols-3">
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
											{m.title}
										</span>
										<span className="text-xs text-muted-foreground">{m.summary}</span>
									</button>
								);
							})}
						</div>

						{d.mode === "named" ? (
							<div className="flex flex-col gap-4 rounded-xl bg-surface-2 p-3.5 shadow-[inset_0_0_0_1px_var(--border)]">
								<ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-muted-foreground">
									<li>In the Cloudflare dashboard open <strong className="text-foreground">Zero Trust → Networks → Tunnels</strong> and create a tunnel (type <em>Cloudflared</em>).</li>
									<li>Copy the <strong className="text-foreground">tunnel token</strong> and paste it below.</li>
									<li>
										Add a <strong className="text-foreground">public hostname</strong> (for example <span className="font-mono">agentA.conglt.io.vn</span>) with service type <strong className="text-foreground">HTTP</strong> pointing at:
									</li>
								</ol>
								<div className="flex items-center justify-between gap-2 rounded-lg bg-surface-1 p-2.5 shadow-[inset_0_0_0_1px_var(--border-strong)]">
									<div className="min-w-0">
										<div className="text-2xs uppercase tracking-wider text-subtle">Origin to configure</div>
										<code className="break-all font-mono text-sm" data-testid="tunnel-origin">{origin}</code>
										<div className="font-mono text-2xs text-subtle">service: HTTP · URL: {t.networkListener.host}:{t.networkListener.port}</div>
									</div>
									<CopyIconButton value={origin} label="Copy origin" />
								</div>
								<Field label="Public hostname" hint="The hostname you routed to the origin above." error={hostError}>
									{(id) => <Input id={id} value={d.hostname} onChange={(e) => patch({ hostname: e.target.value })} placeholder="agenta.example.com" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-invalid={Boolean(hostError)} className="font-mono" />}
								</Field>
								<div className="flex flex-col gap-1.5">
									<span className="text-xs font-medium text-muted-foreground">Tunnel token</span>
									{tokenStored ? (
										<div className="flex flex-wrap items-center gap-2">
											<Badge variant="success" className="gap-1">
												<KeyRound /> Token stored securely
											</Badge>
											<Button size="sm" variant="outline" onClick={() => patch({ replacingToken: true })}>
												Replace
											</Button>
											<Button size="sm" variant="ghost" className="text-danger" onClick={() => patch({ deleteToken: true })}>
												<Trash2 /> Delete
											</Button>
										</div>
									) : (
										<>
											{d.deleteToken ? <p className="text-xs text-warning">The stored token will be deleted when you save.</p> : null}
											<Input
												type="password"
												value={d.token}
												onChange={(e) => patch({ token: e.target.value })}
												placeholder={t.config.hasToken && d.replacingToken ? "Paste the new token" : "Paste the token from the Cloudflare dashboard"}
												autoComplete="off"
												spellCheck={false}
												aria-label="Tunnel token"
												className="font-mono"
											/>
											<p className="text-xs text-subtle">Write-only. It goes to the OS secret store and is never shown again or written to logs.</p>
											{t.config.hasToken && (d.replacingToken || d.deleteToken) ? (
												<Button size="sm" variant="ghost" className="self-start" onClick={() => patch({ replacingToken: false, deleteToken: false, token: "" })}>
													Keep the stored token
												</Button>
											) : null}
										</>
									)}
								</div>
							</div>
						) : null}

						<label className="flex min-h-11 items-center justify-between gap-4">
							<span className="flex flex-col">
								<span className="text-[13px] font-medium">Start automatically</span>
								<span className="text-xs text-muted-foreground">Start the tunnel whenever this node's server starts.</span>
							</span>
							<Switch checked={d.autoStart} onCheckedChange={(v) => patch({ autoStart: v })} disabled={d.mode === "off"} aria-label="Start automatically" />
						</label>

						{actions.save.error ? (
							<p role="alert" className="text-xs text-danger">
								{errorMessage(actions.save.error)}
							</p>
						) : null}
						<div className="flex items-center gap-2">
							<Button variant="primary" loading={actions.save.isPending} disabled={!dirty || !valid} onClick={save}>
								Save configuration
							</Button>
							{dirty ? (
								<Button variant="ghost" onClick={() => setDraft(null)}>
									Discard
								</Button>
							) : null}
						</div>
					</div>
				</SettingsSection>
			</PageBody>
		</>
	);
}
