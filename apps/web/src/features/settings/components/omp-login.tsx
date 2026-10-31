import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, Terminal, XCircle } from "lucide-react";
import type { LoginFlow, LoginProvider } from "@clam/contracts";
import { qk } from "@/lib/queries";
import { useTopic } from "@/lib/ws";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Skeleton } from "@/ui/skeleton";
import { useCancelLogin, useLoginInput, useStartLogin } from "../hooks";
import { CopyButton, InlineError } from "./section";

const ACTIVE = new Set<LoginFlow["state"]>(["starting", "awaiting_browser", "awaiting_input"]);

function PromptForm({ flow, onSubmit, busy }: { flow: LoginFlow; onSubmit: (v: string) => void; busy: boolean }) {
	const [value, setValue] = useState("");
	const prompt = flow.prompt!;
	return (
		<form
			className="space-y-2"
			onSubmit={(e) => {
				e.preventDefault();
				onSubmit(value);
				setValue("");
			}}
		>
			<label htmlFor="login-prompt" className="block text-sm font-medium">
				{prompt.message}
			</label>
			<div className="flex gap-2">
				<Input
					id="login-prompt"
					autoFocus
					value={value}
					onChange={(e) => setValue(e.target.value)}
					placeholder={prompt.placeholder}
					autoComplete="off"
					spellCheck={false}
					className="font-mono"
				/>
				<Button type="submit" loading={busy} disabled={value.trim() === ""}>
					Submit
				</Button>
			</div>
		</form>
	);
}

/**
 * Drives OMP's official login through the server (`POST /omp/login`). Live state arrives on
 * `login:<flowId>`; answers go back through `/omp/login/:id/input`.
 */
export function OmpLoginDialog({ provider, onClose }: { provider: LoginProvider | null; onClose: () => void }) {
	const qc = useQueryClient();
	const start = useStartLogin();
	const cancel = useCancelLogin();
	const [flow, setFlow] = useState<LoginFlow | null>(null);
	const startedFor = useRef<string | null>(null);
	const input = useLoginInput(flow?.flowId ?? "");

	const begin = useCallback(
		(p: LoginProvider) => {
			setFlow(null);
			start.mutate(p.id, { onSuccess: setFlow });
		},
		[start],
	);

	useEffect(() => {
		if (provider && startedFor.current !== provider.id) {
			startedFor.current = provider.id;
			begin(provider);
		}
		if (!provider) {
			startedFor.current = null;
			setFlow(null);
			start.reset();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- run only when the target provider changes
	}, [provider?.id]);

	const active = flow != null && ACTIVE.has(flow.state);

	useTopic(flow ? `login:${flow.flowId}` : null, (ev) => {
		const e = ev as { type: "flow"; flow: LoginFlow };
		if (e.type !== "flow") return;
		setFlow(e.flow);
		if (e.flow.state === "success") {
			void qc.invalidateQueries({ queryKey: qk.ompProviders });
			void qc.invalidateQueries({ queryKey: qk.ompModels });
			void qc.invalidateQueries({ queryKey: qk.usageQuota });
			if (provider) void qc.invalidateQueries({ queryKey: qk.ompAccounts(provider.id) });
		}
	});

	const close = () => {
		if (flow && active) cancel.mutate(flow.flowId);
		onClose();
	};

	return (
		<Dialog open={provider != null} onOpenChange={(o) => !o && close()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Sign in to {provider?.name}</DialogTitle>
					<DialogDescription>Uses OMP's own login. CL Agent Mesh never sees or stores your provider credentials.</DialogDescription>
				</DialogHeader>

				{start.isError && <InlineError error={start.error} onRetry={() => provider && begin(provider)} title="Could not start login" />}
				{(start.isPending || flow?.state === "starting") && (
					<div className="space-y-2">
						<Skeleton className="h-10" />
						<p className="text-xs text-muted-foreground">Starting login…</p>
					</div>
				)}

				{flow && (flow.state === "awaiting_browser" || flow.state === "awaiting_input") && (
					<div className="space-y-4">
						{flow.instructions && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{flow.instructions}</p>}
						{flow.url && (
							<div className="space-y-2 rounded-lg border border-border bg-surface-2 p-3">
								<div className="text-xs text-muted-foreground">Authorize in your browser:</div>
								<code className="block max-h-16 overflow-y-auto break-all font-mono text-[11px]">{flow.url}</code>
								<div className="flex flex-wrap gap-2">
									<Button size="sm" onClick={() => window.open(flow.url, "_blank", "noopener,noreferrer")}>
										<ExternalLink className="size-3.5" />
										Open sign-in page
									</Button>
									<CopyButton value={flow.url} label="Copy link" />
								</div>
							</div>
						)}
						{flow.state === "awaiting_input" && flow.prompt && (
							<PromptForm
								key={flow.prompt.requestId}
								flow={flow}
								busy={input.isPending}
								onSubmit={(value) => input.mutate({ requestId: flow.prompt!.requestId, value }, { onSuccess: setFlow })}
							/>
						)}
						{input.isError && <InlineError error={input.error} />}
						{flow.state === "awaiting_browser" && (
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<span className="size-1.5 animate-pulse rounded-full bg-accent" />
								Waiting for you to finish in the browser…
							</div>
						)}
						<div className="flex items-start gap-2 rounded-md border border-border bg-surface-1 p-2.5 text-xs text-muted-foreground">
							<Terminal className="mt-0.5 size-3.5 shrink-0" />
							<span>
								Secret prompts (API keys, tokens) are not accepted here. For those providers run{" "}
								<code className="font-mono text-foreground">omp login {provider?.id}</code> in a terminal.
							</span>
						</div>
					</div>
				)}

				{flow?.state === "success" && (
					<div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success/10 p-4 text-sm">
						<CheckCircle2 className="size-5 shrink-0 text-success" />
						Signed in to {provider?.name}.
					</div>
				)}
				{(flow?.state === "error" || flow?.state === "cancelled") && (
					<div className="space-y-3">
						<div className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm">
							<XCircle className="mt-0.5 size-5 shrink-0 text-danger" />
							<div className="min-w-0 break-words">
								{flow.state === "cancelled" ? "Login was cancelled." : (flow.error ?? "Login failed.")}
								{flow.state === "error" && (
									<p className="mt-2 text-xs text-muted-foreground">
										If this provider asks for an API key, sign in from a terminal with{" "}
										<code className="font-mono text-foreground">omp login {provider?.id}</code>.
									</p>
								)}
							</div>
						</div>
						<Button variant="outline" onClick={() => provider && begin(provider)}>
							Try again
						</Button>
					</div>
				)}

				<DialogFooter>
					<Button variant="ghost" onClick={close}>
						{active ? "Cancel login" : flow?.state === "success" ? "Done" : "Close"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
