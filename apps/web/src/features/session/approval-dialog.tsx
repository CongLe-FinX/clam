import { ShieldQuestion } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useIsMobile } from "@/hooks/use-breakpoint";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/ui/sheet";
import { Textarea } from "@/ui/textarea";
import { type SessionStream, type UiRequestRec, useStreamMeta } from "./stream-store.ts";

type Kind = "confirm" | "select" | "input";
const kindOf = (r: UiRequestRec): Kind => (r.method === "confirm" ? "confirm" : r.options && r.options.length > 0 ? "select" : "input");

const negative = /^(deny|reject|no|cancel|decline|block)\b/i;

function RequestBody({ stream, req, pending, className }: { stream: SessionStream; req: UiRequestRec; pending: number; className?: string }) {
	const kind = kindOf(req);
	const [text, setText] = useState("");
	const [answering, setAnswering] = useState<string | null>(null);

	const answer = async (value: boolean | string | null, tag: string) => {
		setAnswering(tag);
		try {
			await stream.respond(req.requestId, value);
		} catch (e) {
			toast.error(`Could not send your answer: ${errorMessage(e)}`);
			setAnswering(null);
		}
	};
	const locked = answering !== null;

	return (
		<div className={cn("flex flex-col gap-3", className)}>
			<div className="flex items-start gap-2.5">
				<span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-warning/14 text-warning">
					<ShieldQuestion className="size-4" aria-hidden />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex items-center gap-2">
						<span className="text-[13px] font-semibold">{req.title}</span>
						{pending > 1 ? <span className="tabular rounded-md bg-surface-3 px-1.5 py-0.5 text-2xs text-muted-foreground">+{pending - 1} waiting</span> : null}
					</div>
					{req.message ? <p className="scrollbar-thin max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">{req.message}</p> : null}
				</div>
			</div>

			{kind === "confirm" ? (
				<div className="flex flex-wrap justify-end gap-2">
					<Button variant="outline" disabled={locked} loading={answering === "deny"} onClick={() => void answer(false, "deny")}>
						Deny
					</Button>
					<Button variant="primary" disabled={locked} loading={answering === "allow"} onClick={() => void answer(true, "allow")}>
						Allow
					</Button>
				</div>
			) : kind === "select" ? (
				<div className="flex flex-col gap-1.5">
					{req.options?.map((o) => (
						<Button
							key={o}
							variant={negative.test(o) ? "outline" : "secondary"}
							className="h-auto min-h-8 justify-start whitespace-normal py-1.5 text-left"
							disabled={locked}
							loading={answering === o}
							onClick={() => void answer(o, o)}
						>
							{o}
						</Button>
					))}
					<Button variant="ghost" size="sm" className="self-end" disabled={locked} onClick={() => void answer(null, "cancel")}>
						Dismiss
					</Button>
				</div>
			) : (
				<form
					className="flex flex-col gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						void answer(text, "submit");
					}}
				>
					<Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="min-h-0" aria-label={req.title} disabled={locked} autoFocus />
					<div className="flex justify-end gap-2">
						<Button variant="ghost" disabled={locked} onClick={() => void answer(null, "cancel")}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" disabled={locked} loading={answering === "submit"}>
							Submit
						</Button>
					</div>
				</form>
			)}
		</div>
	);
}

/** Pending `ui_request`s: inline card above the composer; a bottom sheet on small screens. Never auto-answers. */
export function ApprovalDock({ stream }: { stream: SessionStream }) {
	const requests = useStreamMeta(stream, (m) => m.uiRequests);
	const mobile = useIsMobile();
	const first = requests[0];
	const [sheetOpen, setSheetOpen] = useState(true);
	const firstId = first?.requestId;

	// A new head-of-queue request re-opens the sheet.
	// biome-ignore lint/correctness/useExhaustiveDependencies: firstId is the trigger
	useEffect(() => {
		if (firstId) setSheetOpen(true);
	}, [firstId]);

	if (!first) return null;

	if (!mobile) {
		return (
			<div role="alertdialog" aria-label="Approval required" className="animate-slide-up mx-auto mb-2 w-full max-w-3xl rounded-xl bg-surface-1 p-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning)_45%,transparent)]">
				<RequestBody key={first.requestId} stream={stream} req={first} pending={requests.length} />
			</div>
		);
	}

	return (
		<>
			<button
				type="button"
				onClick={() => setSheetOpen(true)}
				className="mx-3 mb-2 flex min-h-11 items-center gap-2 rounded-xl bg-warning/12 px-3 text-left text-[13px] font-medium text-warning shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning)_40%,transparent)] outline-none"
			>
				<ShieldQuestion className="size-4 shrink-0" aria-hidden />
				<span className="min-w-0 flex-1 truncate">{first.title}</span>
				<span className="shrink-0 text-xs">Review{requests.length > 1 ? ` (${requests.length})` : ""}</span>
			</button>
			<Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
				<SheetContent side="bottom" className="px-4 pb-4 pt-2">
					<SheetTitle className="sr-only">Approval required</SheetTitle>
					<SheetDescription className="sr-only">The agent is waiting for your answer.</SheetDescription>
					<div className="scrollbar-thin overflow-y-auto pt-2">
						<RequestBody key={first.requestId} stream={stream} req={first} pending={requests.length} />
					</div>
				</SheetContent>
			</Sheet>
		</>
	);
}
