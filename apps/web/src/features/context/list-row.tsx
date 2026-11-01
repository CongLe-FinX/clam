import type { Context, ContextType } from "@clam/contracts";
import { Lock, Share2 } from "lucide-react";
import { tr } from "@/i18n";
import { cn, relativeTime } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { contextTypeInfo, syncBadge } from "./format.ts";

export function TypeBadge({ type, className }: { type: ContextType; className?: string }) {
	const { icon: Icon, label } = contextTypeInfo(type);
	return (
		<Badge variant="outline" className={className}>
			<Icon aria-hidden /> {tr(label)}
		</Badge>
	);
}

/** Private / syncing / synced to N / conflict chip; tooltip text is in `title`. */
export function SyncChip({ context, nodeNames, className }: { context: Pick<Context, "shareable" | "sync">; nodeNames: Map<string, string>; className?: string }) {
	const b = syncBadge(context, nodeNames);
	const Icon = context.shareable ? Share2 : Lock;
	return (
		<Badge variant={b.variant} className={className} title={b.detail}>
			<Icon aria-hidden /> {b.label}
		</Badge>
	);
}

/** One list entry (title, type, sync, author, age). `snippet` renders under the title when given. */
export function ContextRow({
	context: c,
	nodeNames,
	selected,
	onSelect,
	projectName,
	snippet,
}: {
	context: Pick<Context, "id" | "title" | "type" | "shareable" | "sync" | "author" | "updatedAt" | "version" | "projectId">;
	nodeNames: Map<string, string>;
	selected?: boolean;
	onSelect: () => void;
	projectName?: string | null;
	snippet?: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			aria-current={selected ? "true" : undefined}
			className={cn(
				"flex min-h-[44px] w-full min-w-0 flex-col gap-1 rounded-lg px-3 py-2 text-left outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--accent)]",
				selected ? "bg-surface-3" : "hover:bg-surface-2",
			)}
		>
			<span className="flex min-w-0 items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium">{c.title}</span>
				<span className="shrink-0 text-2xs text-subtle tabular">{relativeTime(c.updatedAt)}</span>
			</span>
			{snippet ? <span className="line-clamp-2 text-xs text-muted-foreground">{snippet}</span> : null}
			<span className="flex min-w-0 flex-wrap items-center gap-1.5">
				<TypeBadge type={c.type} />
				<SyncChip context={c} nodeNames={nodeNames} />
				{projectName ? <span className="truncate text-2xs text-subtle">{projectName}</span> : null}
				<span className="ml-auto truncate text-2xs text-subtle">
					v{c.version} · {c.author.agentName ? `${c.author.agentName}@` : ""}
					{c.author.nodeName}
				</span>
			</span>
		</button>
	);
}
