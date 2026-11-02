import { toast } from "sonner";
import { t } from "@/i18n";

/** At most one look at the server's build per this interval, however often the tab comes back. */
const MIN_INTERVAL_MS = 60_000;

/** The entry script of a page (`/assets/index-<hash>.js`): it changes with every build. */
function entryOf(html: string): string | null {
	return /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1] ?? null;
}

/**
 * A tab keeps running the build it loaded. After a deploy it would keep the old behaviour until reloaded, so whenever the tab
 * becomes visible again the served page is compared with the running one; a different build offers a reload (never forced:
 * the user may be mid-sentence).
 */
export function watchForNewBuild(): void {
	const running = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src") ?? null;
	if (!running) return; // the dev server: no hashed entry to compare
	let lastCheck = Date.now();
	let offered = false;
	const check = async () => {
		if (offered || document.visibilityState !== "visible" || Date.now() - lastCheck < MIN_INTERVAL_MS) return;
		lastCheck = Date.now();
		try {
			const res = await fetch("/", { cache: "no-store", headers: { accept: "text/html" } });
			const served = res.ok ? entryOf(await res.text()) : null;
			if (!served || served === running) return;
			offered = true;
			toast.info(t("A new version of CL Agent Mesh is available"), {
				duration: Number.POSITIVE_INFINITY,
				action: { label: t("Reload"), onClick: () => location.reload() },
			});
		} catch {
			// offline or the server is restarting: look again next time
		}
	};
	document.addEventListener("visibilitychange", () => void check());
	addEventListener("focus", () => void check());
	setInterval(() => void check(), 10 * MIN_INTERVAL_MS);
}
