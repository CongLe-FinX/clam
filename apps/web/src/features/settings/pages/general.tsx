import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { NodeSettings } from "@clam/contracts";
import { msg, renderServerText, t, tr, type Msg } from "@/i18n";
import { errorText } from "@/lib/api";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Skeleton } from "@/ui/skeleton";
import { Switch } from "@/ui/switch";
import { HandoffSettingsSection } from "@/features/handoff/settings-section";
import { InlineError, PageBody, PageIntro, SettingsSection } from "../components/section";
import { LanguagePicker } from "../components/language-picker";
import { ThemePicker } from "../components/theme-picker";
import { usePatchSettings, useSettings } from "../hooks";

const APPROVAL_MODES: { value: NodeSettings["approvalMode"]; label: Msg; hint: Msg }[] = [
	{ value: "always-ask", label: msg("Always ask"), hint: msg("Every tool call needs your approval.") },
	{ value: "always-ask-cached", label: msg("Always ask (remember)"), hint: msg("Ask once per identical tool call, then remember it for the session.") },
	{ value: "write", label: msg("Ask for writes"), hint: msg("Read-only tools run freely; file writes and commands need approval.") },
	{ value: "yolo", label: msg("Auto-approve everything"), hint: msg("Agents run every tool without asking. Use only in disposable environments.") },
];

type SettingField = "nodeName" | "autoStart" | "idle" | "maxRuntimes" | "approval";

/** Toast texts per setting; spelled out so every sentence is one catalog key. */
function fieldLabels(field: SettingField) {
	switch (field) {
		case "nodeName":
			return { updated: t("Machine name updated"), failed: t("Could not save machine name"), whole: "" };
		case "autoStart":
			return { updated: t("Autostart updated"), failed: t("Could not save autostart"), whole: "" };
		case "idle":
			return { updated: t("Idle timeout updated"), failed: t("Could not save idle timeout"), whole: t("Idle timeout must be a whole number") };
		case "maxRuntimes":
			return { updated: t("Max runtimes updated"), failed: t("Could not save max runtimes"), whole: t("Max runtimes must be a whole number") };
		case "approval":
			return { updated: t("Approval mode updated"), failed: t("Could not save approval mode"), whole: "" };
	}
}

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

	const save = (p: Partial<NodeSettings>, field: SettingField) =>
		patch.mutate(p, {
			onSuccess: () => toast.success(fieldLabels(field).updated),
			onError: (e) => toast.error(fieldLabels(field).failed, { description: errorText(e) }),
		});
	const num = (key: "runtimeIdleTimeoutMin" | "maxConcurrentRuntimes", field: SettingField) => (v: string) => {
		const n = Number(v);
		if (!Number.isInteger(n)) return toast.error(fieldLabels(field).whole);
		save({ [key]: n }, field);
	};

	const s = settings.data;
	const mode = APPROVAL_MODES.find((m) => m.value === s?.approvalMode);

	return (
		<>
			<PageIntro title={t("General")} description={t("Settings for this machine. Changes apply immediately; running agent processes pick up approval mode on their next start.")} />
			<PageBody>
				<SettingsSection title={t("Appearance")} description={t("Theme and language are saved in this browser, so your phone and your desktop can differ.")}>
					<div className="space-y-5">
						<div>
							<h3 className="mb-2 text-xs font-medium text-muted-foreground">{t("Theme")}</h3>
							<ThemePicker />
						</div>
						<div>
							<h3 className="mb-2 text-xs font-medium text-muted-foreground">{t("Language")}</h3>
							<LanguagePicker />
						</div>
					</div>
				</SettingsSection>
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
						<SettingsSection title={t("Machine")}>
							<div className="divide-y divide-border">
								<Row label={t("Machine name")} hint={t("Shown to teammates and in the Agent Network.")} htmlFor="node-name">
									<CommitInput id="node-name" value={s.nodeName} onCommit={(v) => save({ nodeName: v }, "nodeName")} />
								</Row>
								<Row label={t("Start automatically")} hint={s.autoStartDetail !== undefined ? renderServerText(s.autoStartDetail, s.autoStartI18n) : t("Launch CL Agent Mesh when you log in to this machine.")} htmlFor="autostart">
									<Switch id="autostart" checked={s.autoStart} onCheckedChange={(v) => save({ autoStart: v }, "autoStart")} />
								</Row>
							</div>
						</SettingsSection>

						<SettingsSection title={t("Agent runtime")}>
							<div className="divide-y divide-border">
								<Row label={t("Idle timeout")} hint={t("Stop an idle agent process after this long. It restarts on demand and resumes its session.")} htmlFor="idle-timeout">
									<CommitInput
										id="idle-timeout"
										type="number"
										min={1}
										max={1440}
										suffix={t("minutes")}
										className="w-24"
										value={s.runtimeIdleTimeoutMin}
										onCommit={num("runtimeIdleTimeoutMin", "idle")}
									/>
								</Row>
								<Row label={t("Max concurrent runtimes")} hint={t("Upper bound for simultaneously running OMP processes on this machine.")} htmlFor="max-runtimes">
									<CommitInput
										id="max-runtimes"
										type="number"
										min={1}
										max={64}
										className="w-24"
										value={s.maxConcurrentRuntimes}
										onCommit={num("maxConcurrentRuntimes", "maxRuntimes")}
									/>
								</Row>
								<Row label={t("Tool approval mode")} hint={mode ? tr(mode.hint) : undefined} htmlFor="approval-mode">
									<Select value={s.approvalMode} onValueChange={(v) => save({ approvalMode: v as NodeSettings["approvalMode"] }, "approval")}>
										<SelectTrigger id="approval-mode" className="w-full sm:w-60">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{APPROVAL_MODES.map((m) => (
												<SelectItem key={m.value} value={m.value}>
													{tr(m.label)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</Row>
							</div>
							{s.approvalMode === "yolo" && (
								<p className="mt-2 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">
									{t("Auto-approve is on: agents can run shell commands and modify files without asking.")}
								</p>
							)}
						</SettingsSection>
						<HandoffSettingsSection settings={s} />
					</>
				)}
			</PageBody>
		</>
	);
}
