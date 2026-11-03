import { Ban, CheckCircle2, ChevronRight, Clock, XCircle } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { CopyButton } from "@/components/code-block";
import { t } from "@/i18n";
import { cn, formatDuration } from "@/lib/utils";
import type { SessionStream } from "./stream-store.ts";

type Outcome = "done" | "failed" | "cancelled";

export interface AsyncResult {
	jobId: string | null;
	outcome: Outcome;
	/** What the job printed, without the notice's own framing lines. */
	output: string;
	wallMs: number | null;
	exitCode: number | null;
}

/** Lines the harness adds around a job's output: they say nothing about the result itself. */
const NOISE = [/^Ran in a temporary shell\b/, /^Delivery: /, /^Backgrounded (?:early|as job)\b/];

/**
 * `<system-notice>Background job bg_2 has completed. Resume your work using the result below.\n<output>\nWall time: 103.2 seconds</system-notice>`
 * → job id, outcome, the output alone, wall time and exit code.
 */
export function parseAsyncResult(raw: string): AsyncResult {
	const lines = raw
		.replace(/^\s*<system-notice>\s*/, "")
		.replace(/\s*<\/system-notice>\s*$/, "")
		.split("\n");
	const head = /^Background job (\S+?) (?:has )?(completed|failed|been cancelled|was cancelled|cancelled|timed out|was killed)\b/i.exec(lines[0] ?? "");
	if (head) lines.shift();
	let outcome: Outcome = !head ? "done" : /fail|timed out|killed/i.test(head[2] ?? "") ? "failed" : /cancel/i.test(head[2] ?? "") ? "cancelled" : "done";
	let wallMs: number | null = null;
	let exitCode: number | null = null;
	const kept: string[] = [];
	for (const line of lines) {
		const wall = /^Wall time: ([\d.]+) seconds?$/.exec(line.trim());
		if (wall) {
			wallMs = Number(wall[1]) * 1000;
			continue;
		}
		const exit = /^Command exited with code (\d+)$/.exec(line.trim());
		if (exit) {
			exitCode = Number(exit[1]);
			if (exitCode !== 0) outcome = "failed";
			continue;
		}
		if (NOISE.some((re) => re.test(line.trim()))) continue;
		kept.push(line);
	}
	return { jobId: head?.[1] ?? null, outcome, output: kept.join("\n").trim(), wallMs, exitCode };
}

/** The intent of the tool call that started job `jobId`: the nearest earlier tool whose result says it went to the background as that job. */
function jobLabel(stream: SessionStream, rowKey: string, jobId: string | null): string | null {
	if (!jobId) return null;
	const order = stream.getOrder();
	const needle = new RegExp(`\\bas job ${jobId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
	for (let i = order.indexOf(rowKey) - 1, seen = 0; i >= 0 && seen < 400; i--, seen++) {
		const rec = stream.getRec(order[i] as string);
		if (rec?.msg.role !== "assistant") continue;
		for (const block of rec.msg.content) {
			if (block.type !== "toolCall") continue;
			const tool = stream.getTool(block.id);
			if (tool?.result && needle.test(tool.result)) return block.intent ?? tool.intent ?? null;
		}
	}
	return null;
}

const OUTCOME = {
	done: { Icon: CheckCircle2, tone: "text-success", ring: "", word: () => t("Finished") },
	failed: { Icon: XCircle, tone: "text-danger", ring: "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--danger)_40%,transparent)]", word: () => t("Failed") },
	cancelled: { Icon: Ban, tone: "text-subtle", ring: "", word: () => t("Cancelled") },
} as const;

/** A background job's result as the agent received it: one line (what ran, how it ended, how long), the output's tail, the rest on demand. */
export const AsyncResultCard = memo(function AsyncResultCard({ stream, rowKey, text }: { stream: SessionStream; rowKey: string; text: string }) {
	const result = useMemo(() => parseAsyncResult(text), [text]);
	const label = useMemo(() => jobLabel(stream, rowKey, result.jobId), [stream, rowKey, result.jobId]);
	const [open, setOpen] = useState(false);
	const { Icon, tone, ring, word } = OUTCOME[result.outcome];
	const tail = useMemo(() => result.output.split("\n").filter((l) => l.trim()).slice(-3).join("\n"), [result.output]);
	const bodyId = `async-${rowKey}`;
	return (
		<div className={cn("max-w-3xl overflow-hidden rounded-lg bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]", ring)}>
			<div className="flex min-h-9 items-center gap-1 pr-1 coarse:min-h-11">
				<button
					type="button"
					aria-expanded={open}
					aria-controls={bodyId}
					disabled={!result.output}
					onClick={() => setOpen((v) => !v)}
					className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-2.5 pr-1.5 text-left outline-none transition-colors enabled:hover:bg-surface-2 focus-visible:bg-surface-2"
				>
					<ChevronRight className={cn("size-3.5 shrink-0 text-subtle transition-transform duration-150", open && "rotate-90", !result.output && "invisible")} aria-hidden />
					<Icon className={cn("size-3.5 shrink-0", tone)} aria-hidden />
					<span className="min-w-0 flex-1 truncate text-xs">
						<span className="font-medium">{label ?? t("Background job")}</span>
						<span className="text-subtle"> · {word()}</span>
					</span>
					{result.exitCode !== null && result.exitCode !== 0 ? <span className="shrink-0 rounded bg-danger/12 px-1.5 py-px font-mono text-2xs text-danger">{t("exit {code}", { code: result.exitCode })}</span> : null}
					{result.jobId ? <span className="shrink-0 rounded bg-surface-3 px-1.5 py-px font-mono text-2xs text-muted-foreground">{result.jobId}</span> : null}
					{result.wallMs !== null ? (
						<span className="tabular flex shrink-0 items-center gap-1 font-mono text-2xs text-subtle">
							<Clock className="size-3" aria-hidden />
							{formatDuration(result.wallMs)}
						</span>
					) : null}
				</button>
				{open ? <CopyButton text={result.output} label={t("Copy output")} className="size-7 shrink-0 coarse:size-11" /> : null}
			</div>
			{open ? (
				<pre id={bodyId} className="animate-fade-in scrollbar-thin max-h-80 overflow-auto whitespace-pre-wrap break-words border-t bg-surface-2/40 px-3 py-2 font-mono text-2xs leading-[1.15rem] text-muted-foreground">
					{result.output}
				</pre>
			) : tail ? (
				<pre className="line-clamp-3 overflow-hidden whitespace-pre-wrap break-all border-t px-3 py-1.5 font-mono text-2xs leading-4 text-subtle">{tail}</pre>
			) : null}
		</div>
	);
});
