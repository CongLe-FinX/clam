import { ArrowRight, LogIn, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ui/dialog";

const STEPS = [
	{ n: 1, title: "Invite", body: "One machine creates a one-time code." },
	{ n: 2, title: "Verify", body: "The other checks the fingerprint, then enters the code." },
	{ n: 3, title: "Approve", body: "The inviter approves and picks what is shared." },
] as const;

function Machine({ x, label, tone }: { x: number; label: string; tone: string }) {
	return (
		<g transform={`translate(${x} 22)`}>
			<rect width="92" height="60" rx="9" fill="var(--surface-1)" stroke="var(--border-strong)" strokeWidth="1.5" />
			<rect x="8" y="8" width="76" height="40" rx="5" fill={tone} opacity="0.14" />
			<circle cx="20" cy="20" r="3.5" fill={tone} />
			<rect x="29" y="17" width="40" height="6" rx="3" fill={tone} opacity="0.5" />
			<rect x="14" y="30" width="56" height="5" rx="2.5" fill="var(--border-strong)" />
			<rect x="14" y="39" width="36" height="5" rx="2.5" fill="var(--border-strong)" />
			<path d="M-6 66h104l-8 8H2z" fill="var(--surface-3)" />
			<text x="46" y="94" textAnchor="middle" className="fill-[var(--muted-foreground)] text-[11px] font-medium">
				{label}
			</text>
		</g>
	);
}

/** A ↔ B with the three pairing steps. Pure SVG + text; no images. */
export function PairingDiagram({ className }: { className?: string }) {
	return (
		<div className={cn("flex flex-col gap-4", className)}>
			<svg viewBox="0 0 400 124" role="img" aria-label="Two machines connected by a signed channel" className="mx-auto h-auto w-full max-w-md">
				<Machine x={24} label="This machine" tone="var(--accent)" />
				<Machine x={284} label="Other machine" tone="var(--success)" />
				<g stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" fill="none">
					<path d="M128 44h144" strokeDasharray="2 7" />
					<path d="M262 38l9 6-9 6" />
					<path d="M138 50l-9-6 9-6" />
				</g>
				<g>
					<rect x="168" y="30" width="64" height="28" rx="14" fill="var(--surface-1)" />
					<rect x="168" y="30" width="64" height="28" rx="14" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="1" />
					<text x="200" y="48.5" textAnchor="middle" className="fill-[var(--accent)] text-[10.5px] font-semibold">
						signed
					</text>
				</g>
			</svg>
			<ol className="grid gap-2 sm:grid-cols-3">
				{STEPS.map((s) => (
					<li key={s.n} className="flex items-start gap-2.5 rounded-xl bg-surface-2 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
						<span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft font-mono text-2xs font-semibold text-accent">{s.n}</span>
						<span className="flex flex-col gap-0.5">
							<span className="text-[13px] font-semibold">{s.title}</span>
							<span className="text-xs text-muted-foreground">{s.body}</span>
						</span>
					</li>
				))}
			</ol>
		</div>
	);
}

/** The two ways to connect: this machine creates the code, or enters the other one's code. */
export function ConnectPaths({ onInvite, onJoin, className }: { onInvite: () => void; onJoin: () => void; className?: string }) {
	const paths = [
		{ id: "invite", icon: UserPlus, title: "Invite another machine", body: "This machine creates a one-time code. You send it, with this machine's address, to the other one.", cta: "Create an invitation", onClick: onInvite, primary: true },
		{ id: "join", icon: LogIn, title: "Join another machine", body: "The other machine already gave you an address and a code. Enter them here and approve on its side.", cta: "Enter a code", onClick: onJoin, primary: false },
	];
	return (
		<div className={cn("grid gap-3 md:grid-cols-2", className)}>
			{paths.map((p) => (
				<button
					key={p.id}
					type="button"
					onClick={p.onClick}
					data-testid={`connect-${p.id}`}
					className="group flex min-h-11 flex-col items-start gap-3 rounded-2xl bg-surface-1 p-4 text-left outline-none shadow-[inset_0_0_0_1px_var(--border-strong)] transition-[box-shadow,background-color,transform] hover:bg-surface-2 hover:shadow-[inset_0_0_0_1.5px_var(--accent)] focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] active:scale-[0.99]"
				>
					<span className={cn("grid size-10 place-items-center rounded-xl", p.primary ? "bg-accent text-accent-foreground" : "bg-accent-soft text-accent")}>
						<p.icon className="size-5" />
					</span>
					<span className="flex flex-col gap-1">
						<span className="text-[15px] font-semibold">{p.title}</span>
						<span className="text-[13px] text-muted-foreground">{p.body}</span>
					</span>
					<span className="mt-auto inline-flex items-center gap-1 text-[13px] font-medium text-accent">
						{p.cta} <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
					</span>
				</button>
			))}
		</div>
	);
}

export function ConnectDialog({ onClose, onInvite, onJoin }: { onClose: () => void; onInvite: () => void; onJoin: () => void }) {
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-2xl" sheetOnMobile>
				<DialogHeader>
					<DialogTitle>Connect a machine</DialogTitle>
					<DialogDescription>Pairing is a one-time handshake. After it, every request between the two machines is signed.</DialogDescription>
				</DialogHeader>
				<div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1">
					<ConnectPaths onInvite={onInvite} onJoin={onJoin} />
					<PairingDiagram />
				</div>
			</DialogContent>
		</Dialog>
	);
}
