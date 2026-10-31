import type { GitIdentity, GitStatus } from "@clam/contracts";
import { type UseMutationResult, useQueryClient } from "@tanstack/react-query";
import { Bot, ChevronDown, GitCommitHorizontal, Pencil, UploadCloud, UserRound } from "lucide-react";
import { type Ref, useEffect, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { Input } from "@/ui/input";
import { Kbd } from "@/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Skeleton } from "@/ui/skeleton";
import { Switch } from "@/ui/switch";
import { Textarea } from "@/ui/textarea";
import { useIdentity, useSetIdentity } from "./hooks.ts";
import { commitStaged } from "./ops.ts";
import { useGitUi } from "./store.ts";

const ATTRIBUTE_KEY = "clam.git.attribute";
const SOURCE_LABEL = { account: "GitHub account", project: "this project", "git-config": "git config" } as const;

function useAttributePref(): [boolean, (v: boolean) => void] {
	const [on, setOn] = useState(() => {
		try {
			return localStorage.getItem(ATTRIBUTE_KEY) === "1";
		} catch {
			return false;
		}
	});
	return [
		on,
		(v) => {
			setOn(v);
			try {
				localStorage.setItem(ATTRIBUTE_KEY, v ? "1" : "0");
			} catch {
				/* preference only */
			}
		},
	];
}

export function IdentityLine({ projectId }: { projectId: string }) {
	const q = useIdentity(projectId);
	const save = useSetIdentity(projectId);
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	useEffect(() => {
		if (open && q.data) {
			setName(q.data.name);
			setEmail(q.data.email);
		}
	}, [open, q.data]);

	if (q.isPending) return <Skeleton className="h-4 w-48" />;
	if (q.error || !q.data) {
		return (
			<p className="text-2xs text-warning" role="status">
				No commit identity yet — set one before committing.{" "}
				<IdentityEditor open={open} onOpenChange={setOpen} name={name} email={email} setName={setName} setEmail={setEmail} save={save} source={null}>
					<button type="button" className="underline underline-offset-2">
						Set identity
					</button>
				</IdentityEditor>
			</p>
		);
	}
	const id = q.data;
	return (
		<div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
			<UserRound aria-hidden className="size-3.5 shrink-0 text-subtle" />
			<span className="min-w-0 truncate" title={`${id.name} <${id.email}> · from ${SOURCE_LABEL[id.source]}`}>
				<span className="font-medium text-foreground">{id.name}</span> &lt;{id.email}&gt;
			</span>
			<Badge variant="outline" className="shrink-0">
				{SOURCE_LABEL[id.source]}
			</Badge>
			<IdentityEditor open={open} onOpenChange={setOpen} name={name} email={email} setName={setName} setEmail={setEmail} save={save} source={id.source}>
				<button type="button" aria-label="Edit commit identity" className="grid size-6 shrink-0 place-items-center rounded-md text-subtle outline-none hover:bg-surface-3 hover:text-foreground coarse:size-9">
					<Pencil className="size-3" />
				</button>
			</IdentityEditor>
		</div>
	);
}

function IdentityEditor({
	open,
	onOpenChange,
	name,
	email,
	setName,
	setEmail,
	save,
	source,
	children,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	name: string;
	email: string;
	setName: (v: string) => void;
	setEmail: (v: string) => void;
	save: UseMutationResult<GitIdentity, Error, { name: string; email: string } | null>;
	source: "account" | "project" | "git-config" | null;
	children: React.ReactNode;
}) {
	const submit = (body: { name: string; email: string } | null) =>
		save.mutate(body, {
			onSuccess: () => {
				onOpenChange(false);
				toast.success(body ? "Commit identity saved for this project" : "Using the default identity again");
			},
		});
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>{children}</PopoverTrigger>
			<PopoverContent align="start" className="w-80">
				<form
					className="flex flex-col gap-2.5"
					onSubmit={(e) => {
						e.preventDefault();
						if (name.trim() && email.trim()) submit({ name: name.trim(), email: email.trim() });
					}}
				>
					<div>
						<h4 className="text-[13px] font-medium">Commit identity</h4>
						<p className="text-2xs text-subtle">Author name and email for commits made in this project.</p>
					</div>
					<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Author name" autoFocus />
					<Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" type="email" aria-label="Author email" />
					{save.error ? (
						<p role="alert" className="text-xs text-danger">
							{errorMessage(save.error)}
						</p>
					) : null}
					<div className="flex items-center justify-between gap-2">
						{source === "project" ? (
							<Button variant="ghost" size="sm" type="button" loading={save.isPending} onClick={() => submit(null)}>
								Use default
							</Button>
						) : (
							<span />
						)}
						<Button variant="primary" size="sm" type="submit" loading={save.isPending} disabled={!name.trim() || !email.trim()}>
							Save
						</Button>
					</div>
				</form>
			</PopoverContent>
		</Popover>
	);
}

export function CommitBox({
	projectId,
	status,
	sessionId,
	compact,
	textareaRef,
	busy,
}: {
	projectId: string;
	status: GitStatus;
	sessionId?: string;
	compact?: boolean;
	textareaRef?: Ref<HTMLTextAreaElement>;
	busy: boolean;
}) {
	const qc = useQueryClient();
	const message = useGitUi((s) => s.drafts[projectId] ?? "");
	const setDraft = useGitUi((s) => s.setDraft);
	const [attribute, setAttribute] = useAttributePref();
	const [focused, setFocused] = useState(false);
	const staged = status.files.filter((f) => f.staged && f.kind !== "conflicted").length;
	const conflicted = status.files.some((f) => f.kind === "conflicted");
	const trimmed = message.trim();
	const blocker = conflicted
		? "Resolve conflicted files first"
		: status.operation
			? `A ${status.operation} is in progress`
			: staged === 0
				? "Stage changes to commit them"
				: !trimmed
					? "Write a commit message"
					: null;
	const canPush = status.branch !== null && !status.detached;
	const attributed = Boolean(sessionId) && attribute;

	const submit = (push: boolean) => {
		if (blocker || busy) return;
		void commitStaged(qc, projectId, { message: trimmed, push, sessionId: attributed ? sessionId : undefined });
	};

	const expanded = !compact || focused || message.length > 0;
	return (
		<div className="flex shrink-0 flex-col gap-2 border-t bg-surface-1 p-2.5 pb-safe">
			<Textarea
				ref={textareaRef}
				value={message}
				onChange={(e) => setDraft(projectId, e.target.value)}
				onFocus={() => setFocused(true)}
				onBlur={() => setFocused(false)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						submit(false);
					}
				}}
				rows={expanded ? 3 : 1}
				placeholder={staged ? `Message (commits ${staged} staged ${staged === 1 ? "file" : "files"})` : "Message — stage changes first"}
				aria-label="Commit message"
				className={cn("min-h-0 resize-none py-1.5 text-[13px] transition-[height]", !expanded && "h-9")}
			/>
			{sessionId ? (
				<label className="flex cursor-pointer items-center gap-2 text-2xs text-muted-foreground">
					<Switch checked={attribute} onCheckedChange={setAttribute} aria-label="Attribute commit to this agent session" className="scale-90" />
					<Bot aria-hidden className="size-3.5 text-subtle" />
					<span>Add an agent attribution trailer</span>
				</label>
			) : null}
			<div className="flex items-center gap-1.5">
				<div className="flex min-w-0 flex-1">
					<Button variant="primary" className="min-w-0 flex-1 rounded-r-none" disabled={Boolean(blocker)} loading={busy} onClick={() => submit(false)} title={blocker ?? "Commit staged changes"}>
						<GitCommitHorizontal /> <span className="truncate">Commit{staged ? ` (${staged})` : ""}</span>
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="primary" size="icon" className="rounded-l-none border-l border-accent-foreground/20" aria-label="More commit actions" disabled={Boolean(blocker) || !canPush}>
								<ChevronDown />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onSelect={() => submit(true)}>
								<UploadCloud /> Commit &amp; Push
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<Button variant="outline" disabled={Boolean(blocker) || !canPush || busy} onClick={() => submit(true)} className={cn("shrink-0", compact ? "hidden" : "inline-flex")}>
					<UploadCloud /> Commit &amp; Push
				</Button>
			</div>
			<div className="flex min-w-0 items-center justify-between gap-2">
				<IdentityLine projectId={projectId} />
				{!compact ? (
					<span className="hidden shrink-0 items-center gap-1 text-2xs text-subtle fine:flex">
						<Kbd>⌘</Kbd>
						<Kbd>↵</Kbd>
					</span>
				) : null}
			</div>
			{blocker && trimmed ? <p className="text-2xs text-subtle">{blocker}.</p> : null}
		</div>
	);
}
