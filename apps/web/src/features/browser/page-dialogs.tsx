import { type BrowserDialog, routes } from "@clam/contracts";
import { FileUp } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { localUrl } from "@/lib/api";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Input } from "@/ui/input";
import type { FileChooserRequest } from "./connection.ts";

const TITLES: Record<BrowserDialog["kind"], string> = {
	alert: "This page says",
	confirm: "This page asks",
	prompt: "This page asks",
	beforeunload: "Leave this page?",
};

function hostOf(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}

/** alert / confirm / prompt / beforeunload raised by the remote page. Must be answered; the page is blocked until then. */
export function PageDialog({ dialog, onAnswer }: { dialog: BrowserDialog | null; onAnswer: (accept: boolean, promptText?: string) => void }) {
	return (
		<Dialog open={dialog !== null}>
			{dialog ? <PageDialogBody key={`${dialog.kind}:${dialog.url}:${dialog.message}`} dialog={dialog} onAnswer={onAnswer} /> : null}
		</Dialog>
	);
}

function PageDialogBody({ dialog, onAnswer }: { dialog: BrowserDialog; onAnswer: (accept: boolean, promptText?: string) => void }) {
	const [value, setValue] = useState(dialog.defaultPrompt);
	const leave = dialog.kind === "beforeunload";
	const cancelable = dialog.kind !== "alert";
	const accept = () => onAnswer(true, dialog.kind === "prompt" ? value : undefined);
	return (
		<DialogContent
			hideClose
			sheetOnMobile
			className="max-w-md"
			onInteractOutside={(e) => e.preventDefault()}
			onEscapeKeyDown={() => onAnswer(!cancelable)}
			onOpenAutoFocus={(e) => {
				if (dialog.kind !== "prompt") e.preventDefault();
			}}
		>
			<DialogHeader>
				<DialogTitle>{TITLES[dialog.kind]}</DialogTitle>
				<DialogDescription>{hostOf(dialog.url)}</DialogDescription>
			</DialogHeader>
			{leave ? <p className="text-[13px] text-muted-foreground">Changes you made may not be saved.</p> : <p className="scrollbar-thin max-h-[40dvh] overflow-y-auto whitespace-pre-wrap break-words text-sm">{dialog.message}</p>}
			{dialog.kind === "prompt" ? (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						accept();
					}}
				>
					<Input value={value} onChange={(e) => setValue(e.target.value)} aria-label="Your answer" autoComplete="off" spellCheck={false} />
				</form>
			) : null}
			<DialogFooter>
				{cancelable ? (
					<Button variant="outline" size="lg" onClick={() => onAnswer(false)}>
						{leave ? "Stay" : "Cancel"}
					</Button>
				) : null}
				<Button variant={leave ? "danger" : "primary"} size="lg" onClick={accept} autoFocus={dialog.kind !== "prompt"}>
					{leave ? "Leave" : "OK"}
				</Button>
			</DialogFooter>
		</DialogContent>
	);
}

async function uploadAll(uploadId: string, files: File[]): Promise<void> {
	for (const file of files) {
		const res = await fetch(localUrl(routes.browserUpload(uploadId), { name: file.name }), { method: "PUT", body: file, headers: { "content-type": "application/octet-stream" } });
		if (!res.ok) throw new Error(`Uploading ${file.name} failed (${res.status})`);
	}
}

/**
 * The page opened a file picker. A native picker can only open from a tap on THIS device, so the request becomes a sheet
 * with a "Choose" button; the files are PUT to the machine and the page's chooser is answered.
 */
export function FileChooserDialog({ chooser, answer }: { chooser: FileChooserRequest | null; answer: (uploadId?: string) => void }) {
	const [busy, setBusy] = useState(false);
	const cancel = () => {
		if (!busy) answer();
	};
	async function onPick(files: FileList | null) {
		if (!chooser || !files || files.length === 0) return;
		setBusy(true);
		try {
			await uploadAll(chooser.uploadId, Array.from(files));
			answer(chooser.uploadId);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Upload failed");
			answer();
		} finally {
			setBusy(false);
		}
	}
	return (
		<Dialog open={chooser !== null} onOpenChange={(open) => !open && cancel()}>
			{chooser ? (
				<DialogContent hideClose sheetOnMobile className="max-w-md" onInteractOutside={(e) => e.preventDefault()}>
					<DialogHeader>
						<DialogTitle>Choose {chooser.multiple ? "files" : "a file"}</DialogTitle>
						<DialogDescription>The page wants {chooser.multiple ? "files" : "a file"} from this device. They are sent to this machine's browser.</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" size="lg" onClick={cancel} disabled={busy}>
							Cancel
						</Button>
						<Button asChild variant="primary" size="lg" className={busy ? "pointer-events-none opacity-60" : undefined}>
							<label>
								<FileUp /> {busy ? "Uploading…" : chooser.multiple ? "Choose files…" : "Choose file…"}
								<input type="file" multiple={chooser.multiple} className="sr-only" disabled={busy} onChange={(e) => void onPick(e.target.files)} />
							</label>
						</Button>
					</DialogFooter>
				</DialogContent>
			) : null}
		</Dialog>
	);
}
