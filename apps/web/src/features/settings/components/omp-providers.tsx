import { useMemo, useState } from "react";
import { ChevronDown, LogIn, LogOut, Search } from "lucide-react";
import { toast } from "sonner";
import type { LoginProvider, ProviderAccount } from "@clam/contracts";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Skeleton } from "@/ui/skeleton";
import { StatusDot } from "@/ui/status-dot";
import { useLogout, useProviderAccounts } from "../hooks";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InlineError } from "./section";

function Accounts({ provider }: { provider: LoginProvider }) {
	const accounts = useProviderAccounts(provider.id, true);
	const logout = useLogout();
	const [target, setTarget] = useState<ProviderAccount | null>(null);

	return (
		<div className="border-t border-border bg-surface-1/60 px-3 py-3">
			{accounts.isPending && <Skeleton className="h-10" />}
			{accounts.isError && <InlineError error={accounts.error} onRetry={() => accounts.refetch()} />}
			{accounts.data && accounts.data.length === 0 && <div className="text-xs text-muted-foreground">No stored accounts for this provider.</div>}
			{accounts.data && accounts.data.length > 0 && (
				<ul className="space-y-2">
					{accounts.data.map((a) => (
						<li key={a.credentialId} className="flex items-center justify-between gap-3 rounded-md border border-border bg-background p-2.5">
							<div className="min-w-0">
								<div className="flex items-center gap-2">
									<span className="truncate text-sm">{a.label}</span>
									{a.active && <Badge variant="success">Active</Badge>}
									<Badge variant="outline">{a.type}</Badge>
								</div>
								{a.detail && <div className="truncate font-mono text-[11px] text-muted-foreground">{a.detail}</div>}
							</div>
							<Button size="sm" variant="ghost" className="shrink-0 text-danger hover:text-danger" onClick={() => setTarget(a)}>
								<LogOut className="size-3.5" />
								Log out
							</Button>
						</li>
					))}
				</ul>
			)}
			<ConfirmDialog
				open={target != null}
				onOpenChange={(o) => !o && setTarget(null)}
				title={`Log out of ${provider.name}?`}
				description={
					<>
						Removes <span className="font-medium">{target?.label}</span> from OMP's credential store. Agents using this account will fail until you sign in again.
					</>
				}
				confirmLabel="Log out"
				danger
				loading={logout.isPending}
				onConfirm={() => {
					if (!target) return;
					logout.mutate(
						{ providerId: provider.id, credentialId: target.credentialId },
						{
							onSuccess: (r) =>
								toast.success(`Logged out of ${provider.name}`, r.remainingSource ? { description: `Still authenticated via ${r.remainingSource}.` } : undefined),
							onError: (e) => toast.error("Logout failed", { description: errorMessage(e) }),
							onSettled: () => setTarget(null),
						},
					);
				}}
			/>
		</div>
	);
}

function ProviderRow({ p, onLogin }: { p: LoginProvider; onLogin: () => void }) {
	const [open, setOpen] = useState(false);
	return (
		<li className="overflow-hidden rounded-lg border border-border bg-surface-1">
			<div className="flex items-center gap-3 p-3">
				<StatusDot status={p.authenticated ? "ok" : "offline"} label={p.authenticated ? "Authenticated" : "Not signed in"} />
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium">{p.name}</div>
					<div className="truncate font-mono text-[11px] text-muted-foreground">{p.id}</div>
				</div>
				<Badge variant={p.authenticated ? "success" : p.available ? "neutral" : "outline"} className="hidden sm:inline-flex">
					{p.authenticated ? "Signed in" : p.available ? "Not signed in" : "Unavailable"}
				</Badge>
				{p.authenticated && (
					<Button size="sm" variant="ghost" aria-label="Show accounts" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
						<span className="hidden sm:inline">Accounts</span>
						<ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
					</Button>
				)}
				<Button size="sm" variant={p.authenticated ? "outline" : "primary"} disabled={!p.available} onClick={onLogin} title={p.available ? undefined : "This provider cannot be signed in to from here"}>
					<LogIn className="size-3.5" />
					<span className="hidden sm:inline">{p.authenticated ? "Add account" : "Connect"}</span>
				</Button>
			</div>
			{open && p.authenticated && <Accounts provider={p} />}
		</li>
	);
}

const COLLAPSED_LIMIT = 6;

export function ProvidersList({ providers, onLogin }: { providers: LoginProvider[]; onLogin: (p: LoginProvider) => void }) {
	const [q, setQ] = useState("");
	const [showAll, setShowAll] = useState(false);
	const sorted = useMemo(
		() => [...providers].sort((a, b) => Number(b.authenticated) - Number(a.authenticated) || a.name.localeCompare(b.name)),
		[providers],
	);
	if (sorted.length === 0) return <div className="py-6 text-center text-sm text-muted-foreground">OMP reported no login providers.</div>;

	const needle = q.trim().toLowerCase();
	const matches = needle ? sorted.filter((p) => p.name.toLowerCase().includes(needle) || p.id.includes(needle)) : sorted;
	const signedIn = sorted.filter((p) => p.authenticated).length;
	const limit = Math.max(COLLAPSED_LIMIT, signedIn);
	const visible = !needle && !showAll ? matches.slice(0, limit) : matches;

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<div className="relative flex-1">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
					<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search providers" aria-label="Search providers" className="pl-8" />
				</div>
				<span className="shrink-0 text-xs text-muted-foreground">
					{signedIn} of {sorted.length} signed in
				</span>
			</div>
			{visible.length === 0 && <div className="py-4 text-center text-sm text-muted-foreground">No providers match.</div>}
			<ul className="space-y-2">
				{visible.map((p) => (
					<ProviderRow key={p.id} p={p} onLogin={() => onLogin(p)} />
				))}
			</ul>
			{!needle && matches.length > limit && (
				<Button variant="ghost" size="sm" className="w-full" onClick={() => setShowAll((s) => !s)}>
					{showAll ? "Show fewer" : `Show ${matches.length - limit} more providers`}
				</Button>
			)}
		</div>
	);
}
