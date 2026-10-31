import type { CreateTerminalBody, Project, TerminalInfo } from "@clam/contracts";
import { Folder, Home, MessageSquare, Search, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useProjects } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { GrabHandle } from "@/ui/grab-handle";
import { Skeleton } from "@/ui/skeleton";

const HOME = "__home__";
const shellName = (path: string): string => path.split("/").pop() || path;

/** Replace the home prefix with `~` for display. */
export const tildePath = (path: string, home: string | undefined): string => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

function Row({ selected, icon, title, subtitle, onSelect }: { selected: boolean; icon: React.ReactNode; title: string; subtitle: string; onSelect: () => void }) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={selected}
			onClick={onSelect}
			className={cn(
				"flex w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors duration-150 coarse:min-h-12",
				selected ? "bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]" : "hover:bg-surface-2 focus-visible:bg-surface-2",
			)}
		>
			<span className={cn("grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]", selected && "bg-surface-1 text-accent")}>{icon}</span>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-[13px] font-medium">{title}</span>
				<span className="truncate font-mono text-2xs text-subtle" title={subtitle}>
					{subtitle}
				</span>
			</span>
		</button>
	);
}

/** Where to open a terminal (home, a project folder or a chat folder) and with which shell. */
export function NewTerminalDialog({
	open,
	onOpenChange,
	info,
	initialProjectId,
	pending,
	onCreate,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	info: TerminalInfo | undefined;
	initialProjectId?: string;
	pending: boolean;
	onCreate: (body: CreateTerminalBody) => void;
}) {
	const projects = useProjects();
	const [choice, setChoice] = useState<string>(initialProjectId ?? HOME);
	const [filter, setFilter] = useState("");
	const [shell, setShell] = useState<string | undefined>(undefined);
	useEffect(() => {
		if (open) {
			setChoice(initialProjectId ?? HOME);
			setFilter("");
			setShell(undefined);
		}
	}, [open, initialProjectId]);

	const q = filter.trim().toLowerCase();
	const matches = (p: Project) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q);
	const { userProjects, chats } = useMemo(() => {
		const all = projects.data ?? [];
		return { userProjects: all.filter((p) => p.origin === "user" && matches(p)), chats: all.filter((p) => p.origin === "chat" && matches(p)) };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [projects.data, q]);
	const shells = info?.shells ?? [];

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				sheetOnMobile
				className="max-w-md"
				// On a phone, focusing the filter would pop the keyboard over the list before the user asked to type.
				onOpenAutoFocus={(e) => {
					if (matchMedia("(pointer: coarse)").matches) e.preventDefault();
				}}
			>
				<GrabHandle onClose={() => onOpenChange(false)} className="sm:hidden" />
				<DialogHeader>
					<DialogTitle>New terminal</DialogTitle>
					<DialogDescription>A shell on this machine. Pick the folder it starts in.</DialogDescription>
				</DialogHeader>
				{(projects.data?.length ?? 0) > 5 ? (
					<div className="relative">
						<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" aria-hidden />
						<Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter projects and chats" aria-label="Filter folders" className="pl-8 text-base sm:text-[13px]" />
					</div>
				) : null}
				<div role="radiogroup" aria-label="Starting folder" className="scrollbar-thin -mx-1 flex max-h-[min(46dvh,360px)] min-h-0 flex-col gap-0.5 overflow-y-auto px-1">
					{!q && <Row selected={choice === HOME} icon={<Home className="size-4" />} title="Home" subtitle={info?.home ?? "~"} onSelect={() => setChoice(HOME)} />}
					{projects.isPending ? (
						<div className="flex flex-col gap-1.5 py-1">
							<Skeleton className="h-12" />
							<Skeleton className="h-12" />
						</div>
					) : (
						<>
							{userProjects.length > 0 && <div className="px-2.5 pb-0.5 pt-2.5 text-2xs font-semibold uppercase tracking-wider text-subtle">Projects</div>}
							{userProjects.map((p) => (
								<Row key={p.id} selected={choice === p.id} icon={<Folder className="size-4" />} title={p.name} subtitle={tildePath(p.path, info?.home)} onSelect={() => setChoice(p.id)} />
							))}
							{chats.length > 0 && <div className="px-2.5 pb-0.5 pt-2.5 text-2xs font-semibold uppercase tracking-wider text-subtle">Chats</div>}
							{chats.map((p) => (
								<Row key={p.id} selected={choice === p.id} icon={<MessageSquare className="size-4" />} title={p.name} subtitle={tildePath(p.path, info?.home)} onSelect={() => setChoice(p.id)} />
							))}
							{q && userProjects.length === 0 && chats.length === 0 && <p className="px-2.5 py-6 text-center text-[13px] text-muted-foreground">No folder matches “{filter}”.</p>}
						</>
					)}
				</div>
				{shells.length > 1 && (
					<div className="flex items-center justify-between gap-3">
						<span className="text-[13px] text-muted-foreground">Shell</span>
						<Select value={shell ?? info?.defaultShell} onValueChange={setShell}>
							<SelectTrigger className="w-44" aria-label="Shell">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{shells.map((s) => (
									<SelectItem key={s} value={s}>
										{shellName(s)} <span className="font-mono text-2xs text-subtle">{s}</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						variant="primary"
						loading={pending}
						onClick={() => onCreate({ ...(choice !== HOME ? { projectId: choice } : {}), ...(shell && shell !== info?.defaultShell ? { shell } : {}) })}
					>
						<TerminalSquare /> Open terminal
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
