import { isLocalAppUrl, OpenInMachineBrowser } from "@/features/browser/open-in-browser.tsx";
import { OpenPreview } from "@/features/preview/open-preview.tsx";
import { createContext, memo, type MouseEvent, type ReactElement, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { type AssetResolver } from "./rich/assets.ts";
import { FileChip } from "./rich/file-chip.tsx";
import { FileTile } from "./rich/file-tile.tsx";
import { hasMath, loadedMath, loadMath, type MathPlugins, protectCurrency } from "./rich/math.ts";
import { type HtmlPlugins, loadedHtml, loadHtml } from "./rich/html.ts";
import { BrokenImageCard, RemoteBadge, RemoteImageCard, RichImage } from "./rich/rich-image.tsx";
import { RichFence } from "./rich/rich-fence.tsx";
import { CodeBlock } from "./code-block.tsx";
import { Info, Lightbulb, MessageSquareWarning, OctagonAlert, TriangleAlert } from "lucide-react";
import { msg, t, tr } from "@/i18n";

type Plugins = NonNullable<Options["remarkPlugins"]>;

/** Resolves relative paths in `![]()` / `[]()`; provided once by `Markdown`, read by the (module-level, stable) component overrides. */
const AssetsContext = createContext<AssetResolver | undefined>(undefined);
/** Opens another file of the same folder in place (the file viewer); absent in chat, where file links are chips. */
const OpenFileContext = createContext<((path: string) => void) | undefined>(undefined);
/** The source text of the block being rendered, so a fence's closing line can be checked from its machine offsets. */
const SourceContext = createContext("");

interface Pos {
	position?: { start: { offset?: number }; end: { offset?: number } };
}

/** A fence is complete when its last line is a closing fence of the same character and at least the opening length. */
function fenceClosed(src: string, node: Pos | undefined): boolean {
	const s = node?.position?.start.offset;
	const e = node?.position?.end.offset;
	if (s == null || e == null) return false;
	const lines = src.slice(s, e).split("\n");
	if (lines.length < 2) return false;
	const open = /^[\s>]*(`{3,}|~{3,})/.exec(lines[0] as string);
	const close = /^[\s>]*(`{3,}|~{3,})\s*$/.exec(lines[lines.length - 1] as string);
	if (!open || !close) return false;
	const o = open[1] as string;
	const c = close[1] as string;
	return c[0] === o[0] && c.length >= o.length;
}

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,/i;
const urlTransform: NonNullable<Options["urlTransform"]> = (url, key, node) => (key === "src" && node.tagName === "img" && DATA_IMAGE.test(url) ? url : defaultUrlTransform(url));

const isAbsolute = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");

interface HastNode {
	type: string;
	tagName?: string;
	value?: string;
	children?: HastNode[];
}
const IMG_WRAPPERS = new Set(["a", "em", "strong", "del"]);
const hasImage = (n: HastNode): boolean => n.children?.some((c) => c.type === "element" && (c.tagName === "img" || (IMG_WRAPPERS.has(c.tagName ?? "") && hasImage(c)))) ?? false;
const onlyImages = (n: HastNode): boolean =>
	n.children?.every((c) => (c.type === "text" && !(c.value ?? "").trim()) || (c.type === "element" && (c.tagName === "br" || c.tagName === "img" || (c.tagName === "a" && hasImage(c) && onlyImages(c))))) ?? false;
interface ImgNode extends HastNode {
	properties?: { src?: unknown };
	children?: ImgNode[];
}
const imageSources = (n: ImgNode): string[] => (n.tagName === "img" ? [String(n.properties?.src ?? "")] : (n.children ?? []).flatMap(imageSources));

/** Status badges (shields.io and SVG images on a remote host): a compact pill, not a full remote-image card per badge. */
const isBadge = (src: string): boolean => /^(https?:)?\/\/img\.shields\.io\//i.test(src) || /\.svg(?:[?#]|$)/i.test(src);

function Img({ src, alt, width }: { src?: string | Blob; alt?: string; width?: string | number }) {
	const assets = useContext(AssetsContext);
	if (typeof src !== "string" || !src) return null;
	const w = width == null ? undefined : String(width);
	if (DATA_IMAGE.test(src)) return <RichImage src={src} alt={alt} label={alt || t("Embedded image")} width={w} />;
	if (/^https?:\/\//i.test(src) || src.startsWith("//")) {
		const url = src.startsWith("//") ? `https:${src}` : src;
		return isBadge(src) ? <RemoteBadge src={url} alt={alt} /> : <RemoteImageCard src={url} alt={alt} />;
	}
	const file = assets?.resolve(src);
	if (!file) return <BrokenImageCard label={alt || src} detail={src} />;
	if (file.kind === "image") return <RichImage src={file.url} alt={alt || file.name} label={file.path ?? file.name} width={w} />;
	return <FileTile file={file} className="my-1" />;
}

/**
 * `#slug` links scroll to the heading (or the `id`/`name` an HTML block declared, which sanitizing prefixes with `user-content-`)
 * inside the same rendered document, never through the page URL: several documents can be on one page and the router owns the hash.
 */
function scrollToAnchor(event: MouseEvent<HTMLAnchorElement>, href: string): void {
	let id = href.slice(1);
	try {
		id = decodeURIComponent(id);
	} catch {
		/* keep as written */
	}
	const root = event.currentTarget.closest(".prose-clam");
	if (!root || !id) return;
	const target = root.querySelector(`[data-md-anchor="${CSS.escape(id)}"]`) ?? root.querySelector(`[id="${CSS.escape(id)}"], [id="${CSS.escape(`user-content-${id}`)}"]`);
	if (!target) return;
	event.preventDefault();
	target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

function Link({ href, children }: { href?: string; children?: ReactNode }) {
	const assets = useContext(AssetsContext);
	const openFile = useContext(OpenFileContext);
	if (!href) return <span>{children}</span>;
	if (href.startsWith("#"))
		return (
			<a href={href} onClick={(e) => scrollToAnchor(e, href)}>
				{children}
			</a>
		);
	if (isAbsolute(href)) {
		const link = <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
		return isLocalAppUrl(href) ? (
			<>
				{link}
				<OpenInMachineBrowser href={href} className="ml-1 align-middle" />
				<OpenPreview href={href} className="align-middle" />
			</>
		) : (
			link
		);
	}
	const file = assets?.resolve(href);
	if (file?.path && openFile) {
		const target = file.path;
		return (
			<a
				href={file.url}
				onClick={(e) => {
					e.preventDefault();
					openFile(target);
				}}
			>
				{children}
			</a>
		);
	}
	if (file) return <FileChip file={file}>{children}</FileChip>;
	return <span className="text-muted-foreground" title={href}>{children}</span>;
}

function Code({ className, children, node }: { className?: string; children?: ReactNode; node?: Pos }) {
	const src = useContext(SourceContext);
	const text = String(children ?? "");
	const m = /language-([\w+#-]+)/.exec(className ?? "");
	const isBlock = Boolean(m) || text.includes("\n");
	if (!isBlock) return <code className={className}>{children}</code>;
	const code = text.replace(/\n$/, "");
	const lang = m?.[1] ?? null;
	if (lang === "mermaid" || lang === "chart") {
		if (fenceClosed(src, node)) return <RichFence kind={lang} code={code} className="my-3" />;
		return <CodeBlock code={code} lang={lang === "chart" ? "json" : "text"} hint={t("rendering when complete")} className="my-3" />;
	}
	return <CodeBlock code={code} lang={lang} className="my-3" />;
}

const ALERTS = {
	note: { icon: Info, label: msg("Note") },
	tip: { icon: Lightbulb, label: msg("Tip") },
	important: { icon: MessageSquareWarning, label: msg("Important") },
	warning: { icon: TriangleAlert, label: msg("Warning") },
	caution: { icon: OctagonAlert, label: msg("Caution") },
} as const;
type AlertKind = keyof typeof ALERTS;

const components: Components = {
	pre: ({ children }) => <>{children}</>,
	code: Code,
	a: ({ href, children }) => <Link href={href}>{children}</Link>,
	blockquote({ node, children }) {
		const kind = node?.properties?.dataAlert as AlertKind | undefined;
		const alert = kind ? ALERTS[kind] : undefined;
		if (!alert) return <blockquote>{children}</blockquote>;
		const Icon = alert.icon;
		return (
			<div role="note" className={cn("md-alert", `md-alert-${kind}`)}>
				<p className="md-alert-title">
					<Icon aria-hidden className="size-4 shrink-0" />
					{tr(alert.label)}
				</p>
				{children}
			</div>
		);
	},
	img: ({ src, alt, width }) => <Img src={src} alt={alt} width={width} />,
	p({ node, children }) {
		// A row of badges stays a line of text (it may be centred); real pictures become a gallery or a mixed block.
		if (node && hasImage(node as HastNode) && !imageSources(node as HastNode).every(isBadge)) return <div className={cn(onlyImages(node as HastNode) ? "md-gallery rich-card" : "md-p")}>{children}</div>;
		const align = node?.properties?.align;
		return <p style={align === "center" || align === "right" || align === "left" ? { textAlign: align } : undefined}>{children}</p>;
	},
	table: ({ children }) => (
		<div className="md-table rich-card scrollbar-thin">
			<table>{children}</table>
		</div>
	),
	input: ({ type, checked }) => (type === "checkbox" ? <input type="checkbox" checked={Boolean(checked)} readOnly disabled aria-label={checked ? t("Done") : t("Not done")} /> : null),
};

const REMARK_BASE: Plugins = [remarkGfm];

interface MdNode {
	type: string;
	value?: string;
	children?: MdNode[];
}

/** Every single newline inside running text becomes a hard break (what remark-breaks does): text a person typed keeps its lines exactly. Code, inline code and fences are untouched. */
function remarkHardBreaks() {
	const walk = (node: MdNode): void => {
		if (!node.children) return;
		const out: MdNode[] = [];
		for (const child of node.children) {
			if (child.type === "text" && child.value?.includes("\n")) {
				child.value.split("\n").forEach((line, i) => {
					if (i > 0) out.push({ type: "break" });
					if (line) out.push({ type: "text", value: line });
				});
			} else {
				walk(child);
				out.push(child);
			}
		}
		node.children = out;
	};
	return (tree: MdNode) => walk(tree);
}
const REMARK_BREAKS: Plugins = [remarkGfm, remarkHardBreaks];

/**
 * Split into top-level blocks so settled blocks keep memoized output while the tail streams. A text with footnote or link-reference
 * definitions (`[^1]: …`, `[id]: url`) stays whole: definitions and their references must be parsed in one document.
 */
export function splitBlocks(src: string): string[] {
	if (/^ {0,3}\[[^\]\n]+\]:/m.test(src)) return [src];
	const lines = src.split("\n");
	const blocks: string[] = [];
	let cur: string[] = [];
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (f) {
			const marker = (f[1] as string)[0] as string;
			if (!fence) fence = marker;
			else if (fence === marker && /^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) fence = null;
		}
		cur.push(line);
		if (!fence && line.trim() === "") {
			const next = lines.slice(i + 1).find((l) => l.trim() !== "");
			if (next !== undefined && !/^\s/.test(next) && cur.some((l) => l.trim() !== "")) {
				blocks.push(cur.join("\n"));
				cur = [];
			}
		}
	}
	if (cur.length) blocks.push(cur.join("\n"));
	return blocks;
}

/** A plugin set that arrives once (module promise); until then the text renders without it, then upgrades in place. */
function useLazyPlugins<T>(needed: boolean, peek: () => T | null, load: () => Promise<T>): T | null {
	const [plugins, setPlugins] = useState<T | null>(() => (needed ? peek() : null));
	useEffect(() => {
		if (!needed || plugins) return;
		let alive = true;
		load().then((p) => alive && setPlugins(p), () => undefined);
		return () => {
			alive = false;
		};
	}, [needed, plugins, load]);
	return needed ? plugins : null;
}

interface HastTree {
	type: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: HastTree[];
}
const HEADING = /^h[1-6]$/;
const textOf = (n: HastTree): string => (n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(textOf).join(""));

const ALERT_MARK = /^\s*\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n|$)/i;

/**
 * GitHub alerts: a blockquote whose first line is only `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` becomes a
 * callout (`data-alert`); the marker line is removed. Anything else on that line keeps it a plain quote, as on GitHub.
 */
function rehypeAlerts() {
	return (tree: HastTree) => {
		const walk = (node: HastTree): void => {
			if (node.type === "element" && node.tagName === "blockquote") {
				const para = node.children?.find((c) => c.type === "element");
				const first = para?.tagName === "p" ? para.children?.[0] : undefined;
				const match = first?.type === "text" ? ALERT_MARK.exec(first.value ?? "") : null;
				if (para?.children && first && match) {
					first.value = (first.value ?? "").slice(match[0].length);
					// With hard breaks on, the marker's line ends in a <br> instead of a newline.
					if (first.value === "") para.children.shift();
					if (para.children[0]?.type === "element" && para.children[0].tagName === "br") para.children.shift();
					if (para.children.length === 0) node.children = node.children?.filter((c) => c !== para);
					node.properties = { ...node.properties, dataAlert: (match[1] as string).toLowerCase() };
				}
			}
			node.children?.forEach(walk);
		};
		walk(tree);
	};
}

/**
 * Every heading gets the slug GitHub would give it (`## How CLAM compares` → `how-clam-compares`, repeats get `-1`, `-2`), as
 * `data-md-anchor`: a table of contents written for GitHub (`[Install](#install)`) jumps to it. Not an `id`, which would collide
 * when two documents are on one page.
 */
function rehypeHeadingAnchors() {
	return (tree: HastTree) => {
		const seen = new Map<string, number>();
		const walk = (node: HastTree): void => {
			if (node.type === "element" && HEADING.test(node.tagName ?? "")) {
				const base = textOf(node).trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /g, "-");
				const n = seen.get(base) ?? 0;
				seen.set(base, n + 1);
				node.properties = { ...node.properties, dataMdAnchor: n === 0 ? base : `${base}-${n}` };
				return;
			}
			node.children?.forEach(walk);
		};
		walk(tree);
	};
}

/** Raw HTML worth parsing: a tag, a closing tag or a comment, outside of what is obviously prose. */
const HAS_HTML = /<(?:[a-z][\w-]*[\s/>]|\/[a-z]|!--)/i;

/**
 * Rendered blocks by their input, most recently used last. A virtualized chat unmounts a message when it scrolls away and mounts it again
 * when it comes back; parsing it again (remark, rehype, building the React elements) was most of the main-thread work of a scroll frame.
 * The cached elements read their contexts (assets, source text) when they render, so one tree is valid under any provider.
 */
const PARSED = new Map<string, ReactElement>();
const PARSED_MAX = 400;

const Block = memo(function Block({ text, breaks, html }: { text: string; breaks: boolean; html: boolean }) {
	const math = useLazyPlugins(useMemo(() => hasMath(text), [text]), loadedMath, loadMath);
	const wantsHtml = useMemo(() => html && HAS_HTML.test(text), [html, text]);
	const raw = useLazyPlugins<HtmlPlugins>(wantsHtml, loadedHtml, loadHtml);
	const tree = useMemo(() => {
		// Never flash the document's HTML as text while the parser loads.
		if (wantsHtml && !raw) return null;
		const source = math ? protectCurrency(text) : text;
		const key = `${breaks ? 1 : 0}${math ? 1 : 0}${raw ? 1 : 0}\u0000${source}`;
		const hit = PARSED.get(key);
		if (hit) {
			PARSED.delete(key);
			PARSED.set(key, hit);
			return hit;
		}
		const remark = [...(breaks ? REMARK_BREAKS : REMARK_BASE), ...(math?.remark ?? [])];
		const rehype = [...(raw?.rehype ?? []), rehypeAlerts, ...(math?.rehype ?? []), rehypeHeadingAnchors];
		// The synchronous renderer is a plain function without hooks: its result is an element tree that can be kept and mounted again.
		const made = ReactMarkdown({ children: source, remarkPlugins: remark, rehypePlugins: rehype, components, urlTransform });
		PARSED.set(key, made);
		if (PARSED.size > PARSED_MAX) PARSED.delete(PARSED.keys().next().value as string);
		return made;
	}, [text, breaks, math, raw, wantsHtml]);
	if (!tree) return null;
	return <SourceContext.Provider value={text}>{tree}</SourceContext.Provider>;
});

/**
 * `document`: a whole file (a README) rather than a chat message: it is parsed in one piece and its raw HTML (`<div align>`,
 * `<details>`, `<img width>`, `<table>`) renders, sanitized with GitHub's rules. Chat text never does: an agent writing
 * `the <Composer> component` must not lose the word. `onOpenFile`: links to other files of the folder open there (the file viewer
 * switches to them) instead of downloading.
 */
function Markdown({ text, assets, breaks = false, document = false, onOpenFile }: { text: string; assets?: AssetResolver; breaks?: boolean; document?: boolean; onOpenFile?: (path: string) => void }) {
	const blocks = useMemo(() => (document ? [text] : splitBlocks(text)), [text, document]);
	return (
		<AssetsContext.Provider value={assets}>
			<OpenFileContext.Provider value={onOpenFile}>
				<div className="prose-clam">
					{blocks.map((b, i) => (
						<Block key={i} text={b} breaks={breaks} html={document} />
					))}
				</div>
			</OpenFileContext.Provider>
		</AssetsContext.Provider>
	);
}
export default memo(Markdown);
