import type { NodeSettings, NodeSettingsPatch } from "@clam/contracts";
import { toast } from "sonner";
import { SettingsSection } from "@/features/settings/components/section";
import { usePatchSettings } from "@/features/settings/hooks";
import { errorMessage } from "@/lib/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Switch } from "@/ui/switch";

type DependencySetup = NodeSettings["dependencySetup"];

const SETUP_MODES: ReadonlyArray<{ value: DependencySetup; label: string; hint: string }> = [
	{ value: "ask", label: "Ask me", hint: "Every install or setup command from a handoff waits for your approval. Recommended." },
	{ value: "auto", label: "Run automatically", hint: "Install and setup commands run without asking. Only for machines whose peers you fully trust." },
	{ value: "skip", label: "Never run", hint: "Handoffs are restored without installing anything; you set up dependencies yourself." },
];

function Row({ label, hint, children, htmlFor }: { label: string; hint: string; children: React.ReactNode; htmlFor: string }) {
	return (
		<div className="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
			<div className="min-w-0">
				<label htmlFor={htmlFor} className="text-sm font-medium">
					{label}
				</label>
				<p className="mt-0.5 max-w-md text-xs text-muted-foreground">{hint}</p>
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

export function HandoffSettingsSection({ settings: s }: { settings: NodeSettings }) {
	const patchSettings = usePatchSettings();
	const patch = {
		mutate: (p: NodeSettingsPatch) =>
			patchSettings.mutate(p, { onError: (e) => toast.error("Could not save handoff settings", { description: errorMessage(e) }) }),
	};
	const mode = SETUP_MODES.find((m) => m.value === s.dependencySetup);

	return (
		<SettingsSection title="Handoffs" description="What this machine does when another machine hands a task over to it.">
			<div className="divide-y divide-border">
				<Row label="Dependency setup" hint={mode?.hint ?? ""} htmlFor="handoff-setup">
					<Select value={s.dependencySetup} onValueChange={(v) => patch.mutate({ dependencySetup: v as DependencySetup })}>
						<SelectTrigger id="handoff-setup" className="w-full sm:w-52">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{SETUP_MODES.map((m) => (
								<SelectItem key={m.value} value={m.value}>
									{m.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Row>
				<Row label="Accept handoffs automatically" hint="Start restoring as soon as a paired machine offers a handoff, without asking first. Setup commands still follow the policy above." htmlFor="handoff-auto-accept">
					<Switch id="handoff-auto-accept" checked={s.autoAcceptHandoffs} onCheckedChange={(v) => patch.mutate({ autoAcceptHandoffs: v })} />
				</Row>
			</div>
			{s.dependencySetup === "auto" && (
				<p className="mt-2 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">Automatic setup runs commands written by another machine on this machine. Use it only with peers you trust.</p>
			)}
		</SettingsSection>
	);
}
