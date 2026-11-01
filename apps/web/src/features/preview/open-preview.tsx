import { ExternalLink } from "lucide-react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/ui/button";
import { usePreviewOpener } from "./api.ts";
import { parseLocalApp } from "./local-url.ts";

/**
 * "Open preview ↗": the local web app in the user's own browser (a new tab). Dependency-light so chat links and port chips can carry it.
 * Give either a `port` (+ optional `path`) or an `href` (`http://localhost:<port>/…`).
 */
export function OpenPreview({ port, path, href, className, size = "icon-sm" }: { port?: number; path?: string; href?: string; className?: string; size?: "icon-sm" | "icon" }) {
	const preview = usePreviewOpener();
	const target = port !== undefined ? { port, path: path ?? "/" } : href ? parseLocalApp(href) : null;
	if (!target) return null;
	const label = t("Open preview in your browser");
	return (
		<button
			type="button"
			aria-label={label}
			title={preview.why ?? label}
			disabled={!preview.canOpen || preview.pending}
			onClick={() => preview.open(target.port, target.path)}
			className={cn(buttonVariants({ variant: "ghost", size }), "shrink-0", className)}
		>
			<ExternalLink />
		</button>
	);
}
