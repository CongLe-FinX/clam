import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, XCircle } from "lucide-react";
import { routes, type DeviceFlowStart, type DeviceFlowStatus } from "@clam/contracts";
import { T, t } from "@/i18n";
import { api } from "@/lib/api";
import { qk } from "@/lib/queries";
import { useTopic } from "@/lib/ws";
import { formatDuration } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Skeleton } from "@/ui/skeleton";
import { useNow } from "@/features/usage/format";
import { useStartDeviceFlow } from "../hooks";
import { CopyButton, InlineError } from "./section";

/**
 * GitHub OAuth device flow. The server polls GitHub; this dialog shows the code, listens on the
 * `github-device:<flowId>` topic and falls back to polling the status route if the socket is down.
 */
export function GithubDeviceFlowDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
	const qc = useQueryClient();
	const start = useStartDeviceFlow();
	const [flow, setFlow] = useState<DeviceFlowStart | null>(null);
	const [status, setStatus] = useState<DeviceFlowStatus | null>(null);
	const startedFor = useRef(false);

	const begin = useCallback(() => {
		setFlow(null);
		setStatus(null);
		start.mutate(undefined, { onSuccess: setFlow });
	}, [start]);

	useEffect(() => {
		if (open && !startedFor.current) {
			startedFor.current = true;
			begin();
		}
		if (!open) {
			startedFor.current = false;
			setFlow(null);
			setStatus(null);
			start.reset();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- only react to open changes
	}, [open]);

	const finished = status != null && status.state !== "pending";
	const applyStatus = useCallback(
		(s: DeviceFlowStatus) => {
			setStatus(s);
			if (s.state === "success") void qc.invalidateQueries({ queryKey: qk.githubAccounts });
		},
		[qc],
	);

	useTopic(flow && !finished ? `github-device:${flow.flowId}` : null, (ev) => {
		const e = ev as { type: "flow"; status: DeviceFlowStatus };
		if (e.type === "flow") applyStatus(e.status);
	}, { onResync: () => void poll.refetch() });

	const poll = useQuery({
		queryKey: ["local", "github", "device", flow?.flowId ?? ""],
		enabled: Boolean(flow) && !finished,
		queryFn: async ({ signal }) => {
			const s = await api.get<DeviceFlowStatus>(routes.githubDeviceStatus(flow!.flowId), undefined, { signal });
			applyStatus(s);
			return s;
		},
		refetchInterval: Math.max(3, flow?.intervalSec ?? 5) * 1000,
		gcTime: 0,
	});

	const now = useNow(1000);
	const remaining = flow ? Date.parse(flow.expiresAt) - now : 0;
	const state = status?.state ?? "pending";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("Connect GitHub account")}</DialogTitle>
					<DialogDescription>{t("Authorize CL Agent Mesh on github.com using a one-time device code.")}</DialogDescription>
				</DialogHeader>

				{start.isError && <InlineError error={start.error} onRetry={begin} title={t("Could not start the device flow")} />}
				{start.isPending && <Skeleton className="h-32" />}

				{flow && state === "pending" && (
					<div className="space-y-4">
						<ol className="space-y-1 text-sm text-muted-foreground">
							<li>{t("1. Open the verification page and sign in to the account you want to connect.")}</li>
							<li>{t("2. Enter this code when asked:")}</li>
						</ol>
						<div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface-2 p-5">
							<code className="select-all text-center font-mono text-3xl font-semibold tracking-[0.25em] sm:text-4xl" aria-label={t("Device code")}>
								{flow.userCode}
							</code>
							<div className="flex flex-wrap justify-center gap-2">
								<CopyButton value={flow.userCode} label={t("Copy code")} />
								<Button size="sm" onClick={() => window.open(flow.verificationUri, "_blank", "noopener,noreferrer")}>
									<ExternalLink className="size-3.5" />
									{t("Open {host}", { host: new URL(flow.verificationUri).host })}
								</Button>
							</div>
						</div>
						<div className="flex items-center justify-between text-xs text-muted-foreground">
							<span className="inline-flex items-center gap-2">
								<span className="size-1.5 animate-pulse rounded-full bg-accent" />
								{t("Waiting for authorization…")}
							</span>
							<span className="font-mono tabular-nums">{remaining > 0 ? t("Code expires in {time}", { time: formatDuration(remaining) }) : t("Code expired")}</span>
						</div>
					</div>
				)}

				{state === "success" && (
					<div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success/10 p-4 text-sm">
						<CheckCircle2 className="size-5 shrink-0 text-success" />
						<span>
							{status?.account ? (
								<T text="Connected as <code>{login}</code>." params={{ login: status.account.login }} tags={{ code: <span className="font-mono" /> }} />
							) : (
								t("Connected.")
							)}
						</span>
					</div>
				)}
				{(state === "expired" || state === "denied" || state === "error") && (
					<div className="space-y-3">
						<div className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm">
							<XCircle className="mt-0.5 size-5 shrink-0 text-danger" />
							<span>
								{state === "expired" && t("The code expired before it was used.")}
								{state === "denied" && t("Authorization was denied on GitHub.")}
								{state === "error" && (status?.error ?? t("The device flow failed."))}
							</span>
						</div>
						<Button variant="outline" onClick={begin}>
							{t("Get a new code")}
						</Button>
					</div>
				)}

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						{state === "success" ? t("Done") : t("Cancel")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
