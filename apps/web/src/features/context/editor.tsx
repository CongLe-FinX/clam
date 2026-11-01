import type { Context, ContextType } from "@clam/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Lock, RotateCcw, Share2, TriangleAlert } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { msg, T, t, tr } from "@/i18n";
import { errorText } from "@/lib/api";
import { lineDiff } from "@/lib/line-diff";
import { qk, useProjects } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Field } from "@/ui/field";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Switch } from "@/ui/switch";
import { CONTEXT_TYPES, contextTypeInfo } from "./format.ts";
import { isStaleVersion, type UpdateContextInput, useContextMutations } from "./hooks.ts";
import { authorLabel, DiffStat, DiffView } from "./versions.tsx";

export const SHAREABLE_OFF_COPY = msg("Private — stays on this machine only. It is never sent to other machines and never written to Git.");
export const SHAREABLE_ON_COPY = msg(
	"Shareable — synced to every member machine of this workspace and may be exported to .clmesh/ in the project's Git repository (after the secret scanner). Don't put secrets here.",
);

/** Sentinel for "no project" in the scope select (Radix Select values cannot be empty). */
export const WORKSPACE_SCOPE = "workspace";

// ───────────────────────────── shareable switch ─────────────────────────────

export function ShareableToggle({ checked, onCheckedChange, disabled, className }: { checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean; className?: string }) {
	const id = useId();
	const Icon = checked ? Share2 : Lock;
	return (
		<div className={cn("flex items-start gap-3 rounded-xl p-3 transition-colors", checked ? "bg-warning/10 shadow-[inset_0_0_0_1px_var(--warning)]" : "bg-surface-2/60 shadow-[inset_0_0_0_1px_var(--border)]", className)}>
			<Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} aria-describedby={`${id}-copy`} className="mt-0.5" />
			<div className="flex min-w-0 flex-col gap-1">
				<Label htmlFor={id} className={cn("flex items-center gap-1.5 text-[13px] font-medium", checked ? "text-warning" : "text-foreground")}>
					<Icon className="size-3.5" aria-hidden /> {checked ? t("Shareable") : t("Private")}
				</Label>
				<p id={`${id}-copy`} className="text-xs text-muted-foreground">
					{tr(checked ? SHAREABLE_ON_COPY : SHAREABLE_OFF_COPY)}
				</p>
			</div>
		</div>
	);
}

// ───────────────────────────── markdown editor ─────────────────────────────

/** Monospace textarea (auto-grows) with a Write / Preview toggle. ⌘/Ctrl+Enter calls `onSubmit`. */
export function MarkdownEditor({
	value,
	onChange,
	onSubmit,
	disabled,
	id,
	placeholder,
	"aria-label": ariaLabel,
	autoFocus,
	className,
}: {
	value: string;
	onChange: (v: string) => void;
	onSubmit?: () => void;
	disabled?: boolean;
	id?: string;
	placeholder?: string;
	"aria-label"?: string;
	autoFocus?: boolean;
	className?: string;
}) {
	const ref = useRef<HTMLTextAreaElement>(null);
	const [preview, setPreview] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on every value change
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || preview) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight + 2, Math.max(240, window.innerHeight * 0.6))}px`;
	}, [value, preview]);

	return (
		<div className={cn("flex min-w-0 flex-col gap-2", className)}>
			<div role="group" aria-label={t("Editor mode")} className="flex w-full rounded-lg bg-surface-2 p-0.5 sm:w-fit">
				{([
					{ id: "write", label: msg("Write") },
					{ id: "preview", label: msg("Preview") },
				] as const).map((m) => {
					const active = (m.id === "preview") === preview;
					return (
						<button
							key={m.id}
							type="button"
							aria-pressed={active}
							onClick={() => setPreview(m.id === "preview")}
							className={cn(
								"inline-flex h-7 flex-1 items-center justify-center rounded-md px-4 text-xs font-medium outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:h-11 sm:flex-none",
								active ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:text-foreground",
							)}
						>
							{tr(m.label)}
						</button>
					);
				})}
			</div>
			{preview ? (
				<div className="scrollbar-thin min-h-[12rem] min-w-0 overflow-y-auto rounded-lg bg-surface-1 p-4 shadow-[inset_0_0_0_1px_var(--border-strong)]" aria-label={t("Preview")}>
					{value.trim() ? <LazyMarkdown text={value} /> : <p className="text-[13px] text-subtle">{t("Nothing to preview yet.")}</p>}
				</div>
			) : (
				<textarea
					ref={ref}
					id={id}
					value={value}
					disabled={disabled}
					// biome-ignore lint/a11y/noAutofocus: opt-in by the caller (non-touch only)
					autoFocus={autoFocus}
					maxLength={200_000}
					spellCheck
					aria-label={ariaLabel ?? t("Content (Markdown)")}
					placeholder={placeholder ?? t("Write in Markdown…")}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={(e) => {
						if (onSubmit && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							onSubmit();
						}
					}}
					className="scrollbar-thin block min-h-[12rem] w-full resize-none rounded-lg bg-surface-1 px-3 py-2.5 font-mono text-[13px] leading-relaxed text-foreground shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none transition-[box-shadow,background-color] duration-150 placeholder:text-subtle hover:bg-surface-2 focus:bg-surface-1 focus:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-50"
				/>
			)}
		</div>
	);
}

// ───────────────────────────── field selects ─────────────────────────────

/** Project scope: Workspace-wide or one of the workspace's projects. Value is a project id or `WORKSPACE_SCOPE`. */
export function ScopeSelect({ workspaceId, value, onChange, disabled, id }: { workspaceId: string; value: string; onChange: (v: string) => void; disabled?: boolean; id?: string }) {
	const projects = useProjects(workspaceId);
	const list = (projects.data ?? []).filter((p) => p.workspaceId === workspaceId);
	return (
		<Select value={value} onValueChange={onChange} disabled={disabled}>
			<SelectTrigger id={id} aria-label={t("Scope")}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={WORKSPACE_SCOPE}>{t("Workspace-wide")}</SelectItem>
				{list.map((p) => (
					<SelectItem key={p.id} value={p.id}>
						{p.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export function TypeSelect({ value, onChange, disabled, id }: { value: ContextType; onChange: (v: ContextType) => void; disabled?: boolean; id?: string }) {
	return (
		<Select value={value} onValueChange={(v) => onChange(v as ContextType)} disabled={disabled}>
			<SelectTrigger id={id} aria-label={t("Type")}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{CONTEXT_TYPES.map((ty) => (
					<SelectItem key={ty.id} value={ty.id}>
						{tr(ty.label)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

// ───────────────────────────── stale-version banner ─────────────────────────────

function StaleBanner({
	base,
	latest,
	loading,
	canReapply,
	saving,
	onReapply,
	onDiscard,
	onCopy,
}: {
	base: { version: number; body: string };
	latest: Pick<Context, "version" | "body" | "author" | "updatedAt">;
	loading: boolean;
	canReapply: boolean;
	saving: boolean;
	onReapply: () => void;
	onDiscard: () => void;
	onCopy: () => void;
}) {
	const ops = useMemo(() => lineDiff(base.body, latest.body), [base.body, latest.body]);
	return (
		<div role="alert" className="flex min-w-0 flex-col gap-3 rounded-xl bg-warning/10 p-3 shadow-[inset_0_0_0_1px_var(--warning)]">
			<div className="flex items-start gap-2">
				<TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
				<div className="flex min-w-0 flex-col gap-0.5">
					<p className="text-[13px] font-medium text-warning">{loading ? t("This was edited elsewhere — loading the latest version…") : t("Edited by {name} while you were editing", { name: authorLabel(latest.author) })}</p>
					<p className="text-xs text-muted-foreground">
						{loading
							? t("Your draft is kept.")
							: t("Your edits are based on v{base}; the latest is v{latest}. Nothing was overwritten and your draft is kept. Both versions stay in History whichever you choose.", { base: base.version, latest: latest.version })}
					</p>
				</div>
			</div>
			{loading ? null : (
				<div className="flex min-w-0 flex-col gap-1.5">
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<span>
							{t("Their changes (v{base} → v{latest})", { base: base.version, latest: latest.version })}
						</span>
						<DiffStat ops={ops} />
					</div>
					<DiffView ops={ops} label={t("Remote changes since your base version")} className="max-h-60" />
				</div>
			)}
			<div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
				<Button size="sm" variant="primary" onClick={onReapply} loading={saving} disabled={!canReapply} title={t("Save your draft as a new version on top of the latest one")}>
					<RotateCcw /> {t("Reapply my edits on top")}
				</Button>
				<Button size="sm" variant="outline" onClick={onCopy}>
					<Copy /> {t("Copy my text")}
				</Button>
				<Button size="sm" variant="ghost" onClick={onDiscard} disabled={saving}>
					{t("Discard mine")}
				</Button>
			</div>
		</div>
	);
}

// ───────────────────────────── editor for an existing context ─────────────────────────────

/**
 * Edit title / body / shareable of an existing context (type and scope are immutable on update).
 * Saves with `baseVersion`; a 409 `stale_version` keeps the draft, reloads the latest and offers reapply / discard / copy.
 */
export function ContextEditor({
	context,
	onDone,
	onCancel,
	onDirtyChange,
}: {
	context: Context;
	onDone: (c: Context) => void;
	onCancel: () => void;
	onDirtyChange?: (dirty: boolean) => void;
}) {
	const qc = useQueryClient();
	const { update } = useContextMutations();
	const [base, setBase] = useState(() => ({ version: context.version, title: context.title, body: context.body, shareable: context.shareable }));
	const [title, setTitle] = useState(context.title);
	const [body, setBody] = useState(context.body);
	const [shareable, setShareable] = useState(context.shareable);
	const [staleHit, setStaleHit] = useState(false);
	const [confirmCancel, setConfirmCancel] = useState(false);
	const titleId = useId();

	const dirty = title !== base.title || body !== base.body || shareable !== base.shareable;
	const remoteChanged = context.version !== base.version;
	const canSave = title.trim().length > 0 && dirty && !update.isPending;

	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

	// Nothing typed yet and the context moved on: silently follow the latest version.
	useEffect(() => {
		if (!dirty && remoteChanged) {
			setStaleHit(false);
			setBase({ version: context.version, title: context.title, body: context.body, shareable: context.shareable });
			setTitle(context.title);
			setBody(context.body);
			setShareable(context.shareable);
		}
	}, [dirty, remoteChanged, context]);

	const save = (baseVersion: number) => {
		const patch: UpdateContextInput = { baseVersion, title: title.trim(), body, shareable };
		update.mutate(
			{ id: context.id, body: patch },
			{
				onSuccess: (c) => {
					toast.success(t("Saved as v{version}", { version: c.version }));
					onDone(c);
				},
				onError: (e) => {
					if (isStaleVersion(e)) {
						setStaleHit(true);
						void qc.invalidateQueries({ queryKey: qk.context(context.id) });
						toast.warning(t("Edited elsewhere"), { description: t("Your draft is kept. Review the changes below.") });
					} else toast.error(t("Could not save"), { description: errorText(e) });
				},
			},
		);
	};

	const copyMine = () => {
		void navigator.clipboard
			?.writeText(body)
			.then(() => toast.success(t("Copied your text")))
			.catch(() => toast.error(t("Could not copy"), { description: t("Select the text and copy it manually.") }));
	};

	const showStale = dirty && (remoteChanged || staleHit);
	const loadingLatest = showStale && !remoteChanged;
	const submit = () => {
		if (canSave && !showStale) save(base.version);
	};

	return (
		<form
			className="flex min-w-0 flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				submit();
			}}
		>
			{showStale ? (
				<StaleBanner
					base={base}
					latest={context}
					loading={loadingLatest}
					canReapply={!loadingLatest && !update.isPending && title.trim().length > 0}
					saving={update.isPending}
					onReapply={() => save(context.version)}
					onCopy={copyMine}
					onDiscard={() => onCancel()}
				/>
			) : null}
			<Field label={t("Title")} hint={t("{type} · type and scope cannot be changed after creation.", { type: tr(contextTypeInfo(context.type).label) })}>
				{() => (
					<Input
						id={titleId}
						value={title}
						maxLength={200}
						disabled={update.isPending}
						onChange={(e) => setTitle(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								submit();
							}
						}}
						aria-invalid={title.trim().length === 0}
						placeholder={t("Short, descriptive title")}
					/>
				)}
			</Field>
			<MarkdownEditor value={body} onChange={setBody} disabled={update.isPending} onSubmit={submit} />
			<ShareableToggle checked={shareable} onCheckedChange={setShareable} disabled={update.isPending} />
			<div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
				<span className="hidden text-2xs text-subtle sm:mr-auto sm:inline coarse:hidden">{t("⌘/Ctrl + Enter to save")}</span>
				<Button variant="ghost" disabled={update.isPending} onClick={() => (dirty ? setConfirmCancel(true) : onCancel())}>
					{t("Cancel")}
				</Button>
				<Button type="submit" variant="primary" loading={update.isPending} disabled={!canSave || showStale} title={showStale ? t("Resolve the edit conflict above first") : undefined}>
					{t("Save")}
				</Button>
			</div>
			<ConfirmDialog
				open={confirmCancel}
				onOpenChange={setConfirmCancel}
				title={t("Discard your changes?")}
				description={t("You have unsaved edits to this context. They will be lost.")}
				confirmLabel={t("Discard")}
				danger
				onConfirm={() => {
					setConfirmCancel(false);
					onCancel();
				}}
			/>
		</form>
	);
}
