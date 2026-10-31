import type { TaskStatus } from "@clam/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Bot, ChevronRight, Network, User } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/ui/badge";
import { TaskStatusPill } from "./components.tsx";
import { KIND_META } from "./format.ts";

export interface MeshMessage {
	/** What the message belongs to: a delegated task or a shared session. */
	scope: "task" | "shared";
	/** Task id or shared session id. */
	refId: string;
	title: string;
	/** `agent@node` / `human@node` for discussion messages. */
	author?: string;
	kind?: keyof typeof KIND_META;
	/** Set for task status notes (completion / failure of a delegated task). */
	status?: TaskStatus;
	/** Shared sessions: the driver changed (takeover / transfer); the epoch it now is. */
	driverChanged?: number;
	/** The first prompt of an executing / joining session: the full brief CL Agent Mesh composed for it. */
	brief?: boolean;
	body: string;
	reminder?: string;
}

// `[CL Agent Mesh] task <id> · "<title>" · from <agent>@<node> · kind <kind>`  |  `… · status <status>`
// `[CL Agent Mesh] shared session <id> · "<title>" · from <agent>@<node> · kind <kind>`  |  `… · driver changed (epoch <n>)`
const HEADER = /^\[CL Agent Mesh\] (task|shared session) (\S+) · "(.*)" · (?:from (.+?) · kind (\w+)|status (\w+)|driver changed \(epoch (\d+)\))\s*$/;

/** Parses the prompt CL Agent Mesh injects into a session (header, text, one-line reminder). null for ordinary user prompts. */
export function parseMeshMessage(text: string): MeshMessage | null {
	if (text.startsWith("# Delegated task: ")) {
		const id = /^Task id: (\S+)$/m.exec(text)?.[1];
		const by = /^Delegated by: (.+)$/m.exec(text)?.[1];
		if (!id) return null;
		return { scope: "task", refId: id, title: text.slice(18, text.indexOf("\n")).trim(), author: by, body: text, brief: true };
	}
	if (text.startsWith("# Shared session: ")) {
		const id = /^Shared session id: (\S+)$/m.exec(text)?.[1];
		const driver = /^Driver: (.+?) \(/m.exec(text)?.[1];
		if (!id) return null;
		return { scope: "shared", refId: id, title: text.slice(18, text.indexOf("\n")).trim(), author: driver, body: text, brief: true };
	}
	if (!text.startsWith("[CL Agent Mesh]")) return null;
	const nl = text.indexOf("\n");
	const m = HEADER.exec(nl < 0 ? text : text.slice(0, nl));
	if (!m) return null;
	const rest = (nl < 0 ? "" : text.slice(nl + 1)).trim();
	const paragraphs = rest.split(/\n\s*\n/);
	const status = m[6] as TaskStatus | undefined;
	const driverChanged = m[7] ? Number(m[7]) : undefined;
	// Discussion messages end with a one-line reminder on how to reply; status notes and continuation notes are all content.
	const last = paragraphs[paragraphs.length - 1] ?? "";
	const reminder = !status && driverChanged === undefined && paragraphs.length > 1 && !last.includes("\n") ? last : undefined;
	return {
		scope: m[1] === "task" ? "task" : "shared",
		refId: m[2] ?? "",
		title: m[3] ?? "",
		author: m[4],
		kind: m[5] as MeshMessage["kind"],
		status,
		driverChanged,
		body: reminder ? paragraphs.slice(0, -1).join("\n\n") : rest,
		reminder,
	};
}

/** An injected `[CL Agent Mesh]` prompt: not something the user typed, so it gets its own bubble. */
export function MeshMessageBubble({ message }: { message: MeshMessage }) {
	const [open, setOpen] = useState(false);
	const kind = message.kind ? KIND_META[message.kind] : undefined;
	const Author = message.author?.startsWith("human@") ? User : Bot;
	const link = "ml-auto inline-flex items-center gap-0.5 rounded-md py-0.5 font-medium text-accent hover:underline coarse:py-2";
	const title = (
		<>
			<span className="max-w-[12rem] truncate">{message.title}</span>
			<ArrowUpRight className="size-3 shrink-0" aria-hidden />
		</>
	);
	return (
		<div className="flex flex-col items-start gap-1">
			<div data-mesh-message className="w-full max-w-[92%] overflow-hidden rounded-2xl rounded-bl-md bg-accent-soft shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_30%,transparent)] sm:max-w-[80%]">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-accent/15 px-3.5 py-2 text-2xs">
					<span className="inline-flex items-center gap-1 font-semibold text-accent">
						<Network className="size-3.5" aria-hidden /> CL Agent Mesh
					</span>
					{message.author ? (
						<span className="inline-flex min-w-0 items-center gap-1 font-medium">
							<Author className="size-3 shrink-0" aria-hidden />
							<span className="truncate">{message.author}</span>
						</span>
					) : null}
					{message.scope === "shared" ? <Badge variant="outline">Team</Badge> : null}
					{kind ? <Badge variant={kind.variant}>{kind.label}</Badge> : null}
					{message.brief ? <Badge variant="neutral">{message.scope === "shared" ? "Team brief" : "Task brief"}</Badge> : null}
					{message.status ? <TaskStatusPill status={message.status} /> : null}
					{message.driverChanged !== undefined ? <Badge variant="warning">Driver changed · epoch {message.driverChanged}</Badge> : null}
					{message.scope === "task" ? (
						<Link to="/tasks/$taskId" params={{ taskId: message.refId }} className={link}>
							{title}
						</Link>
					) : (
						<Link to="/shared" className={link}>
							{title}
						</Link>
					)}
				</div>
				<div className="flex flex-col gap-1.5 px-3.5 py-2.5 text-sm leading-relaxed">
					{message.brief ? (
						<button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-fit items-center gap-1 rounded-md py-0.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground coarse:py-2">
							<ChevronRight className={`size-3.5 transition-transform duration-150 ${open ? "rotate-90" : ""}`} aria-hidden />
							{open ? "Hide the brief" : message.scope === "shared" ? "This agent joined a shared session — show the brief" : "Delegated to this agent — show the brief"}
						</button>
					) : null}
					{message.body && (!message.brief || open) ? <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.body}</p> : null}
					{message.reminder ? <p className="text-xs italic text-muted-foreground">{message.reminder}</p> : null}
				</div>
			</div>
		</div>
	);
}
