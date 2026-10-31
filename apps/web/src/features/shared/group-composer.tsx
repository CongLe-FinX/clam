import { type MentionCandidate, mentionTokens, parseMentions, type Participant, type SharedSession, type SharedSessionDetail } from "@clam/contracts";
import { AtSign, Bot, CornerDownRight, Send, Users } from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { filesFromClipboard } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Textarea } from "@/ui/textarea";
import { AttachButton, AttachmentTray, type AttachmentUploads } from "./attachments.tsx";
import { driverOf, participantLabel, teamOf } from "./format.ts";
import { MachineChip } from "./identity.tsx";
import { usePostSharedMessage } from "./hooks.ts";

const coarsePointer = typeof matchMedia === "function" ? matchMedia("(pointer: coarse)") : null;
const MAX_ROWS = 8;

interface MentionOption {
	key: string;
	insert: string;
	label: string;
	hint: string;
	/** What the query is matched against, besides the label. */
	search: string;
	kind: "all" | "agent" | "node";
}

/** A member whose agent can be addressed (the same members the server resolves @mentions against). */
type Addressable = Participant & { agentId: string; agentName: string };

function addressable(shared: SharedSession): Addressable[] {
	return shared.participants.filter((p): p is Addressable => p.state === "active" && Boolean(p.agentId) && Boolean(p.agentName));
}

function mentionOptions(shared: SharedSession, members: Addressable[], candidates: MentionCandidate[]): MentionOption[] {
	const out: MentionOption[] = [{ key: "all", insert: "@all", label: "@all", hint: "every agent in the group", search: "all everyone", kind: "all" }];
	for (const p of members) {
		// Every token is checked against the parser: two agents named "OMP Agent" are told apart by their machine.
		const tokens = mentionTokens(p, candidates);
		const search = `${p.agentName} ${p.nodeName}`;
		out.push({ key: `a:${p.nodeId}`, insert: tokens.agent, label: tokens.agent, hint: `${p.agentName} on ${p.nodeName}${p.nodeId === shared.driverNodeId ? " · lead" : ""}`, search, kind: "agent" });
		if (tokens.machine !== tokens.agent) out.push({ key: `n:${p.nodeId}`, insert: tokens.machine, label: tokens.machine, hint: `the agent on this machine (${p.agentName})`, search, kind: "node" });
	}
	return out;
}

const widePhone = typeof matchMedia === "function" ? matchMedia("(min-width: 640px)") : null;
const subscribeWide = (cb: () => void) => {
	widePhone?.addEventListener("change", cb);
	return () => widePhone?.removeEventListener("change", cb);
};

/** Who the message goes to: the agents the text mentions, `@all`, or (without a mention) the lead. Opens on tap/click/Enter (a hover-only tooltip would not work on a phone). */
function RecipientChip({ lead, everyone, mentioned }: { lead: Participant | undefined; everyone: boolean; mentioned: Participant[] }) {
	const explicit = everyone || mentioned.length > 0;
	const names = mentioned.map(participantLabel).join(", ");
	const label = everyone ? "Everyone in the group" : mentioned.length > 0 ? names : lead ? `${participantLabel(lead)}, the lead agent` : "";
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					title={explicit ? "Who this message is addressed to" : "Messages without an @mention go to the lead agent"}
					aria-label={explicit ? `This message is addressed to ${label}` : `Messages without an @mention go to ${label}`}
					data-testid="recipient-chip"
					className="inline-flex min-h-7 max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 rounded-full bg-surface-2 px-2.5 py-0.5 text-2xs text-muted-foreground outline-none hover:bg-surface-3 focus-visible:shadow-[0_0_0_2px_var(--accent)] coarse:min-h-11"
				>
					{everyone ? <Users className="size-3 shrink-0" aria-hidden /> : <CornerDownRight className="size-3 shrink-0" aria-hidden />}
					{everyone ? (
						<span className="font-medium text-foreground">Everyone</span>
					) : (
						(explicit ? mentioned : lead ? [lead] : []).map((p) => (
							<span key={p.nodeId} className="inline-flex min-w-0 items-center gap-1">
								<span className="truncate font-medium text-foreground">{p.agentName}</span>
								<MachineChip name={p.nodeName} className="bg-surface-3" />
							</span>
						))
					)}
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-72">
				<p className="text-xs text-muted-foreground">
					{everyone ? (
						<span className="font-medium text-foreground">Goes to every agent in the group.</span>
					) : explicit ? (
						<span className="font-medium text-foreground">Goes to {names}.</span>
					) : (
						<span className="font-medium text-foreground">Goes to {lead ? lead.agentName : "the lead agent"}, the lead agent.</span>
					)}{" "}
					Write @name to address another agent, or @all to wake every agent in the group. Everyone in the group sees every message either way.
				</p>
			</PopoverContent>
		</Popover>
	);
}

export function GroupComposer({
	detail,
	uploads,
	keyboardOpen,
	fill,
	className,
}: {
	detail: SharedSessionDetail;
	uploads: AttachmentUploads;
	keyboardOpen?: boolean;
	/** Puts text into the box (an example prompt) and focuses it; a new `nonce` re-applies the same text. */
	fill?: { text: string; nonce: number } | null;
	className?: string;
}) {
	const { shared } = detail;
	const post = usePostSharedMessage(shared.id);
	const [text, setText] = useState("");
	const members = useMemo(() => addressable(shared), [shared]);
	const candidates = useMemo<MentionCandidate[]>(() => members.map((p) => ({ nodeId: p.nodeId, nodeName: p.nodeName, agentId: p.agentId, agentName: p.agentName })), [members]);
	// Exactly who the server will address for this text (it parses the same way): the chip shows it, send passes it as `to`.
	const mentions = useMemo(() => parseMentions(text, candidates), [text, candidates]);
	const mentioned = useMemo(() => mentions.agents.flatMap((t) => members.find((p) => p.nodeId === t.nodeId) ?? []), [mentions, members]);
	const [menu, setMenu] = useState<{ start: number; query: string } | null>(null);
	const [active, setActive] = useState(0);
	const ref = useRef<HTMLTextAreaElement>(null);
	const options = useMemo(() => mentionOptions(shared, members, candidates), [shared, members, candidates]);
	const lead = driverOf(shared);
	const me = shared.participants.find((p) => p.nodeStatus === "self");
	const out = me !== undefined && (me.state === "left" || me.state === "removed" || me.state === "declined");
	const touch = coarsePointer?.matches ?? false;
	const wide = useSyncExternalStore(subscribeWide, () => widePhone?.matches ?? true, () => true);

	const matches = useMemo(() => {
		if (!menu) return [];
		const q = menu.query.toLowerCase();
		return options.filter((o) => `${o.label.slice(1)} ${o.search}`.toLowerCase().includes(q));
	}, [menu, options]);
	useEffect(() => setActive(0), [menu?.query]);

	// One row to MAX_ROWS rows, never taller than a third of the visible viewport (the keyboard shrinks it).
	// biome-ignore lint/correctness/useExhaustiveDependencies: text is the trigger, the height is read from the element
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto";
		const cs = getComputedStyle(el);
		const line = Number.parseFloat(cs.lineHeight) || 22;
		const chrome = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
		const max = Math.min(line * MAX_ROWS + chrome, (window.visualViewport?.height ?? window.innerHeight) / 3);
		el.style.height = `${Math.min(el.scrollHeight, max)}px`;
		el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
	}, [text]);

	useEffect(() => {
		if (!fill) return;
		setText(fill.text);
		setMenu(null);
		requestAnimationFrame(() => {
			const el = ref.current;
			el?.focus();
			el?.setSelectionRange(fill.text.length, fill.text.length);
		});
	}, [fill]);

	const refreshMenu = (value: string, caret: number) => {
		const m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
		setMenu(m ? { start: caret - (m[2]?.length ?? 0) - 1, query: m[2] ?? "" } : null);
	};
	const choose = (o: MentionOption) => {
		if (!menu) return;
		const el = ref.current;
		const caret = el?.selectionStart ?? text.length;
		const next = `${text.slice(0, menu.start)}${o.insert} ${text.slice(caret)}`;
		setText(next);
		setMenu(null);
		requestAnimationFrame(() => {
			const pos = menu.start + o.insert.length + 1;
			el?.focus();
			el?.setSelectionRange(pos, pos);
		});
	};

	const send = () => {
		const body = text.trim();
		const attachmentIds = uploads.ready.map((a) => a.id);
		if ((!body && attachmentIds.length === 0) || uploads.busy || post.isPending || out) return;
		const to = mentions.all ? { mode: "all" as const, agents: [] } : mentions.agents.length > 0 ? { mode: "agents" as const, agents: mentions.agents } : undefined;
		post.mutate(
			{ text: body, kind: "chat", to, attachmentIds },
			{
				onSuccess: () => {
					uploads.clear();
					setText("");
					setMenu(null);
				},
			},
		);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (menu && matches.length > 0) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				setActive((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const o = matches[active];
				if (o) choose(o);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setMenu(null);
				return;
			}
		}
		if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
		if (e.metaKey || e.ctrlKey || (!e.shiftKey && !touch)) {
			e.preventDefault();
			send();
		}
	};

	if (out) return <div className={cn("shrink-0 border-t px-4 py-3 pb-safe text-center text-xs text-subtle", className)}>You are no longer part of this group; the chat is read-only.</div>;
	return (
		<div className={cn("relative shrink-0 border-t bg-surface-1 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-2.5", keyboardOpen ? "pb-2" : "pb-[max(0.75rem,env(safe-area-inset-bottom))]", className)}>
			<div className="mx-auto w-full max-w-3xl">
				{menu && matches.length > 0 ? (
					<ul role="listbox" aria-label="Mention" className="clam-pop absolute inset-x-3 bottom-full z-10 mb-1 mx-auto flex max-h-56 max-w-3xl flex-col overflow-y-auto rounded-xl bg-overlay p-1 shadow-pop shadow-[inset_0_0_0_1px_var(--border-strong)]">
						{matches.map((o, i) => (
							<li key={o.key} role="option" aria-selected={i === active}>
								<button
									type="button"
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => choose(o)}
									className={cn("flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] outline-none coarse:min-h-11", i === active ? "bg-surface-3" : "hover:bg-surface-2")}
								>
									{o.kind === "all" ? <Users className="size-3.5 shrink-0 text-subtle" aria-hidden /> : o.kind === "agent" ? <Bot className="size-3.5 shrink-0 text-accent" aria-hidden /> : <AtSign className="size-3.5 shrink-0 text-subtle" aria-hidden />}
									<span className="font-medium">{o.label}</span>
									<span className="min-w-0 flex-1 truncate text-2xs text-subtle">{o.hint}</span>
								</button>
							</li>
						))}
					</ul>
				) : null}
				{lead?.agentName || mentions.all || mentioned.length > 0 ? (
					<div className="mb-1.5 flex items-center [@media(max-height:520px)]:hidden">
						<RecipientChip lead={lead} everyone={mentions.all} mentioned={mentioned} />
					</div>
				) : null}
				<AttachmentTray uploads={uploads} />
				<div className="flex items-end gap-2">
					<AttachButton onFiles={uploads.add} />
					<Textarea
						ref={ref}
						value={text}
						onChange={(e) => {
							setText(e.target.value);
							refreshMenu(e.target.value, e.target.selectionStart);
						}}
						onKeyDown={onKeyDown}
						onPaste={(e) => {
							const files = filesFromClipboard(e);
							if (files.length === 0) return;
							e.preventDefault();
							uploads.add(files);
						}}
						onClick={(e) => refreshMenu(e.currentTarget.value, e.currentTarget.selectionStart)}
						rows={1}
						maxLength={20_000}
						aria-label="Message to the group"
						placeholder={wide ? "Message the group · @mention to pick an agent" : "Message the group…"}
						enterKeyHint={touch ? "enter" : "send"}
						// 16px on touch screens: smaller text makes iOS zoom the page when the box is focused.
						className="scrollbar-thin min-h-11 flex-1 resize-none overflow-hidden py-2.5 coarse:text-base"
					/>
					<Button variant="primary" size="lg" onClick={send} loading={post.isPending} disabled={(!text.trim() && uploads.ready.length === 0) || uploads.busy} aria-label="Send message" className="shrink-0 px-3.5 coarse:min-h-12 coarse:min-w-12">
						<Send />
					</Button>
				</div>
				{touch ? null : <p className="mt-1.5 hidden text-2xs text-subtle fine:block [@media(max-height:520px)]:hidden">Type @ to address an agent, a machine or everyone · drop, paste or attach files · Enter sends · Shift+Enter for a new line</p>}
			</div>
		</div>
	);
}
