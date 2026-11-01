import type { AgentSession } from "@clam/contracts";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { t } from "@/i18n";
import { useUi } from "@/lib/store";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";

function DeleteChatItem({ session }: { session: Pick<AgentSession, "id"> }) {
	const openDialog = useUi((s) => s.openDialog);
	return (
		<DropdownMenuItem danger onSelect={() => openDialog({ kind: "delete-chat", sessionId: session.id })}>
			<Trash2 /> {t("Delete chat…")}
		</DropdownMenuItem>
	);
}

/** The right-click menu of a chat row: the same actions, opened at the pointer. Mount it while `point` is set. */
export default function ChatContextMenu({ session, point, onClose }: { session: Pick<AgentSession, "id">; point: { x: number; y: number }; onClose: () => void }) {
	return (
		<DropdownMenu
			open
			onOpenChange={(o) => {
				if (!o) onClose();
			}}
		>
			<DropdownMenuTrigger asChild>
				<span aria-hidden className="pointer-events-none fixed size-0" style={{ left: point.x, top: point.y }} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" sideOffset={2}>
				<DeleteChatItem session={session} />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** The "⋯" menu of an open chat's header (desktop). */
export function ChatHeaderMenu({ sessionId }: { sessionId: string }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label={t("Chat actions")}
					className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:bg-surface-2 aria-expanded:bg-surface-3 aria-expanded:text-foreground coarse:size-11 [&_svg]:size-4"
				>
					<MoreHorizontal />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent>
				<DeleteChatItem session={{ id: sessionId }} />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
