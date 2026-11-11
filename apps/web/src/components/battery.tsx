import type { SystemBattery } from "@clam/contracts";
import { Zap } from "lucide-react";
import { t } from "@/i18n";
import { cn, formatDuration } from "@/lib/utils";

/** The battery's state in words, without the charge: "charging · full in 20 min", "3 h 7 min left", "plugged in". */
export function batteryState(b: SystemBattery): string {
	const time = b.minutesRemaining === null ? null : formatDuration(b.minutesRemaining * 60_000);
	if (b.charging) return time ? t("charging · full in {time}", { time }) : t("charging");
	if (b.pluggedIn) return t("plugged in");
	return time ? t("{time} left", { time }) : t("on battery");
}

/** The gauge's label and tooltip: charge and state. */
export function batteryLabel(b: SystemBattery): string {
	return t("Battery {percent}% · {state}", { percent: Math.round(b.percent), state: batteryState(b) });
}

const SIZE = {
	sm: { body: "h-[14px] w-[30px] rounded-[4.5px]", text: "text-[10px]", nub: "h-[5px] w-[1.5px]", bolt: "size-2.5" },
	md: { body: "h-[17px] w-[35px] rounded-[5px]", text: "text-[12px]", nub: "h-[6px] w-[2px]", bolt: "size-3" },
} as const;

/**
 * An iOS-style battery: a rounded body whose fill is the charge, the percentage set inside it and knocked out of the fill (the digits
 * change colour exactly where the fill ends), a small terminal nub, and a bolt while charging. The fill is green while charging or
 * full on power, red at 20 % or less on battery, otherwise the text colour, like the status bar of an iPhone.
 */
export function BatteryGauge({ battery, size = "sm", className }: { battery: SystemBattery; size?: keyof typeof SIZE; className?: string }) {
	const percent = Math.max(0, Math.min(100, Math.round(battery.percent)));
	const s = SIZE[size];
	const tone = battery.charging || (battery.pluggedIn && percent >= 95) ? "charging" : percent <= 20 ? "low" : "normal";
	const fill = tone === "charging" ? "bg-success" : tone === "low" ? "bg-danger" : "bg-foreground";
	// Digits over the fill: white on green/red, the page colour on the text-coloured fill.
	const onFill = tone === "normal" ? "text-background" : "text-white";
	const label = batteryLabel(battery);
	const digits = (
		<span aria-hidden className={cn("absolute inset-0 grid place-items-center font-semibold leading-none tracking-[-0.03em] tabular-nums", s.text)}>
			{percent}
		</span>
	);
	return (
		<span role="img" aria-label={label} title={label} className={cn("inline-flex shrink-0 items-center gap-px", className)}>
			<span className={cn("relative overflow-hidden bg-foreground/20", s.body)}>
				<span className={cn("contents", tone === "low" ? "text-danger" : "text-foreground")}>{digits}</span>
				<span
					className={cn("absolute inset-0 transition-[clip-path] duration-500 ease-out", fill, onFill)}
					style={{ clipPath: `inset(0 ${100 - percent}% 0 0)` }}
				>
					{digits}
				</span>
			</span>
			<span aria-hidden className={cn("rounded-r-[1px] bg-foreground/30", s.nub)} />
			{battery.charging ? <Zap aria-hidden className={cn("ml-0.5 fill-current text-success", s.bolt)} strokeWidth={0} /> : null}
		</span>
	);
}
