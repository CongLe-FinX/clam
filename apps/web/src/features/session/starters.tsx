import { Bug, ChartColumn, Clapperboard, FileText, GitPullRequest, type LucideIcon, ListChecks, Search, Telescope } from "lucide-react";
import { useGitStatus } from "@/features/git/hooks";
import { useProject } from "@/lib/queries";
import { useSessionEnv } from "./session-env.ts";

interface Starter {
	icon: LucideIcon;
	title: string;
	hint: string;
	/** Fills the composer (the user finishes and sends it). */
	prompt: string;
}

const MEDIA: readonly Starter[] = [
	{
		icon: Search,
		title: "Research a topic and write a cited report",
		hint: "Saved as a Markdown file in this folder",
		prompt: "Research the topic below and write a short report with cited sources. Save it as report.md in this folder.\n\nTopic: ",
	},
	{
		icon: ChartColumn,
		title: "Make a chart from this data and explain it",
		hint: "Paste numbers, or point to a CSV in this folder",
		prompt: "Make a chart from this data and explain what it shows:\n\n",
	},
	{
		icon: Clapperboard,
		title: "Create a short slideshow or video",
		hint: "Uses ffmpeg when it is installed on this machine",
		prompt: "Create a short slideshow video about the topic below. Use ffmpeg if it is installed; if it is not, say what is missing and build an HTML slideshow instead.\n\nTopic: ",
	},
	{
		icon: FileText,
		title: "Summarize a PDF",
		hint: "Attach it with the paperclip, or drop it in the composer",
		prompt: "Summarize the attached PDF: the key points, the numbers that matter, and any open questions.\n\n",
	},
];

const REPO: readonly Starter[] = [
	{ icon: Telescope, title: "Give me a quick tour of this codebase", hint: "Structure, entry points, how to run it", prompt: "Give me a quick tour of this codebase" },
	{ icon: Bug, title: "Find the cause of the failing tests and fix it", hint: "Runs the tests, then investigates", prompt: "Find the cause of the failing tests and fix it" },
	{ icon: GitPullRequest, title: "Review my uncommitted changes", hint: "Bugs, risks and missing tests", prompt: "Review my uncommitted changes" },
	{ icon: ListChecks, title: "Write a plan before changing anything", hint: "What should we improve first?", prompt: "Write a plan before changing anything: what should we improve first?" },
];

/** Example prompts for an empty conversation. Plain chats get research / chart / media / PDF ideas; repositories keep the code-oriented ones. */
export function Starters({ onPick }: { onPick: (text: string) => void }) {
	const { projectId } = useSessionEnv();
	const project = useProject(projectId).data;
	const plainChat = project?.origin === "chat";
	const git = useGitStatus(projectId, { enabled: project !== undefined && !plainChat }).data;
	// Wait for the project: showing repo prompts for a plain chat (or the reverse) for a moment would be misleading.
	if (!project) return null;
	// A project folder without a repository gets the document-oriented cards.
	const list = plainChat || git?.isRepo === false ? MEDIA : REPO;
	return (
		<ul className="grid w-full max-w-xl gap-2 sm:grid-cols-2" aria-label="Example prompts">
			{list.map((s) => (
				<li key={s.title} className="flex">
					<button
						type="button"
						onClick={() => onPick(s.prompt)}
						className="group flex w-full items-start gap-3 rounded-xl bg-surface-1 p-3 text-left shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[background-color,box-shadow,transform] hover:bg-surface-2 hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:bg-surface-2 focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] active:scale-[0.99] coarse:min-h-14"
					>
						<span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
							<s.icon className="size-4" />
						</span>
						<span className="flex min-w-0 flex-col gap-0.5">
							<span className="text-[13px] font-medium leading-snug text-foreground">{s.title}</span>
							<span className="text-xs text-muted-foreground">{s.hint}</span>
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}
