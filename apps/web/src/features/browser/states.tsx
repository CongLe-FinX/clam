import { type AccessStatus, type BrowserStatus, type ListeningPort, routes } from "@clam/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Globe, Lock, Menu, RefreshCw, ShieldAlert, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { accessKey, useAccess } from "@/features/auth/hooks";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useUi } from "@/lib/store";
import { Button } from "@/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/card";
import { Input } from "@/ui/input";
import { Progress } from "@/ui/progress";
import { Skeleton } from "@/ui/skeleton";
import { bk } from "./api.ts";
import { PortChips } from "./ports-row.tsx";

/** The Browser is full-screen on phones (no app top bar), so every state card carries its own way back to the navigation. */
function CenteredCard({ children }: { children: React.ReactNode }) {
	const openNav = useUi((s) => s.setDrawerOpen);
	return (
		<div className="relative h-full">
			<Button variant="ghost" size="icon" aria-label="Open navigation" onClick={() => openNav(true)} className="absolute left-1 top-[max(0.25rem,env(safe-area-inset-top))] z-10 md:hidden">
				<Menu />
			</Button>
			<div className="scrollbar-thin h-full overflow-y-auto overscroll-contain">
				<div className="mx-auto flex min-h-full w-full max-w-lg items-center px-4 py-8">
					<Card className="w-full">{children}</Card>
				</div>
			</div>
		</div>
	);
}

/** First load / cold start of the machine's browser: the toolbar and viewer shapes, no spinner soup. */
export function BrowserSkeleton({ label }: { label?: string }) {
	return (
		<div className="flex h-full flex-col" role="status" aria-label={label ?? "Loading the browser"}>
			<div className="flex items-center gap-2 border-b p-2">
				<Skeleton className="size-8 coarse:size-11" />
				<Skeleton className="size-8 coarse:size-11" />
				<Skeleton className="h-8 flex-1 coarse:h-11" />
				<Skeleton className="hidden h-8 w-24 sm:block" />
			</div>
			<div className="flex items-center gap-2 border-b p-2">
				<Skeleton className="h-7 w-36" />
				<Skeleton className="h-7 w-7" />
			</div>
			<div className="grid min-h-0 flex-1 place-items-center bg-surface-2">
				{label ? <p className="text-[13px] text-muted-foreground">{label}</p> : null}
			</div>
		</div>
	);
}

export function ErrorCard({ title, message, onRetry, retrying }: { title: string; message: string; onRetry: () => void; retrying?: boolean }) {
	return (
		<CenteredCard>
			<CardHeader className="flex-col gap-1">
				<CardTitle className="flex items-center gap-2">
					<TriangleAlert className="size-4 text-danger" /> {title}
				</CardTitle>
				<CardDescription className="break-words">{message}</CardDescription>
			</CardHeader>
			<CardContent className="pt-3">
				<Button variant="primary" onClick={onRetry} loading={retrying}>
					<RefreshCw /> Retry
				</Button>
			</CardContent>
		</CenteredCard>
	);
}

/** No browser executable on this machine: one-click install (progress polled via the status query) or manual guidance. */
export function InstallCard({ status }: { status: BrowserStatus }) {
	const qc = useQueryClient();
	const install = useMutation({
		mutationFn: () => api.post<BrowserStatus>(routes.browserInstall),
		onSuccess: (next) => qc.setQueryData(bk.status, next),
		onError: (e) => toast.error(errorMessage(e)),
	});
	const state = status.install.state;
	const running = state === "running" || install.isPending;
	const progress = status.install.progress;
	return (
		<CenteredCard>
			<CardHeader className="flex-col gap-1">
				<CardTitle className="flex items-center gap-2">
					<Globe className="size-4 text-accent" /> This machine needs a browser
				</CardTitle>
				<CardDescription>The Browser runs Chromium on this machine so you can open its localhost pages from anywhere. No Chrome, Chromium, Edge or Brave was found.</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3 pt-3">
				{running ? (
					<div className="flex flex-col gap-2" role="status">
						<div className="flex items-center justify-between text-[13px]">
							<span>Installing Chromium…</span>
							{progress !== null ? <span className="font-mono text-xs text-muted-foreground tabular">{Math.round(progress)}%</span> : null}
						</div>
						{progress !== null ? <Progress value={progress} /> : <Progress value={100} className="animate-pulse" />}
						{status.install.log.length > 0 ? <pre className="scrollbar-thin max-h-40 overflow-auto rounded-lg bg-surface-2 p-2.5 font-mono text-2xs leading-4 text-muted-foreground">{status.install.log.slice(-12).join("\n")}</pre> : null}
					</div>
				) : (
					<>
						{state === "failed" ? (
							<div role="alert" className="rounded-lg bg-danger/10 p-3 text-[13px] text-danger">
								<p className="font-medium">The install did not finish.</p>
								{status.install.error ? <p className="mt-1 break-words text-danger/90">{status.install.error}</p> : null}
								{status.install.log.length > 0 ? <pre className="scrollbar-thin mt-2 max-h-32 overflow-auto font-mono text-2xs leading-4 text-muted-foreground">{status.install.log.slice(-8).join("\n")}</pre> : null}
							</div>
						) : null}
						{status.canInstall ? (
							<div className="flex flex-col gap-2">
								<Button variant="primary" size="lg" onClick={() => install.mutate()}>
									<Download /> {state === "failed" ? "Try installing again" : "Install Chromium"}
								</Button>
								<p className="text-xs text-subtle">Downloads Chromium into this machine's data folder. It is used only by this Browser.</p>
							</div>
						) : (
							<div className="flex flex-col gap-2 text-[13px] text-muted-foreground">
								<p>The one-click install is not available here. Install Google Chrome, Chromium, Microsoft Edge or Brave on this machine, or point CL Agent Mesh at one:</p>
								<pre className="overflow-x-auto rounded-lg bg-surface-2 p-2.5 font-mono text-xs text-foreground">set CLAM_BROWSER_PATH=/path/to/chrome</pre>
								<p className="text-xs text-subtle">Then restart CL Agent Mesh and check again.</p>
								<Button variant="outline" className="self-start" onClick={() => void qc.invalidateQueries({ queryKey: bk.status })}>
									<RefreshCw /> Check again
								</Button>
							</div>
						)}
					</>
				)}
			</CardContent>
		</CenteredCard>
	);
}

function passwordProblem(e: unknown): string {
	if (e instanceof ApiError && e.status === 401) return "That password is not correct.";
	if (e instanceof ApiError && e.status === 429) return `${e.message || "Too many attempts."} Wait a moment and try again.`;
	return errorMessage(e);
}

/** 403 `tool_disabled` on the public origin: the Browser is off for remote access. Owners can switch it on with their password. */
export function RemoteOffCard() {
	const access = useAccess({ fresh: true });
	const qc = useQueryClient();
	const [password, setPassword] = useState("");
	const enable = useMutation({
		mutationFn: () => api.patch<AccessStatus>(routes.access, { remoteBrowserEnabled: true, password }),
		onSuccess: (next) => {
			qc.setQueryData(accessKey, next);
			setPassword("");
			void qc.invalidateQueries({ queryKey: bk.all });
			toast.success("Browser is on for remote access");
		},
	});
	const a = access.data;
	const canEnable = Boolean(a && a.via === "remote" && a.signedIn && a.passwordSet);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (password) enable.mutate();
	};
	return (
		<CenteredCard>
			<CardContent className="flex flex-col items-center gap-5 px-5 pb-6 pt-8 text-center sm:px-8">
				<div className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
					<Lock className="size-5" />
				</div>
				<div className="flex flex-col gap-1.5">
					<h2 className="text-base font-semibold tracking-tight">Browser is switched off for remote access</h2>
					<p className="text-[13px] text-muted-foreground">Turn it on from this machine's own UI (Settings → Remote access){canEnable ? ", or enable it here with your owner password." : "."}</p>
				</div>
				{canEnable ? (
					<form onSubmit={submit} className="flex w-full flex-col gap-3 text-left">
						<p className="flex items-start gap-2.5 rounded-xl bg-warning/10 p-3 text-xs leading-relaxed text-muted-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning)_28%,transparent)]">
							<ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
							<span>Lets anyone who signs in to this machine's domain browse from this machine, including its localhost services.</span>
						</p>
						<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
							Owner password
							<Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={enable.isError || undefined} className="coarse:text-base" />
						</label>
						{enable.isError ? (
							<p role="alert" className="text-xs text-danger">
								{passwordProblem(enable.error)}
							</p>
						) : null}
						<Button type="submit" variant="primary" size="lg" loading={enable.isPending} disabled={!password}>
							Enable remote Browser
						</Button>
					</form>
				) : null}
			</CardContent>
		</CenteredCard>
	);
}

/** Shown over the blank tab: how to get going, and the machine's own listeners one tap away. */
export function StartPage({ ports, onOpen }: { ports: ListeningPort[] | undefined; onOpen: (url: string) => void }) {
	return (
		<div className="scrollbar-thin absolute inset-0 overflow-y-auto bg-background">
			<div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center gap-5 px-6 py-10 text-center">
				<div className="grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_30%,transparent)]">
					<Globe className="size-6" />
				</div>
				<div className="flex flex-col gap-1.5">
					<h2 className="text-base font-semibold tracking-tight">Browse this machine</h2>
					<p className="text-[13px] text-muted-foreground">
						Type <code className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-xs text-foreground">localhost:1234</code> above. It is this machine's own localhost, not yours.
					</p>
				</div>
				{ports === undefined ? (
					<div className="flex gap-1.5" aria-hidden>
						<Skeleton className="h-7 w-32 rounded-full coarse:h-11" />
						<Skeleton className="h-7 w-28 rounded-full coarse:h-11" />
					</div>
				) : (
					<PortChips ports={ports} onOpen={onOpen} />
				)}
			</div>
		</div>
	);
}
