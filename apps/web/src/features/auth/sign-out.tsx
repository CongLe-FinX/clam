import { routes } from "@clam/contracts";
import { useRouter } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, ApiError, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Tip } from "@/ui/tooltip";
import { authGate } from "./gate.ts";
import { accessKey, useAccess, useDropOwnerData } from "./hooks.ts";
import { useQueryClient } from "@tanstack/react-query";

/** Ends the remote session and returns to the login page. */
export function useSignOut() {
	const qc = useQueryClient();
	const router = useRouter();
	const drop = useDropOwnerData();
	const [pending, setPending] = useState(false);
	const signOut = async () => {
		setPending(true);
		try {
			await api.post(routes.accessLogout);
		} catch (e) {
			// Already signed out is fine; anything else keeps the user signed in.
			if (!(e instanceof ApiError && e.code === "auth_required")) {
				toast.error(errorMessage(e));
				setPending(false);
				return;
			}
		}
		drop();
		qc.removeQueries({ queryKey: accessKey });
		authGate.require();
		void router.navigate({ to: "/login", replace: true });
		setPending(false);
	};
	return { signOut, pending };
}

/** Shell menu entry; renders nothing on the loopback UI (no login there). */
export function SignOutItem({ compact, className }: { compact?: boolean; className?: string }) {
	const access = useAccess();
	const { signOut, pending } = useSignOut();
	if (access.data?.via !== "remote" || !access.data.signedIn) return null;
	if (compact)
		return (
			<Tip label="Sign out" side="right">
				<Button variant="ghost" size="icon" className={className} loading={pending} onClick={signOut} aria-label="Sign out">
					<LogOut />
				</Button>
			</Tip>
		);
	return (
		<button
			type="button"
			onClick={signOut}
			disabled={pending}
			className={cn("flex h-7 w-full items-center gap-1.5 rounded-md px-1 text-2xs text-subtle outline-none transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:text-foreground disabled:opacity-50", className)}
		>
			<LogOut className="size-3" />
			Sign out of this machine
		</button>
	);
}
