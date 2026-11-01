import type { PeerStatus } from "@clam/contracts";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { cn, formatDuration } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { StatusDot } from "@/ui/status-dot";
import { Tip } from "@/ui/tooltip";
import { PEER_DOT, PEER_STATUS_LABEL, PEER_STATUS_VARIANT } from "./format";
import { t, tr } from "@/i18n";

export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// Non-secure context fallback: a hidden textarea + execCommand.
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
		document.body.append(ta);
		ta.select();
		try {
			return document.execCommand("copy");
		} catch {
			return false;
		} finally {
			ta.remove();
		}
	}
}

export function useCopy(): { copied: boolean; copy: (text: string, what?: string) => Promise<void> } {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	return {
		copied,
		copy: async (text, what) => {
			if (await copyText(text)) {
				setCopied(true);
				if (what) toast.success(t("{what} copied", { what }));
			} else toast.error(t("Could not access the clipboard — select the text and copy it manually"));
		},
	};
}

/** Icon-only copy button (≥44 px on touch). */
export function CopyIconButton({ value, label, className }: { value: string; label: string; className?: string }) {
	const { copied, copy } = useCopy();
	return (
		<Tip label={copied ? t("Copied") : label}>
			<Button variant="ghost" size="icon-sm" aria-label={label} className={className} onClick={() => void copy(value)}>
				{copied ? <Check className="text-success" /> : <Copy />}
			</Button>
		</Tip>
	);
}

/** A large, selectable, copyable block for values people have to read aloud or compare (fingerprints, codes). */
export function CopyBlock({
	label,
	value,
	display,
	variant = "fingerprint",
	className,
	children,
}: {
	label: string;
	/** What lands on the clipboard. */
	value: string;
	display: string;
	variant?: "fingerprint" | "code";
	className?: string;
	children?: ReactNode;
}) {
	const { copied, copy } = useCopy();
	return (
		<div className={cn("flex flex-col gap-2 rounded-xl bg-surface-2 p-3.5 shadow-[inset_0_0_0_1px_var(--border-strong)]", className)}>
			<div className="flex items-center justify-between gap-2">
				<span className="text-2xs font-semibold uppercase tracking-wider text-subtle">{label}</span>
				<Button size="sm" variant="outline" onClick={() => void copy(value)} aria-label={t("Copy {label}", { label: label.toLowerCase() })}>
					{copied ? <Check className="text-success" /> : <Copy />}
					{copied ? t("Copied") : t("Copy")}
				</Button>
			</div>
			<p
				data-testid={`${variant}-value`}
				className={cn(
					"select-all break-all font-mono text-foreground",
					variant === "code" ? "py-1 text-center text-[2.1rem] font-semibold leading-tight tracking-[0.18em] sm:text-4xl" : "text-[15px] leading-relaxed tracking-wide sm:text-base",
				)}
			>
				{display}
			</p>
			{children}
		</div>
	);
}

export function PeerStatusBadge({ status, className }: { status: PeerStatus; className?: string }) {
	return (
		<Badge variant={PEER_STATUS_VARIANT[status]} className={cn("gap-1.5", className)}>
			<StatusDot status={PEER_DOT[status]} label={tr(PEER_STATUS_LABEL[status])} className="size-1.5 [&>span]:size-1.5" />
			{tr(PEER_STATUS_LABEL[status])}
		</Badge>
	);
}

/** "Expires in 7m 12s" — re-renders only this leaf once per second. */
export function Countdown({ until, onExpire }: { until: string; onExpire?: () => void }) {
	const [now, setNow] = useState(() => Date.now());
	const end = Date.parse(until);
	const left = end - now;
	const expired = left <= 0;
	useEffect(() => {
		if (expired) {
			onExpire?.();
			return;
		}
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [expired, onExpire]);
	if (expired) return <span className="text-danger">{t("expired")}</span>;
	return <span className="tabular">{formatDuration(Math.max(0, Math.floor(left / 1000)) * 1000)}</span>;
}
