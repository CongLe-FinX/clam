import { FolderOpen, MessageSquarePlus, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useDebounced } from "@/features/projects/session-list";
import { errorMessage } from "@/lib/api";
import { useSessions } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { t } from "@/i18n";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Input } from "@/ui/input";
import { PageHeader } from "@/ui/page";
import { Skeleton } from "@/ui/skeleton";
import { ChatList } from "./chat-list.tsx";
import { useChats } from "./hooks.ts";

/** A search box is only worth its space once the list is long enough to need it. */
const SEARCH_AFTER = 8;

export default function ChatsPage() {
	const openDialog = useUi((s) => s.openDialog);
	const { chats, isPending } = useChats();
	const sessions = useSessions();
	const error = sessions.error;
	const [search, setSearch] = useState("");
	const needle = useDebounced(search, 150).trim().toLowerCase();
	const visible = useMemo(() => (needle ? chats.filter((c) => (c.title || t("Untitled session")).toLowerCase().includes(needle)) : chats), [chats, needle]);
	return (
		<div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
			<PageHeader
				title={t("Chats")}
				description={t("Plain conversations with agents — no repository needed. Each chat has its own folder for notes, reports and media.")}
				actions={
					<Button variant={chats.length === 0 && !sessions.isPending && !error ? "secondary" : "primary"} onClick={() => openDialog({ kind: "new-chat" })}>
						<MessageSquarePlus /> {t("New chat")}
					</Button>
				}
			/>
			{chats.length > SEARCH_AFTER ? (
				<div className="relative shrink-0">
					<Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
					<Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("{count, plural, one {Search # chat} other {Search # chats}}", { count: chats.length })} aria-label={t("Search chats")} className="pl-9 text-base md:text-[13px]" />
				</div>
			) : null}
			{isPending ? (
				<div className="flex flex-col gap-2 rounded-xl bg-surface-1 p-3 shadow-[inset_0_0_0_1px_var(--border)]" aria-busy="true">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-12" />
					))}
				</div>
			) : error ? (
				<div className="rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]">
					<EmptyState
						icon={FolderOpen}
						title={t("Could not load chats")}
						description={errorMessage(error)}
						action={
							<Button variant="outline" onClick={() => void sessions.refetch()}>
								<RefreshCw /> {t("Retry")}
							</Button>
						}
					/>
				</div>
			) : chats.length === 0 ? (
				<div className="rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]">
					<EmptyState
						icon={FolderOpen}
						title={t("No chats yet")}
						description={t("Start a chat and ask an agent to research a topic, write a report or make a video. Files it creates show up in the chat’s Files panel.")}
						action={
							<Button variant="primary" onClick={() => openDialog({ kind: "new-chat" })}>
								<MessageSquarePlus /> {t("New chat")}
							</Button>
						}
					/>
				</div>
			) : visible.length === 0 ? (
				<div className="rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]">
					<EmptyState icon={Search} title={t("No chats match")} description={t("Nothing in your chats is titled “{search}”.", { search: search.trim() })} />
				</div>
			) : (
				<ChatList chats={visible} />
			)}
		</div>
	);
}
