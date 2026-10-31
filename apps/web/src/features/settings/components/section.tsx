import type { ReactNode } from "react";
import { AlertTriangle, Copy, Check } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/card";

export function SettingsSection({
	title,
	description,
	actions,
	children,
	className,
}: {
	title: string;
	description?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<Card className={cn("min-w-0", className)}>
			<CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
				<div className="min-w-0">
					<CardTitle className="text-sm">{title}</CardTitle>
					{description && <CardDescription className="mt-1 text-xs leading-relaxed">{description}</CardDescription>}
				</div>
				{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
			</CardHeader>
			<CardContent>{children}</CardContent>
		</Card>
	);
}

export function PageIntro({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
	return (
		<header className="mb-4 flex flex-wrap items-start justify-between gap-3 px-4 pt-4 md:px-0 md:pt-0">
			<div className="min-w-0">
				<h2 className="text-lg font-semibold tracking-tight">{title}</h2>
				{description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
			</div>
			{actions}
		</header>
	);
}

/** Wrapper for page bodies: matches the horizontal padding of PageIntro on mobile. */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn("space-y-4 px-4 pb-8 md:px-0", className)}>{children}</div>;
}

export function InlineError({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
	return (
		<div role="alert" className="flex items-start gap-3 rounded-md border border-danger/30 bg-danger/10 p-3 text-sm">
			<AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
			<div className="min-w-0 flex-1">
				{title && <div className="font-medium text-danger">{title}</div>}
				<div className="break-words text-danger/90">{errorMessage(error)}</div>
			</div>
			{onRetry && (
				<Button size="sm" variant="outline" onClick={onRetry}>
					Retry
				</Button>
			)}
		</div>
	);
}

export function KeyValue({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
	return (
		<div className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-4">
			<dt className="w-44 shrink-0 text-xs text-muted-foreground">{label}</dt>
			<dd className={cn("min-w-0 flex-1 break-all text-sm", mono && "font-mono text-xs")}>{children}</dd>
		</div>
	);
}

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
	const [done, setDone] = useState(false);
	return (
		<Button
			size="sm"
			variant="outline"
			className={className}
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(value);
					setDone(true);
					setTimeout(() => setDone(false), 1500);
				} catch {
					/* clipboard unavailable (non-secure context); selection fallback is left to the user */
				}
			}}
		>
			{done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
			{done ? "Copied" : label}
		</Button>
	);
}
