import { useMemo, useState } from "react";
import { FlaskConical, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { HIGHLIGHTED_MODEL_ROLES, type ModelInfo, type ModelRoles, type ModelTestResult } from "@clam/contracts";
import { T, msg, t, tr, type Msg } from "@/i18n";
import { errorText } from "@/lib/api";
import { formatNumber } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { useSetModelRole, useTestModel } from "../hooks";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ModelPickerDialog } from "./omp-models";
import { InlineError } from "./section";

const ROLE_HINT: Record<string, Msg> = {
	default: msg("Main model for new sessions"),
	smol: msg("Fast and cheap, for small tasks"),
	slow: msg("Slow, deep reasoning"),
	plan: msg("Planning mode"),
	commit: msg("Commit message generation"),
};

/** Resolve `provider/id[:thinking]` against the catalog; model ids can themselves contain colons. */
function resolve(value: string, byId: Map<string, ModelInfo>): { model: ModelInfo | null; selector: string; level: string | null } {
	const exact = byId.get(value);
	if (exact) return { model: exact, selector: value, level: null };
	const i = value.lastIndexOf(":");
	if (i > 0) {
		const base = value.slice(0, i);
		const m = byId.get(base);
		if (m) return { model: m, selector: base, level: value.slice(i + 1) };
	}
	return { model: null, selector: value, level: null };
}

function TestResult({ r }: { r: ModelTestResult }) {
	return (
		<div
			className={`mt-2 rounded-md border p-2 text-xs ${r.ok ? "border-success/30 bg-success/10" : "border-danger/30 bg-danger/10"}`}
			role="status"
		>
			<div className="flex flex-wrap items-center gap-x-3">
				<span className={r.ok ? "font-medium text-success" : "font-medium text-danger"}>{r.ok ? t("Responded") : t("Failed")}</span>
				<span className="font-mono">{formatNumber(Math.round(r.latencyMs))} ms</span>
			</div>
			{r.output && <div className="mt-1 line-clamp-3 whitespace-pre-wrap break-words font-mono text-foreground">{r.output}</div>}
			{r.error && <div className="mt-1 break-words text-danger">{r.error}</div>}
		</div>
	);
}

function RoleRow({
	role,
	value,
	byId,
	onChange,
	onClear,
}: {
	role: string;
	value: string | undefined;
	byId: Map<string, ModelInfo>;
	onChange: () => void;
	onClear: () => void;
}) {
	const test = useTestModel();
	const resolved = value ? resolve(value, byId) : null;
	const highlighted = (HIGHLIGHTED_MODEL_ROLES as readonly string[]).includes(role);
	return (
		<li className="rounded-lg border border-border bg-surface-1 p-3">
			<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="font-mono text-sm font-medium">{role}</span>
						{role === "default" && <Badge variant="accent">{t("Default")}</Badge>}
					</div>
					{ROLE_HINT[role] && <div className="text-xs text-muted-foreground">{tr(ROLE_HINT[role]!)}</div>}
					<div className="mt-1.5 min-w-0">
						{resolved ? (
							<>
								<div className="truncate text-sm">{resolved.model?.name ?? resolved.selector}</div>
								<div className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted-foreground">
									<span className="break-all">{resolved.selector}</span>
									{resolved.level && <Badge variant="outline">{t("thinking: {level}", { level: resolved.level })}</Badge>}
									{!resolved.model && <Badge variant="warning">{t("not in catalog")}</Badge>}
								</div>
							</>
						) : (
							<div className="text-sm text-muted-foreground">{highlighted ? t("Not set — OMP falls back to its default") : t("Not set")}</div>
						)}
					</div>
				</div>
				<div className="flex shrink-0 flex-wrap gap-1.5">
					{resolved && (
						<Button size="sm" variant="outline" loading={test.isPending} onClick={() => test.mutate(resolved.selector)}>
							<FlaskConical className="size-3.5" />
							{t("Test")}
						</Button>
					)}
					<Button size="sm" variant="secondary" onClick={onChange}>
						<Pencil className="size-3.5" />
						{value ? t("Change") : t("Set")}
					</Button>
					{value && role !== "default" && (
						<Button size="sm" variant="ghost" aria-label={t("Clear {role} role", { role })} onClick={onClear}>
							<X className="size-3.5" />
						</Button>
					)}
				</div>
			</div>
			{test.data && <TestResult r={test.data} />}
			{test.isError && <InlineError error={test.error} title={t("Test request failed")} />}
		</li>
	);
}

export function RolesEditor({ roles, models }: { roles: ModelRoles; models: ModelInfo[] }) {
	const set = useSetModelRole();
	const byId = useMemo(() => new Map(models.map((m) => [m.selector, m])), [models]);
	const [editing, setEditing] = useState<string | null>(null);
	const [clearing, setClearing] = useState<string | null>(null);

	const names = useMemo(() => {
		const high: string[] = [...HIGHLIGHTED_MODEL_ROLES];
		const rest = Object.keys(roles)
			.filter((r) => !high.includes(r))
			.sort();
		return { high, rest };
	}, [roles]);

	const apply = (role: string, selector: string | null, done: () => void) =>
		set.mutate(
			{ role, selector },
			{
				onSuccess: () => toast.success(selector ? t("{role} → {selector}", { role, selector }) : t("Cleared {role}", { role })),
				onError: (e) => toast.error(t("Could not update {role}", { role }), { description: errorText(e) }),
				onSettled: done,
			},
		);

	const renderRow = (role: string) => (
		<RoleRow
			key={role}
			role={role}
			value={roles[role]}
			byId={byId}
			onChange={() => setEditing(role)}
			onClear={() => setClearing(role)}
		/>
	);

	return (
		<div className="space-y-4">
			<ul className="space-y-2">{names.high.map(renderRow)}</ul>
			{names.rest.length > 0 && (
				<div>
					<div className="mb-2 text-2xs font-semibold uppercase tracking-wider text-subtle">{t("Other roles reported by OMP")}</div>
					<ul className="space-y-2">{names.rest.map(renderRow)}</ul>
				</div>
			)}
			<ModelPickerDialog
				open={editing != null}
				onOpenChange={(o) => !o && setEditing(null)}
				models={models}
				role={editing ?? ""}
				current={editing ? (roles[editing] ?? null) : null}
				busy={set.isPending}
				onPick={(selector) => editing && apply(editing, selector, () => setEditing(null))}
			/>
			<ConfirmDialog
				open={clearing != null}
				onOpenChange={(o) => !o && setClearing(null)}
				title={t("Clear the {role} role?", { role: clearing ?? "" })}
				description={<T text="Removes <code>modelRoles.{role}</code> from your OMP config." params={{ role: clearing ?? "" }} tags={{ code: <span className="font-mono" /> }} />}
				confirmLabel={t("Clear role")}
				danger
				loading={set.isPending}
				onConfirm={() => clearing && apply(clearing, null, () => setClearing(null))}
			/>
		</div>
	);
}
