import { useSyncExternalStore } from "react";
import { t } from "@/i18n";
import { browserStats } from "./stats.ts";

const fmt = (v: number | null, unit: string, digits = 0): string => (v === null ? "—" : `${v.toFixed(digits)} ${unit}`);

/** Corner readout of the live viewer numbers (same values as `window.__clamBrowserStats`). */
export function DebugOverlay() {
	const s = useSyncExternalStore(browserStats.subscribe, browserStats.getSnapshot, browserStats.getSnapshot);
	return (
		<dl aria-label={t("Browser stream statistics")} className="pointer-events-none absolute left-2 top-2 z-10 grid grid-cols-[auto_auto] gap-x-3 rounded-lg bg-black/75 px-2.5 py-1.5 font-mono text-[11px] leading-4 text-white shadow-pop">
			<dt className="text-white/60">{t("FPS")}</dt>
			<dd className="text-right tabular">{s.fps.toFixed(1)}</dd>
			<dt className="text-white/60">{t("Stream")}</dt>
			<dd className="text-right tabular">{`${s.kbps.toFixed(0)} KB/s`}</dd>
			<dt className="text-white/60">{t("Frame")}</dt>
			<dd className="text-right tabular">{s.width ? `${s.width}×${s.height}` : "—"}</dd>
			<dt className="text-white/60">{t("Round trip")}</dt>
			<dd className="text-right tabular">{fmt(s.rttMs, "ms")}</dd>
			<dt className="text-white/60">{t("Input → frame")}</dt>
			<dd className="text-right tabular">{fmt(s.inputToFrameMs, "ms")}</dd>
		</dl>
	);
}
