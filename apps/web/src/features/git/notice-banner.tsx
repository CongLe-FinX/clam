import { CircleCheck, Info, TriangleAlert, X, XCircle } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { type GitNotice, useGitUi } from "./store.ts";

const tones = {
	error: { icon: XCircle, box: "bg-danger/[0.08] text-danger", ring: "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--danger)_30%,transparent)]" },
	warning: { icon: TriangleAlert, box: "bg-warning/[0.10] text-warning", ring: "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning)_30%,transparent)]" },
	success: { icon: CircleCheck, box: "bg-success/[0.10] text-success", ring: "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--success)_30%,transparent)]" },
	info: { icon: Info, box: "bg-info/[0.10] text-info", ring: "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--info)_30%,transparent)]" },
} as const;

const SHOWN_PATHS = 6;

/** A refusal or rejection that must not scroll away: what happened, which files, git's own words, and what to do next. */
export function NoticeBanner({ projectId, onOpenPath }: { projectId: string; onOpenPath?: (path: string) => void }) {
	const notice = useGitUi((s) => s.notices[projectId]);
	const setNotice = useGitUi((s) => s.setNotice);
	if (!notice) return null;
	return <NoticeCard key={notice.id} notice={notice} onDismiss={() => setNotice(projectId, null)} onOpenPath={onOpenPath} />;
}

function NoticeCard({ notice, onDismiss, onOpenPath }: { notice: GitNotice; onDismiss: () => void; onOpenPath?: (path: string) => void }) {
	const t = tones[notice.tone];
	const [all, setAll] = useState(false);
	const paths = notice.paths ?? [];
	const visible = all ? paths : paths.slice(0, SHOWN_PATHS);
	const Icon = t.icon;
	return (
		<div role={notice.tone === "error" ? "alert" : "status"} className={cn("animate-slide-up scrollbar-thin mx-2.5 my-2 max-h-[min(18rem,40%)] shrink-0 overflow-y-auto rounded-xl p-3 text-[13px]", t.box, t.ring)}>
			<div className="flex items-start gap-2.5">
				<Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
				<div className="flex min-w-0 flex-1 flex-col gap-2 text-foreground">
					<p className={cn("font-medium", t.box.split(" ").pop())}>{notice.title}</p>
					{notice.body ? <p className="leading-relaxed text-muted-foreground">{notice.body}</p> : null}
					{paths.length > 0 ? (
						<div>
							<p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-subtle">Blocking files</p>
							<ul className="flex flex-col gap-0.5">
								{visible.map((p) => (
									<li key={p}>
										<button type="button" onClick={() => onOpenPath?.(p)} className="max-w-full truncate rounded px-1 font-mono text-xs underline-offset-2 outline-none hover:bg-surface-3 hover:underline focus-visible:bg-surface-3">
											{p}
										</button>
									</li>
								))}
							</ul>
							{paths.length > SHOWN_PATHS && !all ? (
								<button type="button" onClick={() => setAll(true)} className="mt-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
									Show {paths.length - SHOWN_PATHS} more
								</button>
							) : null}
						</div>
					) : null}
					{notice.detail && notice.detail !== notice.body ? (
						<pre className="scrollbar-thin max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 px-2.5 py-2 font-mono text-2xs leading-relaxed text-muted-foreground">{notice.detail}</pre>
					) : null}
					{notice.next ? (
						<p className="leading-relaxed">
							<span className="font-medium">Next: </span>
							<span className="text-muted-foreground">{notice.next}</span>
						</p>
					) : null}
				</div>
				<button type="button" aria-label="Dismiss" onClick={onDismiss} className="grid size-6 shrink-0 place-items-center rounded-md text-subtle outline-none hover:bg-surface-3 hover:text-foreground coarse:size-9">
					<X className="size-3.5" />
				</button>
			</div>
		</div>
	);
}
