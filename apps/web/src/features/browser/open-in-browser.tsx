import { Link } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { buttonVariants } from "@/ui/button";
import { cn } from "@/lib/utils";

const LOCAL_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true, "0.0.0.0": true };

/** http(s) URL pointing at this machine's own loopback with an explicit port, e.g. `http://localhost:5173/app`. */
export function isLocalAppUrl(href: string): boolean {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return false;
	}
	return (url.protocol === "http:" || url.protocol === "https:") && url.port !== "" && LOCAL_HOSTS[url.hostname] === true;
}

/** Router target that opens `url` in a new tab of this machine's Browser (`/browser?url=…`). */
export function browserHrefFor(url: string): { to: "/browser"; search: { url: string } } {
	return { to: "/browser", search: { url } };
}

/** Ghost icon link: "Open in this machine's browser". Deliberately dependency-light (router Link + one icon). */
export function OpenInMachineBrowser({ href, className }: { href: string; className?: string }) {
	return (
		<Link {...browserHrefFor(href)} aria-label="Open in this machine's browser" title="Open in this machine's browser" className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), className)}>
			<Globe />
		</Link>
	);
}
