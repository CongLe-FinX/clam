import { Code2, Eye } from "lucide-react";
import { Component, lazy, memo, type ReactNode, Suspense, useState } from "react";
import { CodeBlock, CopyButton } from "../code-block.tsx";
import { cn } from "@/lib/utils";
import { msg, t, tr, type Msg } from "@/i18n";

const MermaidView = lazy(() => import("./mermaid-view.tsx"));
const ChartView = lazy(() => import("./chart.tsx"));

export type RichFenceKind = "mermaid" | "chart";

class Boundary extends Component<{ code: string; lang: string; children: ReactNode }, { error: string | null }> {
	override state = { error: null as string | null };
	static getDerivedStateFromError(e: unknown) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
	override componentDidUpdate(prev: { code: string }) {
		if (prev.code !== this.props.code && this.state.error) this.setState({ error: null });
	}
	override render() {
		if (this.state.error === null) return this.props.children;
		return (
			<div className="flex flex-col gap-2">
				<p role="alert" className="whitespace-pre-wrap break-words rounded-md bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
					{this.props.lang === "chart" ? t("Couldn’t render this chart: {error}", { error: this.state.error }) : t("Couldn’t render this diagram: {error}", { error: this.state.error })}
				</p>
				<CodeBlock code={this.props.code} lang={this.props.lang === "chart" ? "json" : "text"} maxHeight={300} />
			</div>
		);
	}
}

const LABEL: Record<RichFenceKind, Msg> = { mermaid: msg("Diagram"), chart: msg("Chart") };

/** A closed ```mermaid / ```chart fence as a card: rendered view or its source. Memoised on (kind, code) so re-renders never redraw. */
export const RichFence = memo(function RichFence({ kind, code, className }: { kind: RichFenceKind; code: string; className?: string }) {
	const [source, setSource] = useState(false);
	return (
		<figure className={cn("rich-card overflow-hidden rounded-lg bg-surface-1 shadow-[inset_0_0_0_1px_var(--border-strong)]", className)}>
			<figcaption className="flex min-h-8 items-center justify-between gap-2 border-b bg-surface-2 px-3 text-2xs text-subtle coarse:min-h-11">
				<span className="font-medium">{tr(LABEL[kind])}</span>
				<span className="flex items-center gap-0.5">
					<button
						type="button"
						aria-pressed={source}
						onClick={() => setSource((v) => !v)}
						className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 outline-none transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring coarse:h-10 coarse:px-2.5"
					>
						{source ? <Eye aria-hidden className="size-3.5" /> : <Code2 aria-hidden className="size-3.5" />}
						{source ? t("View result") : t("View source")}
					</button>
					<CopyButton text={code} label={t("Copy source")} className="size-6" />
				</span>
			</figcaption>
			<div className="p-3">
				{source ? (
					<CodeBlock code={code} lang={kind === "chart" ? "json" : "text"} maxHeight={360} />
				) : (
					<Boundary code={code} lang={kind}>
						<Suspense fallback={<div role="status" aria-label={t("Loading")} className="h-40 animate-pulse rounded-lg bg-surface-2" />}>
							{kind === "mermaid" ? <MermaidView code={code} /> : <ChartView source={code} />}
						</Suspense>
					</Boundary>
				)}
			</div>
		</figure>
	);
});
