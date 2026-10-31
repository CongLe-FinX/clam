import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { NodeSettings } from "@clam/contracts";
import { errorMessage } from "@/lib/api";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Skeleton } from "@/ui/skeleton";
import { Switch } from "@/ui/switch";
import { InlineError, PageBody, PageIntro, SettingsSection } from "../components/section";
import { usePatchSettings, useSettings } from "../hooks";

const APPROVAL_MODES: { value: NodeSettings["approvalMode"]; label: string; hint: string }[] = [
	{ value: "always-ask", label: "Always ask", hint: "Every tool call needs your approval." },
	{ value: "always-ask-cached", label: "Always ask (remember)", hint: "Ask once per identical tool call, then remember it for the session." },
	{ value: "write", label: "Ask for writes", hint: "Read-only tools run freely; file writes and commands need approval." },
	{ value: "yolo", label: "Auto-approve everything", hint: "Agents run every tool without asking. Use only in disposable environments." },
];

function Row({ label, hint, children, htmlFor }: { label: string; hint?: string; children: React.ReactNode; htmlFor?: string }) {
	return (
		<div className="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
			<div className="min-w-0">
				<label htmlFor={htmlFor} className="text-sm font-medium">
					{label}
				</label>
				{hint && <p className="mt-0.5 max-w-md text-xs text-muted-foreground">{hint}</p>}
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

/** Text/number input that commits on blur or Enter and resyncs when the server value changes. */
function CommitInput({
	id,
	value,
	type = "text",
	min,
	max,
	suffix,
	onCommit,
	className,
}: {
	id: string;
	value: string | number;
	type?: "text" | "number";
	min?: number;
	max?: number;
	suffix?: string;
	onCommit: (v: string) => void;
	className?: string;
}) {
	const [draft, setDraft] = useState(String(value));
	useEffect(() => setDraft(String(value)), [value]);
	const commit = () => {
		const next = draft.trim();
		if (next === String(value)) return;
		if (next === "") return setDraft(String(value));
		onCommit(next);
	};
	return (
		<div className="flex items-center gap-2">
			<Input
				id={id}
				type={type}
				inputMode={type === "number" ? "numeric" : undefined}
				min={min}
				max={max}
				value={draft}
				className={className ?? "w-full sm:w-56"}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
					if (e.key === "Escape") setDraft(String(value));
				}}
			/>
			{suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
		</div>
	);
}

export default function GeneralPage() {
	const settings = useSettings();
	const patch = usePatchSettings();

	const save = (p: Partial<NodeSettings>, label: string) =>
		patch.mutate(p, {
			onSuccess: () => toast.success(`${label} updated`),
			onError: (e) => toast.error(`Could not save ${label.toLowerCase()}`, { description: errorMessage(e) }),
		});
	const num = (key: "runtimeIdleTimeoutMin" | "maxConcurrentRuntimes", label: string) => (v: string) => {
		const n = Number(v);
		if (!Number.isInteger(n)) return toast.error(`${label} must be a whole number`);
		save({ [key]: n }, label);
	};

	const s = settings.data;
	const mode = APPROVAL_MODES.find((m) => m.value === s?.approvalMode);

	return (
		<>
			<PageIntro title="General" description="Settings for this node. Changes apply immediately; running agent processes pick up approval mode on their next start." />
			<PageBody>
				{settings.isError && <InlineError error={settings.error} onRetry={() => settings.refetch()} />}
				{settings.isPending && (
					<div className="space-y-3">
						<Skeleton className="h-16" />
						<Skeleton className="h-16" />
						<Skeleton className="h-16" />
					</div>
				)}
				{s && (
					<>
						<SettingsSection title="Node">
							<div className="divide-y divide-border">
								<Row label="Node name" hint="Shown to teammates and in the Agent Network." htmlFor="node-name">
									<CommitInput id="node-name" value={s.nodeName} onCommit={(v) => save({ nodeName: v }, "Node name")} />
								</Row>
								<Row label="Start automatically" hint={s.autoStartDetail ?? "Launch CL Agent Mesh when you log in to this machine."} htmlFor="autostart">
									<Switch id="autostart" checked={s.autoStart} onCheckedChange={(v) => save({ autoStart: v }, "Autostart")} />
								</Row>
							</div>
						</SettingsSection>

						<SettingsSection title="Agent runtime">
							<div className="divide-y divide-border">
								<Row label="Idle timeout" hint="Stop an idle agent process after this long. It restarts on demand and resumes its session." htmlFor="idle-timeout">
									<CommitInput
										id="idle-timeout"
										type="number"
										min={1}
										max={1440}
										suffix="minutes"
										className="w-24"
										value={s.runtimeIdleTimeoutMin}
										onCommit={num("runtimeIdleTimeoutMin", "Idle timeout")}
									/>
								</Row>
								<Row label="Max concurrent runtimes" hint="Upper bound for simultaneously running OMP processes on this node." htmlFor="max-runtimes">
									<CommitInput
										id="max-runtimes"
										type="number"
										min={1}
										max={64}
										className="w-24"
										value={s.maxConcurrentRuntimes}
										onCommit={num("maxConcurrentRuntimes", "Max runtimes")}
									/>
								</Row>
								<Row label="Tool approval mode" hint={mode?.hint} htmlFor="approval-mode">
									<Select value={s.approvalMode} onValueChange={(v) => save({ approvalMode: v as NodeSettings["approvalMode"] }, "Approval mode")}>
										<SelectTrigger id="approval-mode" className="w-full sm:w-60">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{APPROVAL_MODES.map((m) => (
												<SelectItem key={m.value} value={m.value}>
													{m.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</Row>
							</div>
							{s.approvalMode === "yolo" && (
								<p className="mt-2 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">
									Auto-approve is on: agents can run shell commands and modify files without asking.
								</p>
							)}
						</SettingsSection>
					</>
				)}
			</PageBody>
		</>
	);
}
