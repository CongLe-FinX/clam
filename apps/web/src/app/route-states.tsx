import { Link, type ErrorComponentProps } from "@tanstack/react-router";
import { Compass, TriangleAlert } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";

export function NotFound() {
	return (
		<EmptyState
			className="h-full"
			icon={Compass}
			title="Page not found"
			description="This route does not exist in CL Agent Mesh."
			action={
				<Button asChild variant="outline">
					<Link to="/">Go to Overview</Link>
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
			title="This screen failed to load"
			description={errorMessage(error)}
			action={
				<Button variant="outline" onClick={reset}>
					Try again
				</Button>
			}
		/>
	);
}
