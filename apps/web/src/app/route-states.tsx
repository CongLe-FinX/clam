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

export function RouteError({ error, reset }: ErrorComponentProps) {
	return (
		<EmptyState
			className="h-full"
			icon={TriangleAlert}
			title={t("This screen failed to load")}
			description={errorMessage(error)}
			action={
				<Button variant="outline" onClick={reset}>
					{t("Try again")}
				</Button>
			}
		/>
	);
}
