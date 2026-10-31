import { Toaster } from "sonner";

/** The toast host — a lazy chunk; `toast()` itself is shared with every page that raises one. */
export default function AppToaster({ theme, mobile }: { theme: "light" | "dark"; mobile: boolean }) {
	return (
		<Toaster
			theme={theme}
			position={mobile ? "top-center" : "bottom-right"}
			offset={mobile ? 12 : 16}
			toastOptions={{ classNames: { toast: "!rounded-xl !border-border-strong !bg-overlay !text-foreground !shadow-pop !text-[13px]" } }}
		/>
	);
}
