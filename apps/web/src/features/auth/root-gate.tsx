import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";
import { AppShell } from "@/app/shell/app-shell.tsx";
import { authGate } from "./gate.ts";

/** Root layout: the app shell for owner screens, a bare outlet for `/login`, and the redirect to `/login` on 401. */
export function RootGate() {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const href = useRouterState({ select: (s) => s.location.href });
	const required = useSyncExternalStore(authGate.subscribe, authGate.isRequired, authGate.isRequired);
	const navigate = useNavigate();
	const onLogin = pathname === "/login";

	useEffect(() => {
		if (required && !onLogin) void navigate({ to: "/login", search: { redirect: href }, replace: true });
	}, [required, onLogin, href, navigate]);

	if (onLogin) return <Outlet />;
	if (required) return null;
	return <AppShell />;
}
