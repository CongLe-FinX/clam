import type { Context, ContextType } from "@clam/contracts";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { t, tr } from "@/i18n";
import { errorText } from "@/lib/api";
import { useProjects, useWorkspaces } from "@/lib/queries";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Field } from "@/ui/field";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { MarkdownEditor, ScopeSelect, ShareableToggle, TypeSelect, WORKSPACE_SCOPE } from "./editor.tsx";
import { contextTypeInfo } from "./format.ts";
import { useContextMutations } from "./hooks.ts";

/** Create-only modal for a new context (memory, plan, decision, summary or note). */
export default function ContextEditorDialog({
	workspaceId,
	projectId,
	onClose,
	onSaved,
}: {
	/** Omitted: derived from `projectId`, else chosen in the dialog. */
	workspaceId?: string;
	/** Presets the scope to this project. */
	projectId?: string;
	onClose: () => void;
	onSaved?: (c: Context) => void;
}) {
	const workspaces = useWorkspaces();
	const allProjects = useProjects();
	const { create } = useContextMutations();
	const presetWorkspace = workspaceId ?? allProjects.data?.find((p) => p.id === projectId)?.workspaceId;
	const [pickedWorkspace, setPickedWorkspace] = useState<string | null>(null);
	const wsList = workspaces.data ?? [];
	const ws = presetWorkspace ?? pickedWorkspace ?? (wsList.length === 1 ? wsList[0]?.id : undefined);
	const [scopePick, setScopePick] = useState<string | null>(null);
	const scope = scopePick ?? projectId ?? WORKSPACE_SCOPE;
	const [type, setType] = useState<ContextType>("memory");
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [shareable, setShareable] = useState(false);
	const [confirmClose, setConfirmClose] = useState(false);

	const dirty = title.trim() !== "" || body.trim() !== "" || shareable;
	const canSave = Boolean(ws) && title.trim().length > 0 && !create.isPending;
	const requestClose = () => {
		if (create.isPending) return;
		if (dirty) setConfirmClose(true);
		else onClose();
	};
	const submit = () => {
		if (!ws || !canSave) return;
		create.mutate(
			{ workspaceId: ws, projectId: scope === WORKSPACE_SCOPE ? undefined : scope, type, title: title.trim(), body, shareable },
			{
				onSuccess: (c) => {
					toast.success(t("{type} saved", { type: tr(contextTypeInfo(c.type).label) }), { description: c.shareable ? t("Shareable — it will sync to member machines.") : t("Private — it stays on this machine.") });
					onSaved?.(c);
					onClose();
				},
				onError: (e) => toast.error(t("Could not save"), { description: errorText(e) }),
			},
		);
	};

	return (
		<>
			<Dialog open onOpenChange={(o) => !o && requestClose()}>
				<DialogContent sheetOnMobile className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>{t("New context")}</DialogTitle>
						<DialogDescription>{t("Durable knowledge for this workspace that you, your teammates and their agents can build on.")}</DialogDescription>
					</DialogHeader>
					<form
						className="flex min-h-0 flex-1 flex-col gap-4"
						onSubmit={(e) => {
							e.preventDefault();
							submit();
						}}
					>
						<div className="scrollbar-thin -mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pb-1">
							{presetWorkspace ? null : (
								<Field label={t("Workspace")} hint={wsList.length === 0 && !workspaces.isPending ? t("Create a workspace first.") : undefined}>
									{(id) => (
										<Select value={ws ?? ""} onValueChange={(v) => { setPickedWorkspace(v);
											setScopePick(WORKSPACE_SCOPE); }} disabled={create.isPending || workspaces.isPending}>
											<SelectTrigger id={id} aria-label={t("Workspace")}>
												<SelectValue placeholder={workspaces.isPending ? t("Loading…") : t("Choose a workspace")} />
											</SelectTrigger>
											<SelectContent>
												{wsList.map((w) => (
													<SelectItem key={w.id} value={w.id}>
														{w.name}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									)}
								</Field>
							)}
							<div className="grid gap-4 sm:grid-cols-2">
								<Field label={t("Type")} hint={tr(contextTypeInfo(type).hint)}>
									{(id) => <TypeSelect id={id} value={type} onChange={setType} disabled={create.isPending} />}
								</Field>
								<Field label={t("Scope")} hint={t("Workspace-wide, or tied to one project.")}>
									{(id) => (ws ? <ScopeSelect id={id} workspaceId={ws} value={scope} onChange={setScopePick} disabled={create.isPending} /> : <Input id={id} disabled value={t("Choose a workspace first")} readOnly />)}
								</Field>
							</div>
							<Field label={t("Title")}>
								{(id) => (
									<Input
										id={id}
										value={title}
										maxLength={200}
										onChange={(e) => setTitle(e.target.value)}
										disabled={create.isPending}
										placeholder={t("Short, descriptive title")}
										// biome-ignore lint/a11y/noAutofocus: modal opened for typing
										autoFocus
									/>
								)}
							</Field>
							<MarkdownEditor value={body} onChange={setBody} onSubmit={submit} disabled={create.isPending} />
							<ShareableToggle checked={shareable} onCheckedChange={setShareable} disabled={create.isPending} />
						</div>
						<DialogFooter>
							<Button variant="ghost" onClick={requestClose} disabled={create.isPending}>
								{t("Cancel")}
							</Button>
							<Button type="submit" variant="primary" loading={create.isPending} disabled={!canSave}>
								{t("Save")}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			<ConfirmDialog
				open={confirmClose}
				onOpenChange={setConfirmClose}
				title={t("Discard this draft?")}
				description={t("Nothing has been saved yet. Your text will be lost.")}
				confirmLabel={t("Discard")}
				danger
				onConfirm={() => {
					setConfirmClose(false);
					onClose();
				}}
			/>
		</>
	);
}
