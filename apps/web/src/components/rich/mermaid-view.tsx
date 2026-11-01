import { useEffect, useState } from "react";
import { t } from "@/i18n";
import { useResolvedTheme } from "@/lib/theme";

/** Renders one ```mermaid diagram. Lazy chunk. `securityLevel: "strict"` makes mermaid sanitise labels and the SVG with its own DOMPurify. */

type Mermaid = typeof import("mermaid").default;
let mermaidP: Promise<Mermaid> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;
const svgCache = new Map<string, string>();

const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Mermaid's colour maths (khroma) cannot take `rgb(… / alpha)` tokens: flatten any CSS colour to opaque #rrggbb over `over`. */
function flat(color: string, over = "#ffffff"): string {
	const ctx = document.createElement("canvas").getContext("2d");
	if (!ctx) return color;
	ctx.canvas.width = ctx.canvas.height = 1;
	ctx.fillStyle = over;
	ctx.fillRect(0, 0, 1, 1);
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, 1, 1);
	const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
	return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function palette() {
	const card = flat(css("--surface-1"));
	const tok = (n: string) => flat(css(n), card);
	return {
		card,
		subtle: tok("--surface-2"),
		raised: tok("--surface-3"),
		line: tok("--border-strong"),
		hairline: tok("--border"),
		fg: tok("--foreground"),
		muted: tok("--muted-foreground"),
		dim: tok("--subtle"),
		chart: Array.from({ length: 8 }, (_, i) => tok(`--chart-${i + 1}`)),
	};
}

function themeVariables(dark: boolean) {
	const p = palette();
	const c = p.chart;
	const font = css("--font-sans") || "sans-serif";
	return {
		darkMode: dark,
		background: "transparent",
		dropShadow: "none",
		fontFamily: font,
		fontSize: "13px",
		primaryColor: p.card,
		primaryTextColor: p.fg,
		primaryBorderColor: p.line,
		secondaryColor: p.subtle,
		secondaryTextColor: p.fg,
		secondaryBorderColor: p.line,
		tertiaryColor: p.subtle,
		tertiaryTextColor: p.fg,
		tertiaryBorderColor: p.line,
		lineColor: p.muted,
		textColor: p.fg,
		mainBkg: p.card,
		nodeBorder: p.line,
		nodeTextColor: p.fg,
		clusterBkg: p.subtle,
		clusterBorder: p.line,
		edgeLabelBackground: p.card,
		titleColor: p.fg,
		noteBkgColor: p.subtle,
		noteTextColor: p.fg,
		noteBorderColor: p.line,
		actorBkg: p.card,
		actorBorder: p.line,
		actorTextColor: p.fg,
		actorLineColor: p.dim,
		signalColor: p.muted,
		signalTextColor: p.fg,
		labelBoxBkgColor: p.subtle,
		labelBoxBorderColor: p.line,
		labelTextColor: p.fg,
		loopTextColor: p.fg,
		activationBkgColor: p.raised,
		activationBorderColor: p.line,
		// class / state / er
		classText: p.fg,
		altBackground: p.subtle,
		attributeBackgroundColorOdd: p.card,
		attributeBackgroundColorEven: p.subtle,
		// gantt
		gridColor: p.hairline,
		sectionBkgColor: p.subtle,
		altSectionBkgColor: p.card,
		sectionBkgColor2: p.subtle,
		taskBkgColor: c[0],
		taskBorderColor: c[0],
		taskTextColor: "#ffffff",
		taskTextLightColor: "#ffffff",
		taskTextDarkColor: p.fg,
		taskTextOutsideColor: p.fg,
		activeTaskBkgColor: c[3],
		activeTaskBorderColor: c[3],
		doneTaskBkgColor: c[7],
		doneTaskBorderColor: c[7],
		critBkgColor: c[4],
		critBorderColor: c[4],
		todayLineColor: c[4],
		// pie
		pie1: c[0], pie2: c[1], pie3: c[2], pie4: c[3], pie5: c[4], pie6: c[5], pie7: c[6], pie8: c[7],
		pieStrokeColor: p.card,
		pieStrokeWidth: "2px",
		pieOuterStrokeWidth: "0px",
		pieTitleTextColor: p.fg,
		pieSectionTextColor: "#ffffff",
		pieLegendTextColor: p.fg,
		xyChart: {
			backgroundColor: "transparent",
			titleColor: p.fg,
			xAxisLabelColor: p.muted,
			xAxisTitleColor: p.muted,
			xAxisTickColor: p.line,
			xAxisLineColor: p.line,
			yAxisLabelColor: p.muted,
			yAxisTitleColor: p.muted,
			yAxisTickColor: p.line,
			yAxisLineColor: p.line,
			plotColorPalette: c.join(","),
		},
	};
}

/** Squared-off, hairline nodes in the app's UI font; no glow or shadow. */
const THEME_CSS = `
.node rect, .node polygon, .node circle, .node ellipse, .node path { stroke-width: 1px; filter: none; }
.node rect, .basic.label-container, rect.basic { rx: 8px; ry: 8px; }
.cluster rect { rx: 10px; ry: 10px; stroke-width: 1px; }
.actor { stroke-width: 1px; rx: 8px; ry: 8px; }
.edgePath .path, .flowchart-link { stroke-width: 1.25px; }
.label, .nodeLabel, .edgeLabel, .labelText, .messageText, .actor text, text { font-family: var(--font-sans), Inter, system-ui, sans-serif; font-size: 13px; }
.edgeLabel, .edgeLabel p { background-color: transparent; }
`;

const load = (): Promise<Mermaid> => (mermaidP ??= import("mermaid").then((m) => m.default));

function hash(s: string): string {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return (h >>> 0).toString(36);
}

/** Renders serially (mermaid keeps global state) and caches by theme+source so remounts never re-run layout. */
function renderDiagram(code: string, dark: boolean): Promise<string> {
	const key = `${dark ? "d" : "l"}${hash(code)}${code.length}`;
	const hit = svgCache.get(key);
	if (hit) return Promise.resolve(hit);
	const job = queue.then(async () => {
		const mermaid = await load();
		mermaid.initialize({
			startOnLoad: false,
			securityLevel: "strict",
			theme: "base",
			themeVariables: themeVariables(dark),
			themeCSS: THEME_CSS,
			fontFamily: css("--font-sans") || "sans-serif",
			suppressErrorRendering: true,
			flowchart: { htmlLabels: true, useMaxWidth: true },
			maxTextSize: 60_000,
		});
		const id = `clam-mmd-${++seq}`;
		try {
			const { svg } = await mermaid.render(id, code);
			if (svgCache.size > 60) svgCache.clear();
			svgCache.set(key, svg);
			return svg;
		} finally {
			document.getElementById(id)?.remove();
			document.getElementById(`d${id}`)?.remove();
		}
	});
	queue = job.catch(() => undefined);
	return job;
}

export default function MermaidView({ code }: { code: string }) {
	const dark = useResolvedTheme() === "dark";
	const [state, setState] = useState<{ svg?: string; error?: string }>({});
	useEffect(() => {
		let alive = true;
		renderDiagram(code, dark).then(
			(svg) => alive && setState({ svg }),
			(e: unknown) => alive && setState({ error: e instanceof Error ? e.message : String(e) }),
		);
		return () => {
			alive = false;
		};
	}, [code, dark]);
	if (state.error) throw new Error(state.error.split("\n").slice(0, 4).join("\n"));
	if (!state.svg) return <div className="h-32 animate-pulse rounded-lg bg-surface-2" aria-label={t("Rendering diagram")} role="status" />;
	// The SVG comes from mermaid's strict mode, which sanitises it with DOMPurify before returning.
	return <div className="clam-mermaid scrollbar-thin overflow-x-auto" role="img" aria-label={t("Diagram")} dangerouslySetInnerHTML={{ __html: state.svg }} />;
}
