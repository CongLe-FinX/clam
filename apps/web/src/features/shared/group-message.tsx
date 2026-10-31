import type { Participant, SharedMessage, SharedSession } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { memo, type ReactNode, useMemo } from "react";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { attachmentAssets } from "@/components/rich/assets.ts";
import { DeliveryMark } from "@/features/tasks/components";
import { KIND_META } from "@/features/tasks/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { AttachmentCards } from "./attachments.tsx";
import { clockTime, remoteSessionUrl } from "./format.ts";
import { useNodeUiUrl } from "./hooks.ts";
import { AuthorAvatar, hueStyle, MachineChip, TINT_BAR, TINT_NAME } from "./identity.tsx";
import { embeddedAttachmentIds } from "./message-files.ts";

/** Where an agent's own workspace (its session, with the tool calls) can be opened from this machine. */
export type WorkspaceTarget = { kind: "here" } | { kind: "session"; sessionId: string } | { kind: "external"; nodeId: string; nodeName: string; uiUrl: string | null; sessionId: string | null } | null;

export function workspaceOf(shared: SharedSession, nodeId: string, selfNodeId: string | undefined, currentSessionId: string): WorkspaceTarget {
	const p = shared.participants.find((x) => x.nodeId === nodeId);
	if (!p) return null;
	if (nodeId === selfNodeId) {
		const own = p.agentSessionId ?? (shared.localRole === "driver" ? shared.localSessionId : null);
		if (!own) return null;
		return own === currentSessionId ? { kind: "here" } : { kind: "session", sessionId: own };
	}
	if (nodeId === shared.driverNodeId && shared.mirrorSessionId) return shared.mirrorSessionId === currentSessionId ? { kind: "here" } : { kind: "session", sessionId: shared.mirrorSessionId };
	return { kind: "external", nodeId, nodeName: p.nodeName, uiUrl: p.uiUrl, sessionId: p.agentSessionId };
}

/** Who a message is addressed to, for the header (`null` = the default, the lead). */
export function recipients(m: SharedMessage, participants: Participant[]): string | null {
	if (m.to.mode === "all") return "everyone";
	if (m.to.mode === "agents" && m.to.agents.length > 0) {
		return m.to.agents
			.map((a) => {
				const p = participants.find((x) => x.agentId === a.agentId && x.nodeId === a.nodeId);
				if (!p) return "agent";
				const name = p.agentName ?? p.nodeName;
				// Same agent name on several machines (the default agent): the machine tells them apart.
				return participants.filter((x) => x.agentName === p.agentName).length > 1 ? `${name} (${p.nodeName})` : name;
			})
			.join(", ");
	}
	return null;
}

function ExternalLive({ target }: { target: Extract<WorkspaceTarget, { kind: "external" }> }) {
	const ui = useNodeUiUrl(target.nodeId, target.uiUrl);
	if (!ui) return null;
	return (
		<a href={remoteSessionUrl(ui, target.sessionId)} target="_blank" rel="noreferrer noopener" className={LIVE_LINK}>
			<ExternalLink className="size-3" aria-hidden /> Live view on {target.nodeName}
		</a>
	);
}

const LIVE_LINK = "inline-flex items-center gap-1 rounded text-2xs text-subtle outline-none hover:text-foreground focus-visible:text-foreground focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:py-3";

export function DayDivider({ label }: { label: string }) {
	return (
		<div role="separator" aria-label={label} className="flex items-center gap-3 pb-1 pt-2">
			<span className="h-px flex-1 bg-border" aria-hidden />
			<span className="rounded-full bg-surface-2 px-3 py-0.5 text-2xs font-medium text-muted-foreground">{label}</span>
			<span className="h-px flex-1 bg-border" aria-hidden />
		</div>
	);
}

/** Entrance of a message that arrived while the chat was open: opacity + translateY only, 160 ms. */
const ENTER = "motion-safe:animate-[clam-slide-up_160ms_var(--ease-out-quint)_both]";

/** Fences (mermaid, charts, code) and tables want the whole column; prose stays at a readable line length. */
const WIDE = /```|^\s*\|.+\|/m;

export interface GroupMessageProps {
	message: SharedMessage;
	sharedId: string;
	/** Same author within a few minutes of the previous message: header and avatar collapse. */
	grouped: boolean;
	/** Day divider above this message. */
	day: string | null;
	mine: boolean;
	lead: boolean;
	to: string | null;
	hue: number;
	target: WorkspaceTarget;
	/** Arrived live after the first paint: plays the entrance once. */
	fresh: boolean;
	onOpenWorkspace: () => void;
}

/** One line of the group timeline. Memoized on the message object: a re-render of the list never touches rows whose message is unchanged. */
export const GroupMessage = memo(function GroupMessage({ message, sharedId, grouped, day, mine, lead, to, hue, target, fresh, onOpenWorkspace }: GroupMessageProps) {
	const { author } = message;
	const text = message.text;
	const hasText = text.trim() !== "";
	const system = message.kind === "system" || author.kind === "system";
	const assets = useMemo(() => attachmentAssets(sharedId, message.attachments), [sharedId, message.attachments]);
	const inline = useMemo(() => embeddedAttachmentIds(text, message.attachments, assets), [text, message.attachments, assets]);
	const wide = useMemo(() => WIDE.test(text), [text]);
	const created = Date.parse(message.createdAt);

	return (
		<div className={cn("flex flex-col", grouped ? "pt-0.5" : "pt-4")}>
			{day ? <DayDivider label={day} /> : null}
			{system ? (
				<div data-message-id={message.id} data-author-kind="system" className={cn("flex justify-center py-1", fresh && ENTER)}>
					<p className="max-w-[92%] rounded-full bg-surface-2 px-3 py-1 text-center text-2xs leading-snug text-muted-foreground [overflow-wrap:anywhere]">{text}</p>
				</div>
			) : (
				<AuthorLine
					message={message}
					grouped={grouped}
					mine={mine}
					lead={lead}
					to={to}
					hue={hue}
					target={target}
					fresh={fresh}
					created={created}
					onOpenWorkspace={onOpenWorkspace}
					body={
						<>
							{hasText ? (
								<div
									title={grouped ? new Date(created).toLocaleString() : undefined}
									className={cn(
										"min-w-0 rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-[inset_0_0_0_1px_var(--border)]",
										wide ? "max-w-full" : "max-w-[min(100%,72ch)]",
										"relative",
										mine ? cn("bg-accent-soft", !grouped && "rounded-tr-md") : author.kind === "agent" ? cn("bg-surface-1 pl-4", TINT_BAR, !grouped && "rounded-tl-md") : cn("bg-surface-3/60", !grouped && "rounded-tl-md"),
									)}
								>
									<LazyMarkdown text={text} assets={assets} />
								</div>
							) : null}
							<AttachmentCards sharedId={sharedId} attachments={message.attachments} hidden={inline} align={mine ? "end" : "start"} />
							{mine ? <DeliveryMark state={message.delivery} /> : null}
						</>
					}
				/>
			)}
		</div>
	);
});

function AuthorLine({
	message,
	grouped,
	mine,
	lead,
	to,
	hue,
	target,
	fresh,
	created,
	onOpenWorkspace,
	body,
}: Pick<GroupMessageProps, "message" | "grouped" | "mine" | "lead" | "to" | "hue" | "target" | "fresh" | "onOpenWorkspace"> & { created: number; body: ReactNode }) {
	const { author } = message;
	const agent = author.kind === "agent";
	const name = mine ? "You" : agent ? (author.agentName ?? "agent") : "Person";
	const fullId = agent ? `${author.agentName ?? "agent"}@${author.nodeName}` : `${mine ? "You" : "Person"}@${author.nodeName}`;
	const legacy = message.kind !== "chat" && message.kind !== "reply" && message.kind !== "system" ? KIND_META[message.kind] : null;
	return (
		<div data-message-id={message.id} data-author-kind={author.kind} style={hueStyle(hue)} className={cn("group/msg flex items-start gap-2.5", mine && "flex-row-reverse", fresh && ENTER)}>
			{mine ? null : grouped ? (
				<span aria-hidden className="tabular hidden w-8 shrink-0 select-none pt-2 text-center text-[10px] leading-none text-subtle opacity-0 transition-opacity group-hover/msg:opacity-100 fine:block">
					{clockTime(created)}
				</span>
			) : (
				<AuthorAvatar name={name} hue={hue} agent={agent} />
			)}
			<div className={cn("flex min-w-0 flex-1 flex-col gap-1", mine ? "items-end" : "items-start")}>
				{grouped ? null : (
					<div className={cn("flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs", mine && "flex-row-reverse")}>
						<span className={cn("truncate text-xs font-semibold", mine ? "text-foreground" : TINT_NAME)} title={fullId}>
							{name}
						</span>
						<MachineChip name={author.nodeName} />
						{lead ? <Badge variant="accent">lead</Badge> : null}
						{legacy ? <Badge variant={legacy.variant}>{legacy.label}</Badge> : null}
						{to ? <span className="max-w-[60vw] truncate text-subtle">→ {to}</span> : null}
						<time dateTime={message.createdAt} className="tabular text-subtle" title={new Date(created).toLocaleString()}>
							{clockTime(created)}
						</time>
						{target?.kind === "here" ? (
							<button type="button" onClick={onOpenWorkspace} className={LIVE_LINK}>
								<ExternalLink className="size-3" aria-hidden /> Live view
							</button>
						) : null}
						{target?.kind === "session" ? (
							<Link to="/sessions/$sessionId" params={{ sessionId: target.sessionId }} className={LIVE_LINK}>
								<ExternalLink className="size-3" aria-hidden /> Live view
							</Link>
						) : null}
						{target?.kind === "external" ? <ExternalLive target={target} /> : null}
					</div>
				)}
				{body}
			</div>
		</div>
	);
}
