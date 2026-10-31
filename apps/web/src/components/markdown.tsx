import { isLocalAppUrl, OpenInMachineBrowser } from "@/features/browser/open-in-browser.tsx";
import { createContext, memo, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { type AssetResolver } from "./rich/assets.ts";
import { FileChip } from "./rich/file-chip.tsx";
import { FileTile } from "./rich/file-tile.tsx";
import { hasMath, loadedMath, loadMath, type MathPlugins, protectCurrency } from "./rich/math.ts";
import { RemoteImageCard, RichImage, BrokenImageCard } from "./rich/rich-image.tsx";
import { RichFence } from "./rich/rich-fence.tsx";
import { CodeBlock } from "./code-block.tsx";

type Plugins = NonNullable<Options["remarkPlugins"]>;

/** Resolves relative paths in `![]()` / `[]()`; provided once by `Markdown`, read by the (module-level, stable) component overrides. */
const AssetsContext = createContext<AssetResolver | undefined>(undefined);
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

function Img({ src, alt }: { src?: string | Blob; alt?: string }) {
	const assets = useContext(AssetsContext);
	if (typeof src !== "string" || !src) return null;
	if (DATA_IMAGE.test(src)) return <RichImage src={src} alt={alt} label={alt || "Embedded image"} />;
	if (/^https?:\/\//i.test(src) || src.startsWith("//")) return <RemoteImageCard src={src.startsWith("//") ? `https:${src}` : src} alt={alt} />;
	const file = assets?.resolve(src);
	if (!file) return <BrokenImageCard label={alt || src} detail={src} />;
	if (file.kind === "image") return <RichImage src={file.url} alt={alt || file.name} label={file.path ?? file.name} />;
	return <FileTile file={file} className="my-1" />;
}

function Link({ href, children }: { href?: string; children?: ReactNode }) {
	const assets = useContext(AssetsContext);
	if (!href) return <span>{children}</span>;
	if (href.startsWith("#")) return <a href={href}>{children}</a>;
	if (isAbsolute(href)) {
		const link = <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
		return isLocalAppUrl(href) ? (
			<>
				{link}
				<OpenInMachineBrowser href={href} className="ml-1 align-middle" />
			</>
		) : (
			link
		);
	}
	const file = assets?.resolve(href);
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
		return <CodeBlock code={code} lang={lang === "chart" ? "json" : "text"} hint="rendering when complete" className="my-3" />;
	}
	return <CodeBlock code={code} lang={lang} className="my-3" />;
}

const components: Components = {
	pre: ({ children }) => <>{children}</>,
	code: Code,
	a: ({ href, children }) => <Link href={href}>{children}</Link>,
	img: ({ src, alt }) => <Img src={src} alt={alt} />,
	p({ node, children }) {
		if (node && hasImage(node as HastNode)) return <div className={cn(onlyImages(node as HastNode) ? "md-gallery rich-card" : "md-p")}>{children}</div>;
		return <p>{children}</p>;
	},
	table: ({ children }) => (
		<div className="md-table rich-card scrollbar-thin">
			<table>{children}</table>
		</div>
	),
	input: ({ type, checked }) => (type === "checkbox" ? <input type="checkbox" checked={Boolean(checked)} readOnly disabled aria-label={checked ? "Done" : "Not done"} /> : null),
};

const REMARK_BASE: Plugins = [remarkGfm];

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

/** KaTeX arrives once (module promise); until then math renders as plain text, then upgrades in place. */
function useMath(needed: boolean): MathPlugins | null {
	const [math, setMath] = useState<MathPlugins | null>(() => (needed ? loadedMath() : null));
	useEffect(() => {
		if (!needed || math) return;
		let alive = true;
		loadMath().then((m) => alive && setMath(m), () => undefined);
		return () => {
			alive = false;
		};
	}, [needed, math]);
	return needed ? math : null;
}

const Block = memo(function Block({ text }: { text: string }) {
	const math = useMath(useMemo(() => hasMath(text), [text]));
	const remark = useMemo(() => (math ? [...REMARK_BASE, ...math.remark] : REMARK_BASE), [math]);
	const source = useMemo(() => (math ? protectCurrency(text) : text), [math, text]);
	return (
		<SourceContext.Provider value={text}>
			<ReactMarkdown remarkPlugins={remark} rehypePlugins={math?.rehype} components={components} urlTransform={urlTransform}>
				{source}
			</ReactMarkdown>
		</SourceContext.Provider>
	);
});

function Markdown({ text, assets }: { text: string; assets?: AssetResolver }) {
	const blocks = useMemo(() => splitBlocks(text), [text]);
	return (
		<AssetsContext.Provider value={assets}>
			<div className="prose-clam">
				{blocks.map((b, i) => (
					<Block key={i} text={b} />
				))}
			</div>
		</AssetsContext.Provider>
	);
}
export default memo(Markdown);
