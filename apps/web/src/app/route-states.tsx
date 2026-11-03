import { Link, type ErrorComponentProps } from "@tanstack/react-router";
import { Compass, TriangleAlert } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { t } from "@/i18n";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";

export function NotFound() {
	return (
		<EmptyState
			className="h-full"
			icon={Compass}
			title={t("Page not found")}
			description={t("This route does not exist in CL Agent Mesh.")}
			action={
				<Button asChild variant="outline">
					<Link to="/">{t("Go to Overview")}</Link>
				</Button>
			}
		/>
	);
}

/**
 * A lazy screen's code did not load (a rebuild replaced its chunk, the server was restarting, the access proxy redirected).
 * `lazyRouteComponent` keeps that error for the life of the page and never re-imports, so `reset` would show this screen
 * again: only a reload retries it (and picks up the current build).
 */
function isChunkLoadError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : "";
	return /^(Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS)/.test(message);
}

export function RouteError({ error, reset }: ErrorComponentProps) {
	return (
		<EmptyState
			className="h-full"
			icon={TriangleAlert}
			title={t("This screen failed to load")}
			description={errorMessage(error)}
			action={
				<Button variant="outline" onClick={isChunkLoadError(error) ? () => location.reload() : reset}>
					{t("Try again")}
				</Button>
			}
		/>
	);
}
