import { type AccessStatus, MIN_PASSWORD_LENGTH, routes } from "@clam/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { ExternalLink, Info, KeyRound, LogOut, Monitor } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { authGate } from "@/features/auth/gate";
import { accessKey, useAccess, useDropOwnerData } from "@/features/auth/hooks";
import { useSignOut } from "@/features/auth/sign-out";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field } from "@/ui/field";
import { Input } from "@/ui/input";
import { Skeleton } from "@/ui/skeleton";
import { Switch } from "@/ui/switch";
import { CopyButton, InlineError, KeyValue, PageBody, PageIntro, SettingsSection } from "../components/section";
import { useSecurityInfo } from "../hooks";

const BACKEND_LABEL = {
	"macos-keychain": "macOS Keychain",
	libsecret: "Secret Service (libsecret)",
	"windows-credential": "Windows Credential Manager",
	"encrypted-file": "Encrypted file",
} as const;

const TTL_CHOICES: { hours: number; label: string }[] = [
	{ hours: 1, label: "1 hour" },
	{ hours: 8, label: "8 hours" },
	{ hours: 12, label: "12 hours" },
	{ hours: 24, label: "1 day" },
	{ hours: 72, label: "3 days" },
	{ hours: 168, label: "7 days" },
];

const ttlLabel = (h: number) => TTL_CHOICES.find((c) => c.hours === h)?.label ?? `${h} hours`;

function LoopbackOnlyNote({ children }: { children: React.ReactNode }) {
	return (
		<p className="mt-3 flex items-start gap-2 rounded-md border border-border bg-surface-2 p-2.5 text-xs text-muted-foreground">
			<Info className="mt-0.5 size-3.5 shrink-0" />
			<span>{children}</span>
		</p>
	);
}

function useAccessMutation<V>(fn: (v: V) => Promise<AccessStatus | void>, success?: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: (next) => {
			if (next) qc.setQueryData(accessKey, next);
			else void qc.invalidateQueries({ queryKey: accessKey });
			if (success) toast.success(success);
		},
		onError: (e) => toast.error(errorMessage(e)),
	});
}

function RemoteAccessSection({ a }: { a: AccessStatus }) {
	const loopback = a.via === "loopback";
	const [confirmEnable, setConfirmEnable] = useState(false);
	const patch = useAccessMutation((body: { remoteUiEnabled?: boolean; sessionTtlHours?: number }) => api.patch<AccessStatus>(routes.access, body));
	const canToggle = loopback && (a.passwordSet || a.remoteUiEnabled);
	const toggleReason = !loopback
		? "Remote access and the sign-in length can only be changed from the computer this node runs on."
		: !a.passwordSet && !a.remoteUiEnabled
			? "Set an owner password first."
			: null;

	return (
		<SettingsSection
			title="Remote access to this web UI"
			description="Open this node's own web UI from any browser through its public domain, after signing in with the owner password."
			actions={
				<Switch
					checked={a.remoteUiEnabled}
					disabled={!canToggle || patch.isPending}
					aria-label="Remote access to the web UI"
					onCheckedChange={(on) => (on ? setConfirmEnable(true) : patch.mutate({ remoteUiEnabled: false }))}
				/>
			}
		>
			<dl className="divide-y divide-border">
				<KeyValue label="Status">
					<Badge variant={a.remoteUiEnabled ? "warning" : "success"}>{a.remoteUiEnabled ? "On: reachable through your tunnel" : "Off: this computer only"}</Badge>
				</KeyValue>
				{a.remoteUiEnabled && (
					<KeyValue label="Public UI address">
						{a.publicUiUrl ? (
							<div className="flex flex-wrap items-center justify-between gap-2">
								<code className="break-all font-mono text-xs">{a.publicUiUrl}</code>
								<div className="flex items-center gap-2">
									<CopyButton value={a.publicUiUrl} />
									<Button asChild size="sm" variant="outline">
										<a href={a.publicUiUrl} target="_blank" rel="noreferrer noopener">
											<ExternalLink /> Open
										</a>
									</Button>
								</div>
							</div>
						) : (
							<span className="text-muted-foreground">
								No tunnel is running, so there is no public address yet.{" "}
								<Link to="/settings/tunnel" className="text-accent hover:underline">
									Start the tunnel
								</Link>
							</span>
						)}
					</KeyValue>
				)}
				<KeyValue label="Sign-in lasts">
					<div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Session length">
						{TTL_CHOICES.map((c) => (
							<button
								key={c.hours}
								type="button"
								role="radio"
								aria-checked={a.sessionTtlHours === c.hours}
								disabled={!loopback || patch.isPending}
								onClick={() => patch.mutate({ sessionTtlHours: c.hours })}
								className={cn(
									"h-7 rounded-md px-2.5 text-xs outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50 coarse:h-10",
									a.sessionTtlHours === c.hours ? "bg-accent text-accent-foreground disabled:opacity-100" : "bg-surface-2 text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:bg-surface-3 hover:text-foreground",
								)}
							>
								{c.label}
							</button>
						))}
						{!TTL_CHOICES.some((c) => c.hours === a.sessionTtlHours) && <span className="self-center text-xs text-muted-foreground">{ttlLabel(a.sessionTtlHours)}</span>}
					</div>
					<p className="mt-1.5 text-xs text-subtle">Renewed while you keep using the UI; idle sessions expire after this long.</p>
				</KeyValue>
			</dl>
			{toggleReason && <LoopbackOnlyNote>{toggleReason}</LoopbackOnlyNote>}
			<div className="mt-3 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
				<p>
					<strong className="font-medium text-foreground">What this exposes:</strong> the full web UI of this node (sessions, files, git, settings) to anyone who can sign in with the owner password. A signed-in browser can run agents on this machine, so choose a long, unique password.
				</p>
				<p>
					<strong className="font-medium text-foreground">What stays protected:</strong> the node-to-node API (<code className="font-mono">/api/v1</code>) keeps requiring a signed request from a paired node. It never accepts this password or the browser session, and turning this on or off does not change it.
				</p>
			</div>
			<ConfirmDialog
				open={confirmEnable}
				onOpenChange={setConfirmEnable}
				title="Allow remote access to this UI?"
				description="Anyone who knows the owner password will be able to sign in at your public address and control agents on this machine. The node-to-node API stays signature-protected either way."
				confirmLabel="Turn on"
				loading={patch.isPending}
				onConfirm={() => patch.mutate({ remoteUiEnabled: true }, { onSettled: () => setConfirmEnable(false) })}
			/>
		</SettingsSection>
	);
}

function PasswordSection({ a }: { a: AccessStatus }) {
	const loopback = a.via === "loopback";
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [again, setAgain] = useState("");
	const first = !a.passwordSet;
	const save = useAccessMutation(
		(body: { password: string; currentPassword?: string }) => api.put<AccessStatus>(routes.accessPassword, body),
		first ? "Owner password set" : "Owner password changed",
	);
	const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LENGTH;
	const mismatch = again.length > 0 && again !== next;
	const needsCurrent = !first && !loopback;
	const ready = next.length >= MIN_PASSWORD_LENGTH && next === again && (!needsCurrent || current.length > 0);
	const blocked = first && !loopback;

	function submit(e: FormEvent) {
		e.preventDefault();
		if (!ready || blocked) return;
		save.mutate(
			{ password: next, ...(needsCurrent ? { currentPassword: current } : {}) },
			{
				onSuccess: () => {
					setCurrent("");
					setNext("");
					setAgain("");
				},
			},
		);
	}

	return (
		<SettingsSection
			title="Owner password"
			description={first ? "Required before remote access can be turned on. Stored only as a salted scrypt hash on this machine." : "Used to sign in from other browsers. Stored only as a salted scrypt hash on this machine."}
			actions={<Badge variant={a.passwordSet ? "success" : "neutral"}>{a.passwordSet ? "Set" : "Not set"}</Badge>}
		>
			<form onSubmit={submit} className="max-w-md space-y-3" noValidate>
				<input type="text" name="username" autoComplete="username" value="owner" readOnly hidden />
				{needsCurrent && (
					<Field label="Current password">
						{(id) => <Input id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} disabled={save.isPending} />}
					</Field>
				)}
				<Field label={first ? "New password" : "New password"} hint={`At least ${MIN_PASSWORD_LENGTH} characters. A passphrase of several words works well.`} error={tooShort ? `Use at least ${MIN_PASSWORD_LENGTH} characters.` : null}>
					{(id) => <Input id={id} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} disabled={blocked || save.isPending} aria-invalid={tooShort || undefined} />}
				</Field>
				<Field label="Repeat new password" error={mismatch ? "The passwords do not match." : null}>
					{(id) => <Input id={id} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} disabled={blocked || save.isPending} aria-invalid={mismatch || undefined} />}
				</Field>
				<Button type="submit" variant="primary" loading={save.isPending} disabled={!ready || blocked}>
					<KeyRound /> {first ? "Set password" : "Change password"}
				</Button>
			</form>
			{blocked && <LoopbackOnlyNote>The first password can only be set from the computer this node runs on, so it can never be set by someone who reaches the public address.</LoopbackOnlyNote>}
			{!first && !loopback && <LoopbackOnlyNote>Changing the password here also asks for the current one. Other signed-in browsers keep working until you use “Sign out everywhere”.</LoopbackOnlyNote>}
		</SettingsSection>
	);
}

function SignInSessionsSection({ a }: { a: AccessStatus }) {
	const remote = a.via === "remote";
	const router = useRouter();
	const drop = useDropOwnerData();
	const qc = useQueryClient();
	const { signOut, pending } = useSignOut();
	const [confirm, setConfirm] = useState(false);
	const all = useAccessMutation(async () => {
		await api.post(routes.accessLogoutAll);
	});
	const expires = a.sessionExpiresAt ? new Date(a.sessionExpiresAt).toLocaleString() : null;

	return (
		<SettingsSection title="Signed-in browsers" description="Browsers that signed in through the public address. They never need the loopback UI.">
			<dl className="divide-y divide-border">
				<KeyValue label="This connection">
					<span className="inline-flex items-center gap-1.5">
						<Monitor className="size-3.5 text-subtle" />
						{remote ? `Remote browser${expires ? ` · session until ${expires}` : ""}` : "Local (this computer): no sign-in needed"}
					</span>
				</KeyValue>
			</dl>
			<div className="mt-3 flex flex-wrap gap-2">
				{remote && (
					<Button variant="outline" loading={pending} onClick={signOut}>
						<LogOut /> Sign out
					</Button>
				)}
				<Button variant="outline" disabled={!a.passwordSet} onClick={() => setConfirm(true)}>
					Sign out everywhere
				</Button>
			</div>
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				title="Sign out every browser?"
				description={remote ? "Every remote browser, including this one, will have to sign in again." : "Every remote browser will have to sign in again."}
				confirmLabel="Sign out everywhere"
				danger
				loading={all.isPending}
				onConfirm={() =>
					all.mutate(undefined, {
						onSuccess: () => {
							setConfirm(false);
							toast.success("All remote sessions ended");
							if (remote) {
								drop();
								qc.removeQueries({ queryKey: accessKey });
								authGate.require();
								void router.navigate({ to: "/login", replace: true });
							}
						},
					})
				}
			/>
		</SettingsSection>
	);
}

function SecurityNotes() {
	return (
		<SettingsSection title="How sign-in is protected">
			<ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
				<li>The password is never stored or sent anywhere except as a one-way hash on this machine; it is checked in constant time.</li>
				<li>Repeated wrong passwords lock sign-in for longer and longer, per browser and for the node as a whole.</li>
				<li>The session cookie is HttpOnly, Secure and SameSite=Strict, so scripts on other sites cannot read or send it. Every change request must come from this node's own address.</li>
				<li>Only this machine can set the first password, turn remote access on or off, or edit the tunnel. Someone who reaches your public address cannot.</li>
				<li>Terminals and the agent runtime's raw channel are never exposed through the web UI, with or without remote access.</li>
			</ul>
		</SettingsSection>
	);
}

export default function SecurityPage() {
	const access = useAccess();
	const sec = useSecurityInfo();
	const s = sec.data;
	const fingerprint = s?.fingerprint.match(/.{1,4}/g)?.join(" ");

	return (
		<>
			<PageIntro title="Security" description="How this node is exposed and where its secrets live." />
			<PageBody>
				{access.isPending && <Skeleton className="h-48" />}
				{access.isError && <InlineError error={access.error} onRetry={() => access.refetch()} />}
				{access.data && (
					<>
						<RemoteAccessSection a={access.data} />
						<PasswordSection a={access.data} />
						<SignInSessionsSection a={access.data} />
						<SecurityNotes />
					</>
				)}
				{sec.isPending && <Skeleton className="h-48" />}
				{sec.isError && <InlineError error={sec.error} onRetry={() => sec.refetch()} />}
				{s && (
					<>
						<SettingsSection title="Network exposure">
							<dl className="divide-y divide-border">
								<KeyValue label="Bind address" mono>
									{s.bindAddress}
								</KeyValue>
								<KeyValue label="Allowed Host headers">
									<span className="flex flex-wrap gap-1">
										{s.allowedHosts.map((h) => (
											<span key={h} className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">
												{h}
											</span>
										))}
									</span>
								</KeyValue>
								<KeyValue label="Remote node API">
									<Badge variant={s.remoteApiEnabled ? "warning" : "success"}>{s.remoteApiEnabled ? "Enabled" : "Disabled"}</Badge>
								</KeyValue>
							</dl>
							<p className="mt-3 text-xs text-muted-foreground">
								Requests with an unrecognized Host or Origin are rejected to defend against DNS rebinding. The OMP RPC channel and a terminal are never exposed.
							</p>
						</SettingsSection>
						<SettingsSection title="Secret store" description="GitHub tokens are kept here. Provider credentials stay inside OMP.">
							<dl className="divide-y divide-border">
								<KeyValue label="Backend">{BACKEND_LABEL[s.secretStore.backend]}</KeyValue>
								<KeyValue label="Location" mono>
									{s.secretStore.location}
								</KeyValue>
							</dl>
							{s.secretStore.backend === "encrypted-file" && (
								<p className="mt-3 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">
									No OS keychain was available, so secrets are stored in a local encrypted file. Protect this machine's user account accordingly.
								</p>
							)}
						</SettingsSection>
						<SettingsSection title="Node identity" description="Other nodes will verify this fingerprint when pairing.">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<code className="break-all font-mono text-xs leading-relaxed">{fingerprint}</code>
								<CopyButton value={s.fingerprint} label="Copy" />
							</div>
						</SettingsSection>
					</>
				)}
			</PageBody>
		</>
	);
}
