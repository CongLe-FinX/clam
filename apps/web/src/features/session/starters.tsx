import { parseCheckoutId } from "@clam/contracts";
import { Bug, ChartColumn, Clapperboard, FileText, GitPullRequest, type LucideIcon, ListChecks, Search, Telescope } from "lucide-react";
import { useGitStatus } from "@/features/git/hooks";
import { msg, t, tr, type Msg } from "@/i18n";
import { useProject } from "@/lib/queries";
import { useSessionEnv } from "./session-env.ts";

interface Starter {
	icon: LucideIcon;
	title: Msg;
	hint: Msg;
	/** Fills the composer (the user finishes and sends it). */
	prompt: Msg;
}

const MEDIA: readonly Starter[] = [
	{
		icon: Search,
		title: msg("Research a topic and write a cited report"),
		hint: msg("Saved as a Markdown file in this folder"),
		prompt: msg("Research the topic below and write a short report with cited sources. Save it as report.md in this folder.\n\nTopic: "),
	},
	{
		icon: ChartColumn,
		title: msg("Make a chart from this data and explain it"),
		hint: msg("Paste numbers, or point to a CSV in this folder"),
		prompt: msg("Make a chart from this data and explain what it shows:\n\n"),
	},
	{
		icon: Clapperboard,
		title: msg("Create a short slideshow or video"),
		hint: msg("Uses ffmpeg when it is installed on this machine"),
		prompt: msg("Create a short slideshow video about the topic below. Use ffmpeg if it is installed; if it is not, say what is missing and build an HTML slideshow instead.\n\nTopic: "),
	},
	{
		icon: FileText,
		title: msg("Summarize a PDF"),
		hint: msg("Attach it with the paperclip, or drop it in the composer"),
		prompt: msg("Summarize the attached PDF: the key points, the numbers that matter, and any open questions.\n\n"),
	},
];

const REPO: readonly Starter[] = [
	{ icon: Telescope, title: msg("Give me a quick tour of this codebase"), hint: msg("Structure, entry points, how to run it"), prompt: msg("Give me a quick tour of this codebase") },
	{ icon: Bug, title: msg("Find the cause of the failing tests and fix it"), hint: msg("Runs the tests, then investigates"), prompt: msg("Find the cause of the failing tests and fix it") },
	{ icon: GitPullRequest, title: msg("Review my uncommitted changes"), hint: msg("Bugs, risks and missing tests"), prompt: msg("Review my uncommitted changes") },
	{ icon: ListChecks, title: msg("Write a plan before changing anything"), hint: msg("What should we improve first?"), prompt: msg("Write a plan before changing anything: what should we improve first?") },
];

/** Example prompts for an empty conversation. Plain chats get research / chart / media / PDF ideas; repositories keep the code-oriented ones. */
export function Starters({ onPick }: { onPick: (text: string) => void }) {
	const { checkoutId } = useSessionEnv();
	const project = useProject(parseCheckoutId(checkoutId).projectId).data;
	const plainChat = project?.origin === "chat";
	const git = useGitStatus(checkoutId, { enabled: project !== undefined && !plainChat }).data;
	// Wait for the project: showing repo prompts for a plain chat (or the reverse) for a moment would be misleading.
	if (!project) return null;
	// A project folder without a repository gets the document-oriented cards.
	const list = plainChat || git?.isRepo === false ? MEDIA : REPO;
	return (
		<ul className="grid w-full max-w-xl gap-2 sm:grid-cols-2" aria-label={t("Example prompts")}>
			{list.map((s) => (
				<li key={tr(s.title)} className="flex">
					<button
						type="button"
						onClick={() => onPick(tr(s.prompt))}
						className="group flex w-full items-start gap-3 rounded-xl bg-surface-1 p-3 text-left shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[background-color,box-shadow,transform] hover:bg-surface-2 hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:bg-surface-2 focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] active:scale-[0.99] coarse:min-h-14"
					>
						<span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
							<s.icon className="size-4" />
						</span>
						<span className="flex min-w-0 flex-col gap-0.5">
							<span className="text-[13px] font-medium leading-snug text-foreground">{tr(s.title)}</span>
							<span className="text-xs text-muted-foreground">{tr(s.hint)}</span>
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}
