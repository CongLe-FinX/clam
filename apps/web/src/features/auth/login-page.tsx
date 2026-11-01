import { type AccessStatus, routes } from "@clam/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { AlertTriangle, Eye, EyeOff, Fingerprint, Lock, ShieldAlert, Timer } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Logo } from "@/app/shell/sidebar.tsx";
import { T, t } from "@/i18n";
import { api, ApiError, errorText } from "@/lib/api";
import { formatDuration, shortFingerprint } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Skeleton } from "@/ui/skeleton";
import { authGate, safeRedirect } from "./gate.ts";
import { accessKey, useAccess, useDropOwnerData } from "./hooks.ts";

interface LoginError {
	message: string;
	/** Seconds until another attempt is accepted (429). */
	retryAfter?: number;
}

function toLoginError(e: unknown): LoginError {
	if (e instanceof ApiError) {
		if (e.code === "rate_limited") {
			const sec = (e.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
			const retryAfter = typeof sec === "number" && sec > 0 ? Math.ceil(sec) : 30;
			return { message: t("Too many attempts. Sign-in is locked for a moment."), retryAfter };
		}
		if (e.code === "invalid_credentials") return { message: t("Wrong password. Check it and try again.") };
		if (e.code === "forbidden_origin") return { message: t("This address is not allowed to sign in. Open the machine's own public URL.") };
		return { message: errorText(e) };
	}
	return { message: t("Could not sign in. Try again.") };
}

export default function LoginPage({ redirect }: { redirect?: string }) {
	const router = useRouter();
	const qc = useQueryClient();
	const drop = useDropOwnerData();
	const access = useAccess({ fresh: true });
	// Ignore data cached before this visit: a stale `signedIn: true` would bounce straight back into a 401 loop.
	const a = access.isFetching ? undefined : access.data;
	const [password, setPassword] = useState("");
	const [show, setShow] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<LoginError | null>(null);
	const [lockedUntil, setLockedUntil] = useState(0);
	const [now, setNow] = useState(() => Date.now());
	const target = safeRedirect(redirect);

	const leave = () => void router.history.replace(target);

	// Already signed in (reload of /login) or this is the loopback UI, which has no login.
	useEffect(() => {
		if (a && (a.via === "loopback" || a.signedIn)) {
			authGate.clear();
			leave();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [a?.via, a?.signedIn]);

	useEffect(() => {
		if (lockedUntil <= Date.now()) return;
		const timer = setInterval(() => {
			setNow(Date.now());
			if (Date.now() >= lockedUntil) clearInterval(timer);
		}, 500);
		return () => clearInterval(timer);
	}, [lockedUntil]);

	const remaining = Math.max(0, Math.ceil((lockedUntil - now) / 1000));
	const locked = remaining > 0;
	const disabledReason = a && !a.passwordSet ? "no-password" : a && !a.remoteUiEnabled && a.via === "remote" ? "remote-off" : null;

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (busy || locked || !password) return;
		setBusy(true);
		setError(null);
		try {
			const next = await api.post<AccessStatus>(routes.accessLogin, { password });
			setPassword("");
			drop();
			qc.setQueryData(accessKey, next);
			authGate.clear();
			leave();
		} catch (err) {
			const le = toLoginError(err);
			setError(le);
			setPassword("");
			if (le.retryAfter) {
				setLockedUntil(Date.now() + le.retryAfter * 1000);
				setNow(Date.now());
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="relative grid min-h-dvh place-items-center overflow-hidden bg-background px-4 py-10 text-foreground">
			<div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(60%_100%_at_50%_0%,var(--accent-soft),transparent)]" />
			<main className="relative w-full max-w-sm animate-slide-up">
				<div className="mb-6 flex flex-col items-center gap-3 text-center">
					<Logo className="size-11 rounded-xl [&_svg]:size-6" />
					<div>
						<h1 className="text-lg font-semibold tracking-tight">CL Agent Mesh</h1>
						{a ? (
							<p className="mt-1 text-sm text-muted-foreground">
								<T text="Sign in to <b>{name}</b>" params={{ name: a.nodeName }} tags={{ b: <span className="font-medium text-foreground" /> }} />
							</p>
						) : access.isError ? (
							<p className="mt-1 text-sm text-muted-foreground">{t("Sign in to this machine")}</p>
						) : (
							<Skeleton className="mx-auto mt-1 h-5 w-40" />
						)}
					</div>
				</div>

				<div className="rounded-2xl border border-border bg-surface-1 p-5 shadow-pop">
					{access.isError ? (
						<div role="alert" className="flex items-start gap-2.5 text-sm text-danger">
							<AlertTriangle className="mt-0.5 size-4 shrink-0" />
							<div className="space-y-2">
								<p>{access.error instanceof Error ? errorText(access.error) : t("Cannot reach this machine.")}</p>
								<Button size="sm" variant="outline" onClick={() => access.refetch()}>
									{t("Retry")}
								</Button>
							</div>
						</div>
					) : disabledReason ? (
						<div className="flex items-start gap-2.5 text-sm">
							<ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
							<p className="text-muted-foreground">
								{disabledReason === "no-password"
									? t("No owner password is set on this machine yet. Set one in Settings → Security on the computer where this machine runs, then sign in here.")
									: t("Remote access to this machine's web UI is turned off. Turn it on in Settings → Security on the computer where this machine runs.")}
							</p>
						</div>
					) : (
						<form onSubmit={submit} className="space-y-4" noValidate>
							{/* Lets password managers pair the credential with this machine. */}
							<input type="text" name="username" autoComplete="username" value={a?.nodeName ?? "owner"} readOnly hidden />
							<div className="flex flex-col gap-1.5">
								<label htmlFor="owner-password" className="text-xs font-medium text-muted-foreground">
									{t("Owner password")}
								</label>
								<div className="relative">
									<Input
										id="owner-password"
										type={show ? "text" : "password"}
										name="password"
										autoComplete="current-password"
										autoFocus
										required
										value={password}
										onChange={(e) => setPassword(e.target.value)}
										aria-invalid={error && !locked ? true : undefined}
										aria-describedby={error ? "login-error" : undefined}
										disabled={!a}
										className="h-10 pr-10 coarse:h-12"
									/>
									<button
										type="button"
										onClick={() => setShow((v) => !v)}
										aria-label={show ? t("Hide password") : t("Show password")}
										className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-lg text-subtle outline-none hover:text-foreground focus-visible:text-foreground"
									>
										{show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
									</button>
								</div>
							</div>

							{error ? (
								<div id="login-error" role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
									{locked ? <Timer className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
									<div>
										<p>{error.message}</p>
										{error.retryAfter ? <p className="mt-0.5 text-xs text-danger/80">{locked ? t("Try again in {wait}.", { wait: formatDuration(remaining * 1000) }) : t("You can try again now.")}</p> : null}
									</div>
								</div>
							) : null}

							<Button type="submit" size="lg" variant="primary" className="w-full" loading={busy} disabled={!a || !password || locked}>
								{locked ? (
									<>
										<Timer /> {t("Locked · {wait}", { wait: formatDuration(remaining * 1000) })}
									</>
								) : (
									<>
										<Lock /> {t("Sign in")}
									</>
								)}
							</Button>
						</form>
					)}
				</div>

				<div className="mt-5 flex flex-col items-center gap-1.5 text-center text-2xs text-subtle">
					{a ? (
						<span className="inline-flex items-center gap-1.5 font-mono">
							<Fingerprint className="size-3.5" />
							{shortFingerprint(a.fingerprint)}
						</span>
					) : null}
					<p>{t("Owner access only. This machine's agent-to-agent API is separate and never uses this password.")}</p>
				</div>
			</main>
		</div>
	);
}
