import type { AgentSession } from "@clam/contracts";
import { MoreHorizontal } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";

// The Radix menu stack is far heavier than the shell: it loads on first use, never in the initial chunk.
export const ChatContextMenu = lazy(() => import("./chat-menus.tsx"));

/** Classes that show a row's "⋯" button on hover/focus of its `group/row` on desktop, always on touch, and while its menu is open. */
export const ROW_MENU_REVEAL =
	"opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 coarse:opacity-100";

/** The "⋯" button of a chat row (Chats page, sidebar): Delete. Place it inside a `group/row`. */
export function ChatRowMenu({ session, className }: { session: Pick<AgentSession, "id" | "title">; className?: string }) {
	const ref = useRef<HTMLButtonElement>(null);
	const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
	return (
		<>
			<Button
				ref={ref}
				variant="ghost"
				size="icon-sm"
				aria-label={t("Actions for {title}", { title: session.title || t("chat") })}
				aria-haspopup="menu"
				aria-expanded={point !== null}
				data-state={point ? "open" : "closed"}
				onClick={() => {
					const r = ref.current?.getBoundingClientRect();
					if (r) setPoint({ x: r.left, y: r.bottom });
				}}
				className={cn("shrink-0", ROW_MENU_REVEAL, className)}
			>
				<MoreHorizontal />
			</Button>
			{point ? (
				<Suspense fallback={null}>
					<ChatContextMenu session={session} point={point} onClose={() => setPoint(null)} />
				</Suspense>
			) : null}
		</>
	);
}
