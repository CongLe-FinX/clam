import { memo } from "react";
import { t } from "@/i18n";
import { useOmpStateOptional, useOptionalOmpStore } from "./omp/omp-store.ts";
import { useSessionEnv } from "./session-env.ts";
import { isBusy, type SessionStream, useMsgSlice, useOrder, useStreamMeta } from "./stream-store.ts";

/**
 * Tail-of-conversation status: three pulsing dots with the agent's name while the agent is busy and no text is streaming
 * (before the first token, between tool calls, while a tool runs). While a question or approval waits for a person it says
 * so instead: the agent is not working then, it is blocked on you. The live region stays mounted so screen readers get a
 * polite announcement whenever it fills.
 */
export const TypingIndicator = memo(function TypingIndicator({ stream }: { stream: SessionStream }) {
	const env = useSessionEnv();
	const busy = useStreamMeta(stream, isBusy);
	const aborting = useStreamMeta(stream, (m) => m.aborting);
	const waiting = useOmpStateOptional(useOptionalOmpStore()).requests.length > 0;
	const order = useOrder(stream);
	const last = order[order.length - 1] ?? "";
	// Text (or a thinking/tool block) is already streaming into the last row: that row shows its own progress.
	const streamingVisible = useMsgSlice(stream, last, (rec) => rec !== undefined && rec.streaming && rec.msg.content.some((b) => (b.type === "text" ? b.text.length > 0 : true)));
	const show = (busy || waiting) && !streamingVisible;
	return (
		<div role="status" aria-live="polite" aria-atomic="true" className="mx-auto w-full max-w-[60rem] px-4">
			{show ? (
				<div className="flex items-center gap-2 pb-5 pt-1 text-[13px] text-muted-foreground">
					<span aria-hidden className="flex h-4 items-center gap-1">
						{waiting && !aborting ? (
							<span className="size-1.5 rounded-full bg-warning" />
						) : (
							[0, 1, 2].map((i) => <span key={i} className="size-1.5 animate-typing-dot rounded-full bg-accent" style={{ animationDelay: `${i * 160}ms` }} />)
						)}
					</span>
					<span>{aborting ? t("Stopping…") : waiting ? t("Waiting for your answer") : t("{name} is working…", { name: env.agentName })}</span>
				</div>
			) : null}
		</div>
	);
});
