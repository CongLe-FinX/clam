import { type FileEntry, routes } from "@clam/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useSessionActions } from "@/features/projects/session-list";
import { t } from "@/i18n";
import { api } from "@/lib/api";
import { qk, useSession } from "@/lib/queries";
import { formatBytes } from "@/lib/utils";

/**
 * Confirm deleting a chat: the conversation and, unless "Keep the files" is ticked, the chat's own folder. Deleting the chat that is
 * open goes to /chats first (so the page never renders a session that is gone); the list updates optimistically and rolls back on error.
 */
export default function DeleteChatDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
	const session = useSession(sessionId).data;
	const open = (useParams({ strict: false }) as { sessionId?: string }).sessionId === sessionId;
	const navigate = useNavigate();
	const { remove } = useSessionActions();
	const [keepFiles, setKeepFiles] = useState(false);
	const projectId = session?.projectId;
	// The top level of the folder: cheap to list, enough for "N items, size".
	const folder = useQuery({
		queryKey: [...qk.project(projectId ?? ""), "chat-folder-summary"],
		queryFn: ({ signal }) => api.get<FileEntry[]>(routes.projectFiles(projectId ?? ""), { path: "" }, { signal }),
		enabled: projectId !== undefined && session?.kind !== "mirror",
		staleTime: 0,
	});
	const entries = folder.data;
	const size = entries?.reduce((sum, e) => sum + (e.size ?? 0), 0) ?? 0;
	const title = session?.title || t("Untitled chat");

	const body =
		entries && entries.length > 0
			? t("The conversation and its folder ({items}, {size}) will be permanently deleted from this machine.", {
					items: t("{count, plural, one {# item} other {# items}}", { count: entries.length }),
					size: formatBytes(size),
				})
			: t("The conversation and its folder will be permanently deleted from this machine.");

	return (
		<ConfirmDialog
			open
			onOpenChange={(o) => {
				if (!o) onClose();
			}}
			title={t("Delete “{title}”?", { title })}
			description={
				<>
					{body}
					{session?.sharedSessionId ? <> {t("This chat is shared: only this machine's copy is deleted, other members keep theirs.")}</> : null}
				</>
			}
			confirmLabel={t("Delete chat")}
			danger
			loading={!session}
			onConfirm={() => {
				if (!session) return;
				if (open) void navigate({ to: "/chats" });
				remove.mutate({ id: session.id, keepFiles, chat: true });
				onClose();
			}}
		>
			<label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg bg-surface-2 px-3 py-2.5 text-[13px]">
				<input type="checkbox" checked={keepFiles} onChange={(e) => setKeepFiles(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--accent)] coarse:size-5" />
				<span>{t("Keep the files")}</span>
			</label>
		</ConfirmDialog>
	);
}
