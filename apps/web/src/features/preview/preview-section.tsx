import type { PreviewStatus, TunnelState } from "@clam/contracts";
import { AlertTriangle, CheckCircle2, ExternalLink, Info } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useAccess } from "@/features/auth/hooks";
import { CopyIconButton } from "@/features/network/components";
import { T, renderServerText, t } from "@/i18n";
import { errorText } from "@/lib/api";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field } from "@/ui/field";
import { Input } from "@/ui/input";
import { Skeleton } from "@/ui/skeleton";
import { SettingsSection } from "@/features/settings/components/section";
import { Link } from "@tanstack/react-router";
import { useCheckPreview, usePreviewStatus, useSavePreviewHost } from "./api.ts";

const HOST_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const normalizeHost = (raw: string): string => raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[/?#:].*$/, "").toLowerCase();

function Notes({ status }: { status: PreviewStatus }) {
	return (
		<ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
			<li>
				<T text="<b>One app at a time per browser.</b> Opening an app selects its port (<code>/port/5173/</code>); every other path on this address then goes to that app. To switch, open another app from CLAM or visit <code>/port/</code> followed by its port." tags={{ b: <strong className="font-medium text-foreground" />, code: <code className="font-mono" /> }} />
			</li>
			<li>{t("Opening a preview needs Remote preview switched on in Settings → Security (and remote access to the web UI). On this computer's own UI, previews simply open http://localhost:<port>.")}</li>
			{status.universalSsl ? null : <li className="text-warning">{t("This address is not directly under the same domain as the tunnel hostname, so Cloudflare's free certificate may not cover it. A deeper name needs a paid Advanced Certificate.")}</li>}
		</ul>
	);
}

/** Settings → Cloudflare Tunnel: the Preview section (named tunnel: one extra public hostname; otherwise why it is not available). */
export function PreviewSection({ tn }: { tn: TunnelState }) {
	const named = tn.config.mode === "named" && Boolean(tn.config.hostname);
	const access = useAccess();
	const loopback = access.data?.via === "loopback";
	const status = usePreviewStatus(named);
	const save = useSavePreviewHost();
	const check = useCheckPreview();
	const [draft, setDraft] = useState<string | null>(null);
	const title = t("Preview in your own browser");
	const description = t("Open a web app that runs on this machine (a dev server on localhost:<port>) in your own browser, from anywhere, through one extra address of this machine.");

	if (!named) {
		return (
			<SettingsSection title={title} description={description}>
				<div role="note" className="flex items-start gap-2.5 rounded-xl bg-surface-2 p-3 text-[13px]">
					<Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
					<span className="min-w-0 break-words text-muted-foreground">
						{tn.config.mode === "quick"
							? t("A quick tunnel's address changes on every start, so previews need a named tunnel with a stable hostname. Set one up under Configuration above.")
							: t("Previews need a named tunnel with a stable hostname. Set one up under Configuration above.")}{" "}
						{t("On this computer's own UI nothing is needed: the preview buttons just open http://localhost:<port>.")}
					</span>
				</div>
			</SettingsSection>
		);
	}
	if (status.isPending) {
		return (
			<SettingsSection title={title} description={description}>
				<Skeleton className="h-32" />
			</SettingsSection>
		);
	}
	const st = status.data;
	if (!st) {
		return (
			<SettingsSection title={title} description={description}>
				<p role="alert" className="text-xs text-danger">
					{errorText(status.error)}
				</p>
			</SettingsSection>
		);
	}
	const host = draft ?? st.host ?? st.defaultHost ?? "";
	const normalized = normalizeHost(host);
	const dirty = draft !== null && normalized !== (st.host ?? "");
	const valid = HOST_RE.test(normalized);
	const origin = `127.0.0.1:${tn.networkListener.port}`;
	const result = check.data;
	return (
		<SettingsSection
			title={title}
			description={description}
			actions={
				<Badge variant={st.remoteEnabled ? "warning" : "success"}>{st.remoteEnabled ? t("On for remote sign-ins") : t("Off for remote sign-ins")}</Badge>
			}
		>
			<div className="flex flex-col gap-4">
				{st.available ? null : (
					<div role="status" className="flex items-start gap-2.5 rounded-xl bg-warning/10 p-3 text-[13px]">
						<AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
						<span className="min-w-0 break-words text-muted-foreground">{st.unavailableReason === "bad_host" ? t("The saved preview address no longer fits. Enter a new one below.") : t("A preview address cannot be derived from this hostname. Enter one below.")}</span>
					</div>
				)}
				<Field label={t("Preview address")} hint={t("A hostname of its own for previews. It must not be the hostname above.")} error={dirty && !valid ? t("Enter a hostname like my-machine-preview.example.com (no path, no port).") : null}>
					{(id) => (
						<Input
							id={id}
							value={host}
							disabled={!loopback}
							onChange={(e) => setDraft(e.target.value)}
							placeholder={t("my-machine-preview.example.com")}
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							aria-invalid={dirty && !valid}
							className="font-mono"
						/>
					)}
				</Field>
				{loopback ? null : <p className="text-xs text-subtle">{t("The preview address can only be changed from the computer this machine runs on.")}</p>}
				{loopback && (dirty || st.customHost) ? (
					<div className="flex flex-wrap items-center gap-2">
						{dirty ? (
							<Button
								variant="primary"
								size="sm"
								loading={save.isPending}
								disabled={!valid}
								onClick={() =>
									save.mutate(normalized, {
										onSuccess: () => {
											setDraft(null);
											check.reset();
											toast.success(t("Preview address saved"));
										},
										onError: (e) => toast.error(errorText(e)),
									})
								}
							>
								{t("Save address")}
							</Button>
						) : null}
						{dirty ? (
							<Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
								{t("Discard")}
							</Button>
						) : null}
						{!dirty && st.customHost ? (
							<Button
								variant="ghost"
								size="sm"
								loading={save.isPending}
								onClick={() =>
									save.mutate(null, {
										onSuccess: () => {
											setDraft(null);
											check.reset();
										},
										onError: (e) => toast.error(errorText(e)),
									})
								}
							>
								{t("Use the default address")}
							</Button>
						) : null}
					</div>
				) : null}

				{st.available && st.host ? (
					<>
						<div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3.5 shadow-[inset_0_0_0_1px_var(--border)]">
							<p className="text-[13px] text-muted-foreground">
								<T
									text="In the Cloudflare dashboard, open your tunnel → <b>Public hostname</b> and add <b>one</b> hostname (no wildcard needed):"
									tags={{ b: <strong className="text-foreground" /> }}
								/>
							</p>
							<div className="flex items-center justify-between gap-2 rounded-lg bg-surface-1 p-2.5 shadow-[inset_0_0_0_1px_var(--border-strong)]">
								<div className="min-w-0">
									<div className="text-2xs uppercase tracking-wider text-subtle">{t("Public hostname")}</div>
									<code className="break-all font-mono text-xs sm:text-sm" data-testid="preview-host">
										{st.host}
									</code>
								</div>
								<CopyIconButton value={st.host} label={t("Copy preview hostname")} />
							</div>
							<div className="flex items-center justify-between gap-2 rounded-lg bg-surface-1 p-2.5 shadow-[inset_0_0_0_1px_var(--border-strong)]">
								<div className="min-w-0">
									<div className="text-2xs uppercase tracking-wider text-subtle">{t("Service")}</div>
									<code className="break-all font-mono text-sm" data-testid="preview-origin">
										{`http://${origin}`}
									</code>
									<div className="font-mono text-2xs text-subtle">{t("service: HTTP · URL: {address}", { address: origin })}</div>
								</div>
								<CopyIconButton value={`http://${origin}`} label={t("Copy origin")} />
							</div>
						</div>

						<div className="flex flex-col gap-2">
							<div className="flex flex-wrap items-center gap-2">
								<Button variant="outline" loading={check.isPending} disabled={dirty} onClick={() => check.mutate()}>
									{t("Check")}
								</Button>
								<span className="text-xs text-muted-foreground">{t("Asks https://{host}/__clam_preview/health and expects this machine to answer.", { host: st.host })}</span>
							</div>
							{check.error ? (
								<p role="alert" className="text-xs text-danger">
									{errorText(check.error)}
								</p>
							) : null}
							{result ? (
								<div role="status" className={result.ok ? "flex items-start gap-2.5 rounded-xl bg-success/10 p-3 text-[13px]" : "flex items-start gap-2.5 rounded-xl bg-danger/10 p-3 text-[13px]"}>
									{result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />}
									<span className="min-w-0 break-words">{renderServerText(result.message, result.i18n)}</span>
								</div>
							) : null}
						</div>
					</>
				) : null}

				<Notes status={st} />
				<div className="flex flex-wrap items-center gap-3 text-xs">
					<Link to="/settings/security" className="inline-flex items-center gap-1 text-accent hover:underline">
						{t("Remote preview setting")} <ExternalLink className="size-3" />
					</Link>
				</div>
			</div>
		</SettingsSection>
	);
}
