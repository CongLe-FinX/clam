import * as T from "@radix-ui/react-tooltip";
import { useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
	anchor: HTMLElement;
	label: ReactNode;
	side?: "top" | "right" | "bottom" | "left";
	shortcut?: string;
	onClose: () => void;
}

/** The open tooltip: Radix positions it against a fixed, invisible box laid over the trigger's rectangle. */
export default function TipOverlay({ anchor, label, side, shortcut, onClose }: Props) {
	const [rect, setRect] = useState(() => anchor.getBoundingClientRect());
	useLayoutEffect(() => {
		const update = () => setRect(anchor.getBoundingClientRect());
		update();
		addEventListener("scroll", update, true);
		addEventListener("resize", update);
		return () => {
			removeEventListener("scroll", update, true);
			removeEventListener("resize", update);
		};
	}, [anchor]);
	return (
		<T.Provider delayDuration={0}>
			<T.Root open onOpenChange={(o) => !o && onClose()}>
				<T.Trigger asChild>
					<span aria-hidden className="pointer-events-none fixed" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />
				</T.Trigger>
				<T.Portal>
					<T.Content
						side={side}
						sideOffset={6}
						className={cn("clam-pop z-[80] max-w-xs rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background")}
					>
						{label}
						{shortcut ? <span className="ml-1.5 font-mono opacity-60">{shortcut}</span> : null}
					</T.Content>
				</T.Portal>
			</T.Root>
		</T.Provider>
	);
}
