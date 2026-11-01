import { ChevronDown, MessageCircleQuestion, ShieldQuestion, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { t } from "@/i18n";
import { errorText } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import { Tip } from "@/ui/tooltip";
import { CountdownBar, CountdownPill, useRemaining } from "./countdown.tsx";
import type { OmpStore, PendingRequest } from "./omp-store.ts";

const NEGATIVE = /^(deny|reject|no|cancel|decline|block)\b/i;
const APPROVAL_TITLE = /^(allow|approve|run|permit|confirm)\b|\btool\b/i;

/** First line is the headline; the rest (a command, a path, a diff) is shown as code. */
function splitTitle(title: string): { head: string; detail: string } {
	const lines = title.split("\n");
	return { head: (lines[0] ?? "").trim() || t("The agent needs your input"), detail: lines.slice(1).join("\n").trim() };
}

/**
 * Approvals and the plain dialogs of OMP (`select`, `confirm`, `input`, `editor`) in the same visual language as the
 * question card. One tap answers; dismissing sends "cancelled", which OMP treats as declining.
 */
export function RequestCard({ store, request, onCollapse, className }: { store: OmpStore; request: PendingRequest; onCollapse?: () => void; className?: string }) {
	const [text, setText] = useState(request.method === "editor" ? (request.message ?? "") : "");
	const [sending, setSending] = useState<string | null>(null);
	const remaining = useRemaining(request);
	const { head, detail } = splitTitle(request.title);
	const approval = request.method === "confirm" || (request.method === "select" && (APPROVAL_TITLE.test(head) || (request.options ?? []).some((o) => NEGATIVE.test(o))));
	const options = request.options ?? [];
	const locked = sending !== null;

	const answer = async (value: boolean | string | null, tag: string): Promise<void> => {
		setSending(tag);
		try {
			await store.respond(request.requestId, value);
		} catch (e) {
			toast.error(errorText(e));
			setSending(null);
		}
	};

	const Icon = approval ? ShieldQuestion : MessageCircleQuestion;
	const body = request.method === "confirm" ? request.message : undefined;

	return (
		<section aria-label={approval ? t("Approval needed") : t("Input needed")} className={cn("flex min-h-0 flex-col overflow-hidden rounded-2xl bg-overlay shadow-pop", className)}>
			{remaining !== null && request.timeoutMs !== undefined ? <CountdownBar remaining={remaining} total={request.timeoutMs} /> : null}
			<div className="flex shrink-0 items-start gap-2.5 px-3.5 pt-3 pb-1.5">
				<span aria-hidden className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg", approval ? "bg-warning/14 text-warning" : "bg-accent-soft text-accent")}>
					<Icon className="size-3.5" />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="text-2xs font-medium uppercase tracking-wider text-subtle">{approval ? t("Approval needed") : request.method === "input" || request.method === "editor" ? t("Your input") : t("Choose one")}</span>
					<p className="break-words text-[15px] font-medium leading-snug">{head}</p>
				</div>
				{remaining !== null ? <CountdownPill remaining={remaining} /> : null}
				{onCollapse ? (
					<Tip label={t("Minimise")}>
						<Button variant="ghost" size="icon-sm" aria-label={t("Minimise request")} onClick={onCollapse}>
							<ChevronDown />
						</Button>
					</Tip>
				) : null}
			</div>
			<div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3.5 pt-1 pb-3">
				{detail ? <pre className="scrollbar-thin max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-2 p-3 font-mono text-xs leading-relaxed shadow-[inset_0_0_0_1px_var(--border)]">{detail}</pre> : null}
				{body ? <p className="break-words text-[13px] leading-relaxed text-muted-foreground">{body}</p> : null}

				{request.method === "confirm" ? (
					<div className="flex flex-wrap gap-2">
						<Button variant="primary" size="lg" loading={sending === "yes"} disabled={locked} onClick={() => void answer(true, "yes")}>
							{t("Approve")}
						</Button>
						<Button variant="outline" size="lg" loading={sending === "no"} disabled={locked} onClick={() => void answer(false, "no")}>
							{t("Deny")}
						</Button>
					</div>
				) : request.method === "select" ? (
					<div className="flex flex-col gap-1.5">
						{options.map((option, i) => {
							const description = request.optionDetails?.[i]?.description;
							const negative = NEGATIVE.test(option);
							return (
								<button
									key={option}
									type="button"
									disabled={locked}
									onClick={() => void answer(option, option)}
									className={cn(
										"flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none transition-[background-color,box-shadow,transform,opacity] duration-150 active:scale-[0.99] focus-visible:shadow-[0_0_0_2px_var(--accent)] disabled:opacity-60 coarse:min-h-14",
										approval && i === 0 && !negative
											? "bg-accent text-accent-foreground hover:bg-accent-hover"
											: "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-surface-3",
									)}
								>
									<span className="flex min-w-0 flex-1 flex-col gap-0.5">
										<span className={cn("break-words text-[13.5px] font-medium", negative && !(approval && i === 0) && "text-danger")}>{option}</span>
										{description ? <span className={cn("break-words text-xs", approval && i === 0 && !negative ? "text-accent-foreground/80" : "text-muted-foreground")}>{description}</span> : null}
									</span>
									{sending === option ? <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null}
								</button>
							);
						})}
					</div>
				) : request.method === "input" || request.method === "editor" ? (
					<div className="flex flex-col gap-2">
						<Textarea
							value={text}
							onChange={(e) => setText(e.target.value)}
							rows={request.method === "editor" ? 6 : 2}
							placeholder={request.method === "input" ? (request.message ?? t("Type your answer")) : t("Type your answer")}
							aria-label={head}
							className="text-[13.5px]"
						/>
						<div className="flex">
							<Button variant="primary" loading={sending === "text"} disabled={locked} onClick={() => void answer(text, "text")}>
								{t("Send")}
							</Button>
						</div>
					</div>
				) : (
					<p className="text-xs text-muted-foreground">{t("This kind of request ({method}) cannot be answered here.", { method: request.method })}</p>
				)}
			</div>
			<div className="flex shrink-0 items-center justify-end border-t bg-surface-1 px-3.5 py-1.5">
				<Button variant="ghost" size="sm" disabled={locked} onClick={() => void answer(null, "dismiss")}>
					<X /> {t("Dismiss")}
				</Button>
			</div>
		</section>
	);
}
