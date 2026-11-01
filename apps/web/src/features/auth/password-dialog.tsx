import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { t } from "@/i18n";
import { ApiError, errorText } from "@/lib/api";
import { Button } from "@/ui/button";
import { GrabHandle } from "@/ui/grab-handle";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Field } from "@/ui/field";
import { Input } from "@/ui/input";

/**
 * Asks for the owner password and hands it to `onSubmit`; a rejected promise keeps the dialog open and shows why
 * (a wrong password reads as such; a lockout shows the server's message). Used for the remote step-up and for
 * switching a machine tool on from a signed-in remote session.
 */
export function PasswordDialog({
	open,
	onOpenChange,
	title,
	description,
	risk,
	confirmLabel,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: ReactNode;
	/** A short, plain-language warning shown above the field. */
	risk?: ReactNode;
	confirmLabel: string;
	onSubmit: (password: string) => Promise<unknown>;
}) {
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	useEffect(() => {
		if (!open) {
			setPassword("");
			setError(null);
			setPending(false);
		}
	}, [open]);

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (!password || pending) return;
		setPending(true);
		setError(null);
		try {
			await onSubmit(password);
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof ApiError && (err.code === "invalid_credentials" || err.code === "invalid_current_password") ? t("That password is not correct.") : errorText(err));
			setPending(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent sheetOnMobile className="max-w-sm">
				<GrabHandle onClose={() => onOpenChange(false)} className="sm:hidden" />
				<form onSubmit={submit} className="flex flex-col gap-4" noValidate>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						{description ? <DialogDescription>{description}</DialogDescription> : null}
					</DialogHeader>
					{risk ? (
						<p className="flex items-start gap-2.5 rounded-lg bg-warning/10 p-3 text-[13px] leading-relaxed text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warning)_30%,transparent)]">
							<ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
							<span>{risk}</span>
						</p>
					) : null}
					<input type="text" name="username" autoComplete="username" value="owner" readOnly hidden />
					<Field label={t("Owner password")} error={error}>
						{(id) => <Input id={id} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} disabled={pending} aria-invalid={error ? true : undefined} className="text-base sm:text-[13px]" />}
					</Field>
					<DialogFooter>
						<Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
							{t("Cancel")}
						</Button>
						<Button variant="primary" type="submit" loading={pending} disabled={!password}>
							{confirmLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
