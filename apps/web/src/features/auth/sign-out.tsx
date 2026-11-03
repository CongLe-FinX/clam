import { routes } from "@clam/contracts";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { api, ApiError, errorText } from "@/lib/api";
import { authGate } from "./gate.ts";
import { accessKey, useDropOwnerData } from "./hooks.ts";
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
				toast.error(errorText(e));
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
