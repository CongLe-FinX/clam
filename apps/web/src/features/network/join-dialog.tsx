import type { NodePreview, OutgoingPairing } from "@clam/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, CircleSlash, Clock, Loader2, MessagesSquare, ShieldCheck, Users, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/api";
import { qk, useNode, useOutgoingPairings } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Field } from "@/ui/field";
import { Input } from "@/ui/input";
import { CODE_LENGTH, CodeInput } from "./code-input";
import { FingerprintCompare } from "./fingerprint";
import { formatInvitationCode } from "./format";
import { useJoin, useJoinPreview } from "./hooks";
import { Stepper } from "./stepper";

type Step = "address" | "verify" | "code" | "progress";
const STEPS: Step[] = ["address", "verify", "code", "progress"];
const LABELS = ["Address", "Verify", "Code", "Waiting", "Paired"] as const;
const TERMINAL: ReadonlySet<OutgoingPairing["state"]> = new Set(["paired", "rejected", "expired", "failed"]);

const DESCRIPTION: Record<Step, string> = {
	address: "Enter the address the other machine gave you.",
	verify: "Make sure you are talking to the right machine before you use its code.",
	code: "Type or paste the one-time code from the inviter.",
	progress: "The inviter has to approve this request on their screen.",
};

const normalizeUrl = (raw: string): string => {
	const t = raw.trim();
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
	// Peers must be https; loopback (development nodes) is the only schemeless host that defaults to http.
	return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t) ? `http://${t}` : `https://${t}`;
};

export default function JoinDialog({ onClose }: { onClose: () => void }) {
	const [step, setStep] = useState<Step>("address");
	const [url, setUrl] = useState("");
	const [preview, setPreview] = useState<NodePreview | null>(null);
	const [pairingId, setPairingId] = useState<string | null>(null);
	const [joined, setJoined] = useState<OutgoingPairing | null>(null);
	const outgoing = useOutgoingPairings();
	const live = pairingId ? (outgoing.data?.find((x) => x.id === pairingId) ?? joined) : null;
	const stepIndex = step === "progress" ? (live?.state === "paired" ? LABELS.length : 3) : STEPS.indexOf(step);

	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-xl" sheetOnMobile>
				<DialogHeader>
					<DialogTitle>Join another machine</DialogTitle>
					<DialogDescription>{stepIndex === LABELS.length ? "Both machines are connected and now trust each other." : DESCRIPTION[step]}</DialogDescription>
					<Stepper steps={LABELS} current={stepIndex} className="pt-2" />
				</DialogHeader>
				<div key={step} className="-mx-1 flex min-h-0 animate-fade-in flex-col gap-4 overflow-y-auto px-1">
					{step === "address" ? (
						<AddressStep
							url={url}
							setUrl={setUrl}
							onClose={onClose}
							onPreview={(p, normalized) => {
								setUrl(normalized);
								setPreview(p);
								setStep("verify");
							}}
						/>
					) : null}
					{step === "verify" && preview ? <VerifyStep preview={preview} url={url} onBack={() => setStep("address")} onConfirm={() => setStep("code")} /> : null}
					{step === "code" && preview ? (
						<CodeStep
							preview={preview}
							url={url}
							onBack={() => setStep("verify")}
							onJoined={(p) => {
								setJoined(p);
								setPairingId(p.id);
								setStep("progress");
							}}
						/>
					) : null}
					{step === "progress" && pairingId && joined ? <ProgressStep initial={joined} id={pairingId} onClose={onClose} onRetry={() => setStep("code")} onRestart={() => setStep("address")} /> : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function AddressStep({ url, setUrl, onPreview, onClose }: { url: string; setUrl: (v: string) => void; onPreview: (p: NodePreview, url: string) => void; onClose: () => void }) {
	const preview = useJoinPreview();
	const go = () => {
		const normalized = normalizeUrl(url);
		preview.mutate(normalized, { onSuccess: (p) => onPreview(p, normalized) });
	};
	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				if (url.trim()) go();
			}}
		>
			<Field label="Address of the machine" hint="The https:// address the inviter sent you, e.g. https://agent-a.example.com or a trycloudflare.com address." error={preview.error ? errorMessage(preview.error) : null}>
				{(id) => (
					<Input
						id={id}
						autoFocus
						value={url}
						onChange={(e) => {
							setUrl(e.target.value);
							preview.reset();
						}}
						inputMode="url"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						placeholder="https://…"
						aria-invalid={Boolean(preview.error)}
						className="font-mono"
					/>
				)}
			</Field>
			<DialogFooter>
				<Button variant="ghost" onClick={onClose}>
					Cancel
				</Button>
				<Button type="submit" variant="primary" loading={preview.isPending} disabled={!url.trim()}>
					Look up machine
				</Button>
			</DialogFooter>
		</form>
	);
}

function VerifyStep({ preview, url, onBack, onConfirm }: { preview: NodePreview; url: string; onBack: () => void; onConfirm: () => void }) {
	const [checked, setChecked] = useState(false);
	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center gap-3 rounded-xl bg-surface-2 p-3">
				<div className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
					<ShieldCheck className="size-5" />
				</div>
				<div className="min-w-0">
					<div className="truncate text-[15px] font-semibold">{preview.name}</div>
					<div className="truncate font-mono text-xs text-subtle">{url}</div>
					<div className="text-xs text-subtle">CL Agent Mesh v{preview.version}</div>
				</div>
			</div>
			<FingerprintCompare label="Fingerprint presented by this machine" fingerprint={preview.fingerprint} />
			<p className="text-[13px] text-muted-foreground">
				Ask the inviter to read the words and fingerprint from their <strong>Share this code</strong> screen. If a single character differs, stop — someone between you and that machine may be impersonating it.
			</p>
			<label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl bg-surface-2 p-3 text-[13px]">
				<input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--accent)] coarse:size-5" />
				<span>I compared this fingerprint with the one on the inviter's screen and they are identical.</span>
			</label>
			<DialogFooter>
				<Button variant="ghost" onClick={onBack}>
					Back
				</Button>
				<Button variant="primary" disabled={!checked} onClick={onConfirm}>
					Continue
				</Button>
			</DialogFooter>
		</div>
	);
}

function CodeStep({ preview, url, onBack, onJoined }: { preview: NodePreview; url: string; onBack: () => void; onJoined: (p: OutgoingPairing) => void }) {
	const join = useJoin();
	const [code, setCode] = useState("");
	const ready = code.length === CODE_LENGTH;
	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				if (ready) join.mutate({ url, code: formatInvitationCode(code), expectedFingerprint: preview.fingerprint }, { onSuccess: onJoined });
			}}
		>
			<Field label={`Invitation code from ${preview.name}`} hint="Eight characters, valid once. Paste the whole message if you like. The code itself is never sent over the network — only a proof that you know it." error={join.error ? errorMessage(join.error) : null}>
				{(id) => (
					<CodeInput
						id={id}
						autoFocus
						value={code}
						invalid={Boolean(join.error)}
						onChange={(next) => {
							setCode(next);
							join.reset();
						}}
					/>
				)}
			</Field>
			<DialogFooter>
				<Button variant="ghost" onClick={onBack}>
					Back
				</Button>
				<Button type="submit" variant="primary" loading={join.isPending} disabled={!ready}>
					Pair with {preview.name}
				</Button>
			</DialogFooter>
		</form>
	);
}

function ProgressStep({ initial, id, onClose, onRetry, onRestart }: { initial: OutgoingPairing; id: string; onClose: () => void; onRetry: () => void; onRestart: () => void }) {
	const list = useOutgoingPairings();
	const qc = useQueryClient();
	const navigate = useNavigate();
	const p = list.data?.find((x) => x.id === id) ?? initial;
	const me = useNode();
	const openDialog = useUi((s) => s.openDialog);
	const done = TERMINAL.has(p.state);
	// The `network` topic pushes state changes; this poll only covers a missed frame.
	useEffect(() => {
		if (done) return;
		const t = setInterval(() => void qc.invalidateQueries({ queryKey: qk.outgoingPairings }), 4000);
		return () => clearInterval(t);
	}, [done, qc]);

	const name = p.remote.name;
	return (
		<div className="flex animate-fade-in flex-col gap-4" role="status" aria-live="polite">
			{p.state === "hello_sent" ? (
				<Panel icon={<Loader2 className="size-6 animate-spin text-accent" />} title={`Contacting ${name}…`}>
					Proving that you know the code and checking that {name} presents the fingerprint you verified.
				</Panel>
			) : null}
			{p.state === "awaiting_remote_approval" ? (
				<>
					<Panel
						icon={
							<span className="relative grid size-14 place-items-center">
								<span className="absolute inset-0 rounded-full bg-accent/30 [animation:clam-pulse-ring_1.8s_ease-out_infinite]" />
								<span className="relative grid size-11 place-items-center rounded-full bg-accent-soft text-accent shadow-[inset_0_0_0_1.5px_var(--accent)]">
									<Clock className="size-5" />
								</span>
							</span>
						}
						title={`Waiting for ${name} to approve`}
					>
						The code was accepted. The inviter now sees a request with <strong>your</strong> picture, words and fingerprint below, and decides what to grant. You can close this window — pairing continues in the background.
					</Panel>
					{me.data ? <FingerprintCompare label="Your fingerprint — the inviter compares this" fingerprint={me.data.fingerprint} /> : null}
				</>
			) : null}
			{p.state === "paired" ? (
				<Panel icon={<span className="grid size-14 place-items-center rounded-full bg-success/15"><CheckCircle2 className="size-7 text-success" /></span>} title={`Paired with ${name}`}>
					Both machines pinned each other's keys. Every request between you is now signed, and {name} appears under Connected machines.
				</Panel>
			) : null}
			{p.state === "rejected" ? (
				<Panel icon={<XCircle className="size-6 text-danger" />} title="The inviter rejected the request">
					{name} declined to pair. Nothing was stored on either node. Ask for a new invitation if this was a mistake.
				</Panel>
			) : null}
			{p.state === "expired" ? (
				<Panel icon={<CircleSlash className="size-6 text-warning" />} title="The invitation expired">
					The code was not approved in time. Ask {name} to create a new invitation.
				</Panel>
			) : null}
			{p.state === "failed" ? (
				<Panel icon={<AlertTriangle className="size-6 text-danger" />} title="Pairing failed">
					{p.error ?? "The machines could not complete the handshake."}
				</Panel>
			) : null}
			<DialogFooter className="sm:flex-wrap">
				{p.state === "paired" ? (
					<>
						<Button
							variant="ghost"
							onClick={() => {
								onClose();
								void navigate({ to: "/network/nodes/$peerId", params: { peerId: p.remote.nodeId } });
							}}
						>
							View machine
						</Button>
						<Button
							variant="outline"
							onClick={() => {
								onClose();
								openDialog({ kind: "new-chat" });
							}}
						>
							<MessagesSquare /> Start a group chat with its agents
						</Button>
						<Button
							variant="primary"
							onClick={() => {
								onClose();
								void navigate({ to: "/network/agents" });
							}}
						>
							<Users /> Open Agent Directory
						</Button>
					</>
				) : null}
				{p.state === "rejected" || p.state === "expired" ? (
					<Button variant="outline" onClick={onRestart}>
						Start over
					</Button>
				) : null}
				{p.state === "failed" ? (
					<Button variant="outline" onClick={onRetry}>
						Try again
					</Button>
				) : null}
				{p.state === "paired" ? null : (
					<Button variant="ghost" onClick={onClose}>
						{done ? "Close" : "Close — continue in background"}
					</Button>
				)}
			</DialogFooter>
		</div>
	);
}

function Panel({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col items-center gap-3 rounded-xl bg-surface-2 px-4 py-8 text-center">
			{icon}
			<div className="flex max-w-md flex-col gap-1.5">
				<h3 className="text-[15px] font-semibold">{title}</h3>
				<p className="text-[13px] text-muted-foreground">{children}</p>
			</div>
		</div>
	);
}
