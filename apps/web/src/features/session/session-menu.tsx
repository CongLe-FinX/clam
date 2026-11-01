import { Link } from "@tanstack/react-router";
import { ArrowRightLeft, MoreHorizontal, PanelBottom, PanelRight, Terminal, UserPlus, Users } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/ui/sheet";

const item =
	"flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] text-foreground outline-none transition-colors active:bg-surface-3 focus-visible:bg-surface-2 [&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

/** Dragging the grab zone this far (px) dismisses the sheet. */
const DISMISS_PX = 72;

/**
 * Phone header menu: everything the header has no room for (context, team, runtime log, add agent, hand over, terminal) in a bottom
 * sheet with a grab handle. Pull the handle down to dismiss. Actions run after the sheet has closed so a follow-up sheet or dialog
 * does not fight it for focus.
 */
export function SessionMenu({
	projectId,
	canAdd,
	readOnly,
	teamUnread,
	approvals,
	onAddAgent,
	onHandover,
	onOpenTeam,
	onToggleLog,
	onToggleRight,
}: {
	projectId: string;
	canAdd: boolean;
	readOnly: boolean;
	teamUnread: number;
	approvals: number;
	onAddAgent: () => void;
	onHandover: () => void;
	onOpenTeam: () => void;
	onToggleLog: () => void;
	onToggleRight: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [dy, setDy] = useState(0);
	const dragFrom = useRef<number | null>(null);
	const pending = useRef<(() => void) | null>(null);

	const run = (fn: () => void) => () => {
		pending.current = fn;
		setOpen(false);
	};

	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetTrigger asChild>
				<button
					type="button"
					aria-label={approvals > 0 ? t("More actions, {count, plural, one {# approval} other {# approvals}} waiting", { count: approvals }) : t("More actions")}
					className="relative grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:bg-surface-2 aria-expanded:bg-surface-3 [&_svg]:size-5"
				>
					<MoreHorizontal />
					{approvals > 0 || teamUnread > 0 ? <span aria-hidden className={cn("absolute right-2 top-2 size-2 rounded-full", approvals > 0 ? "bg-warning" : "bg-accent")} /> : null}
				</button>
			</SheetTrigger>
			<SheetContent
				side="bottom"
				aria-describedby={undefined}
				className={cn("px-2 pb-3", dragFrom.current === null && "transition-[translate] duration-200")}
				style={{ translate: dy ? `0 ${dy}px` : undefined }}
				onCloseAutoFocus={(e) => {
					const fn = pending.current;
					pending.current = null;
					if (!fn) return;
					e.preventDefault();
					fn();
				}}
			>
				{/* Swipe-to-dismiss zone: pointer events with touch-action none so the page does not scroll under the drag. */}
				<div
					aria-hidden
					className="-mt-1 h-7 w-full shrink-0 touch-none"
					onPointerDown={(e) => {
						dragFrom.current = e.clientY;
						e.currentTarget.setPointerCapture(e.pointerId);
					}}
					onPointerMove={(e) => {
						if (dragFrom.current !== null) setDy(Math.max(0, e.clientY - dragFrom.current));
					}}
					onPointerUp={() => {
						const far = dy > DISMISS_PX;
						dragFrom.current = null;
						setDy(0);
						if (far) setOpen(false);
					}}
					onPointerCancel={() => {
						dragFrom.current = null;
						setDy(0);
					}}
				/>
				<SheetTitle className="sr-only">{t("Session actions")}</SheetTitle>
				<SheetDescription className="sr-only">{t("Panels and actions for this session.")}</SheetDescription>
				<nav aria-label={t("Session actions")} className="flex flex-col gap-0.5">
					<Row icon={<PanelRight />} label={t("Context")} onClick={run(onToggleRight)} />
					<Row
						icon={<Users />}
						label={t("Team")}
						onClick={run(onOpenTeam)}
						badge={teamUnread > 0 ? <span className="tabular grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 font-mono text-2xs font-semibold text-accent-foreground">{teamUnread}</span> : null}
					/>
					<Row icon={<PanelBottom />} label={t("Runtime log")} onClick={run(onToggleLog)} />
					{canAdd ? <Row icon={<UserPlus />} label={t("Add agent")} onClick={run(onAddAgent)} /> : null}
					{canAdd ? <Row icon={<ArrowRightLeft />} label={t("Hand over…")} onClick={run(onHandover)} /> : null}
					{readOnly ? null : (
						<Link to="/terminal" search={{ project: projectId }} onClick={() => setOpen(false)} className={item}>
							<Terminal />
							<span className="flex-1">{t("Open terminal here")}</span>
						</Link>
					)}
				</nav>
			</SheetContent>
		</Sheet>
	);
}

function Row({ icon, label, onClick, badge }: { icon: ReactNode; label: string; onClick: () => void; badge?: ReactNode }) {
	return (
		<button type="button" onClick={onClick} className={item}>
			{icon}
			<span className="flex-1">{label}</span>
			{badge}
		</button>
	);
}
