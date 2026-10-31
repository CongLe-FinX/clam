import type { DiffFile } from "@clam/contracts";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { ArrowRight, ChevronRight, FileMinus, FilePlus, FileQuestion, FileWarning, TriangleAlert } from "lucide-react";
import { memo, type Ref, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { HlLineView } from "@/components/code-block";
import { type HlLine, highlightLines, langFromPath } from "@/lib/highlight";
import { cn, formatNumber } from "@/lib/utils";
import {
	buildRows,
	CHAR_W,
	type DiffRow,
	fileHash,
	fileSources,
	GUTTER_W,
	type LineRef,
	maxLineChars,
	type NoteKind,
	ROW_H,
	rowHeight,
} from "./diff-model.ts";
import { KIND_LETTER, KIND_TONE, splitPath } from "./status-utils.ts";

export interface DiffViewerHandle {
	next(): void;
	prev(): void;
	collapseAll(): void;
	expandAll(): void;
	scrollToFile(path: string): void;
}

export interface DiffViewerProps {
	files: DiffFile[];
	truncated: boolean;
	mode: "unified" | "split";
	/** Scroll to (and expand) this file whenever `nonce` changes. */
	focus: { path: string; nonce: number } | null;
	onActiveFile?: (index: number) => void;
	className?: string;
	ref?: Ref<DiffViewerHandle>;
}

type Tokens = { old: HlLine[] | null; new: HlLine[] | null };
const hlCache = new Map<string, Tokens>();
const hlPending = new Set<string>();
const MAX_HL_LINES = 6000;

const DIFF_STATUS_KIND = { modified: "modified", added: "added", deleted: "deleted", renamed: "renamed", copied: "copied", typechange: "typechange", untracked: "untracked" } as const;

/** Highlights each file the first time it scrolls into view; returns a function that bumps when new tokens arrive. */
function useHighlights(files: readonly DiffFile[], visible: readonly number[], collapsed: ReadonlySet<string>): number {
	const [tick, setTick] = useState(0);
	const key = visible.join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` summarizes `visible`
	useEffect(() => {
		let alive = true;
		for (const fi of visible) {
			const file = files[fi];
			if (!file || file.binary || file.tooLarge || file.hunks.length === 0 || collapsed.has(file.path)) continue;
			const h = fileHash(file);
			if (hlCache.has(h) || hlPending.has(h)) continue;
			const lang = file.language ?? langFromPath(file.path);
			const src = fileSources(file);
			if (src.oldLines + src.newLines > MAX_HL_LINES) {
				hlCache.set(h, { old: null, new: null });
				continue;
			}
			hlPending.add(h);
			Promise.all([highlightLines(src.old, lang), highlightLines(src.new, lang)])
				.then(([o, n]) => {
					if (hlCache.size > 300) hlCache.clear();
					hlCache.set(h, { old: o, new: n });
				})
				.catch(() => hlCache.set(h, { old: null, new: null }))
				.finally(() => {
					hlPending.delete(h);
					if (alive) setTick((t) => t + 1);
				});
		}
		return () => {
			alive = false;
		};
	}, [files, key, collapsed]);
	return tick;
}

function tokensFor(ref: LineRef, tk: Tokens | undefined): HlLine | undefined {
	if (!tk) return undefined;
	if (ref.line.type === "del") return tk.old?.[ref.oi];
	return tk.new?.[ref.ni];
}

const lineBg = { add: "bg-success/[0.10]", del: "bg-danger/[0.10]", context: "", meta: "bg-surface-2" } as const;
const gutterBg = { add: "bg-success/[0.16] text-success/80", del: "bg-danger/[0.16] text-danger/80", context: "text-subtle", meta: "text-subtle" } as const;
const marker = { add: "+", del: "−", context: " ", meta: " " } as const;

const Gutter = ({ n, type }: { n: number | null; type: LineRef["line"]["type"] }) => (
	<span className={cn("tabular w-12 shrink-0 select-none pr-2 text-right", gutterBg[type])}>{n ?? ""}</span>
);

const UnifiedLine = memo(function UnifiedLine({ lref, tokens }: { lref: LineRef; tokens?: HlLine }) {
	const { line } = lref;
	return (
		<div className={cn("flex h-5 items-center font-mono text-xs leading-5", lineBg[line.type])}>
			<Gutter n={line.oldNo} type={line.type} />
			<Gutter n={line.newNo} type={line.type} />
			<span aria-hidden className={cn("w-5 shrink-0 select-none text-center", line.type === "add" && "text-success", line.type === "del" && "text-danger")}>
				{marker[line.type]}
			</span>
			<span className={cn("whitespace-pre pr-4", line.type === "meta" && "italic text-subtle")}>{tokens ? <HlLineView line={tokens} /> : line.content || " "}</span>
		</div>
	);
});

const Half = memo(function Half({ lref, side, tokens, width }: { lref: LineRef | null; side: "left" | "right"; tokens?: HlLine; width: number }) {
	if (!lref) return <div className="h-5 shrink-0 bg-surface-2/70 [background-image:repeating-linear-gradient(135deg,transparent_0_4px,var(--border)_4px_5px)]" style={{ width }} />;
	const { line } = lref;
	const type = line.type;
	return (
		<div className={cn("flex h-5 shrink-0 items-center font-mono text-xs leading-5", lineBg[type], side === "right" && "border-l")} style={{ width }}>
			<Gutter n={side === "left" ? line.oldNo : line.newNo} type={type} />
			<span aria-hidden className={cn("w-5 shrink-0 select-none text-center", type === "add" && "text-success", type === "del" && "text-danger")}>
				{marker[type]}
			</span>
			<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-pre pr-2" title={line.content.length > 80 ? line.content : undefined}>
				{tokens ? <HlLineView line={tokens} /> : line.content || " "}
			</span>
		</div>
	);
});

const noteText: Record<NoteKind, { icon: typeof FileQuestion; text: (f: DiffFile) => string }> = {
	binary: { icon: FileQuestion, text: () => "Binary file — contents are not shown." },
	"too-large": {
		icon: FileWarning,
		text: (f) => `Diff too large to display${f.additions + f.deletions ? ` (${formatNumber(f.additions + f.deletions)} changed lines)` : ""}. Open the file or inspect it with git.`,
	},
	empty: { icon: FilePlus, text: () => "Empty file." },
	rename: { icon: ArrowRight, text: (f) => `Renamed${f.oldPath ? ` from ${f.oldPath}` : ""} — no content changes.` },
	"no-hunks": { icon: FileMinus, text: () => "No textual changes (file mode or whitespace only)." },
};

function FileHeader({ file, index, count, collapsed, width, onToggle }: { file: DiffFile; index: number; count: number; collapsed: boolean; width: number; onToggle: () => void }) {
	const { dir, name } = splitPath(file.path);
	const kind = DIFF_STATUS_KIND[file.status];
	return (
		<div className="h-full border-b bg-surface-2">
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={!collapsed}
			style={{ width: width || "100%" }}
			className="sticky left-0 flex h-full items-center gap-2 px-3 text-left outline-none transition-colors hover:bg-surface-3 focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]"
		>
			<ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-subtle transition-transform duration-150", !collapsed && "rotate-90")} />
			<span className={cn("grid size-5 shrink-0 place-items-center rounded font-mono text-2xs font-semibold bg-surface-3", KIND_TONE[kind])} title={file.status}>
				{KIND_LETTER[kind]}
			</span>
			<span className="min-w-0 truncate font-mono text-xs" title={file.path}>
				{file.oldPath && file.oldPath !== file.path ? <span className="text-subtle">{file.oldPath} → </span> : null}
				<span className="text-subtle">{dir}</span>
				<span className="font-medium text-foreground">{name}</span>
			</span>
			<span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-2xs tabular">
				{file.binary ? <span className="text-subtle">binary</span> : null}
				{file.additions > 0 ? <span className="text-success">+{formatNumber(file.additions)}</span> : null}
				{file.deletions > 0 ? <span className="text-danger">−{formatNumber(file.deletions)}</span> : null}
				<span className="hidden text-subtle sm:inline">
					{index + 1}/{count}
				</span>
			</span>
		</button>
		</div>
	);
}

export function DiffViewer({ files, truncated, mode, focus, onActiveFile, className, ref }: DiffViewerProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [vw, setVw] = useState(0);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
	const activeRef = useRef(0);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const ro = new ResizeObserver(([e]) => setVw(Math.floor(e?.contentRect.width ?? 0)));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const rows = useMemo(() => buildRows(files, mode, collapsed), [files, mode, collapsed]);
	const headerIdx = useMemo(() => {
		const out: number[] = [];
		rows.forEach((r, i) => {
			if (r.kind === "file") out.push(i);
		});
		return out;
	}, [rows]);
	const maxChars = useMemo(() => maxLineChars(files), [files]);

	const rangeExtractor = useCallback(
		(range: Parameters<typeof defaultRangeExtractor>[0]) => {
			const active = [...headerIdx].reverse().find((i) => range.startIndex >= i) ?? headerIdx[0] ?? 0;
			activeRef.current = active;
			return [...new Set([active, ...defaultRangeExtractor(range)])].sort((a, b) => a - b);
		},
		[headerIdx],
	);
	const v = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: useCallback((i: number) => (rows[i] ? rowHeight(rows[i]) : ROW_H.line), [rows]),
		getItemKey: useCallback((i: number) => rows[i]?.key ?? i, [rows]),
		rangeExtractor,
		overscan: 24,
	});
	const items = v.getVirtualItems();

	const visibleFiles = useMemo(() => [...new Set(items.map((it) => rows[it.index]?.fi ?? 0))], [items, rows]);
	const hlTick = useHighlights(files, visibleFiles, collapsed);
	void hlTick;

	const activeFi = rows[activeRef.current]?.fi ?? 0;
	useEffect(() => {
		onActiveFile?.(activeFi);
	}, [activeFi, onActiveFile]);

	const goTo = useCallback(
		(fi: number) => {
			const idx = headerIdx[Math.max(0, Math.min(headerIdx.length - 1, fi))];
			if (idx !== undefined) v.scrollToIndex(idx, { align: "start" });
		},
		[headerIdx, v],
	);

	const pending = useRef<string | null>(null);
	const lastNonce = useRef<number | null>(null);
	if (focus && focus.nonce !== lastNonce.current) {
		lastNonce.current = focus.nonce;
		pending.current = focus.path;
	}
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll once the rows contain the requested file
	useEffect(() => {
		const path = pending.current;
		if (!path) return;
		if (collapsed.has(path)) {
			setCollapsed((c) => {
				const n = new Set(c);
				n.delete(path);
				return n;
			});
			return;
		}
		const fi = files.findIndex((f) => f.path === path);
		if (fi < 0) return;
		pending.current = null;
		requestAnimationFrame(() => goTo(fi));
	}, [focus, rows, files, collapsed]);

	useImperativeHandle(
		ref,
		() => ({
			next: () => goTo((rows[activeRef.current]?.fi ?? 0) + 1),
			prev: () => {
				// jump to the top of the current file first, then to the previous one
				const cur = rows[activeRef.current]?.fi ?? 0;
				const top = headerIdx[cur];
				const el = scrollRef.current;
				const start = top === undefined ? 0 : (v.measurementsCache[top]?.start ?? 0);
				goTo(el && el.scrollTop - start > ROW_H.file ? cur : cur - 1);
			},
			collapseAll: () => setCollapsed(new Set(files.map((f) => f.path))),
			expandAll: () => setCollapsed(new Set()),
			scrollToFile: (path) => {
				const fi = files.findIndex((f) => f.path === path);
				if (fi >= 0) goTo(fi);
			},
		}),
		[files, goTo, headerIdx, rows, v],
	);

	const toggle = useCallback((path: string) => {
		setCollapsed((c) => {
			const n = new Set(c);
			if (n.has(path)) n.delete(path);
			else n.add(path);
			return n;
		});
	}, []);

	const gutters = GUTTER_W * (mode === "unified" ? 2 : 1) + 20;
	// Split halves share the viewport equally; long lines are clipped (full text in the tooltip) instead of scrolling one side away.
	const half = Math.max(Math.floor(vw / 2), 320);
	const contentW = mode === "unified" ? Math.max(vw, gutters + maxChars * CHAR_W + 24) : half * 2;

	const renderRow = (row: DiffRow) => {
		const tk = hlCache.get(fileHash(files[row.fi] as DiffFile));
		switch (row.kind) {
			case "file":
				return <FileHeader file={row.file} index={row.fi} count={files.length} collapsed={row.collapsed} width={vw} onToggle={() => toggle(row.file.path)} />;
			case "hunk":
				return (
					<div className="h-full border-b bg-info/[0.07] font-mono text-2xs leading-[26px] text-info">
						<span className="sticky left-0 block w-max whitespace-pre px-3">{row.header}</span>
					</div>
				);
			case "line":
				return <UnifiedLine lref={row.ref} tokens={tokensFor(row.ref, tk)} />;
			case "pair":
				return (
					<div className="flex">
						<Half lref={row.left} side="left" tokens={row.left ? tokensFor(row.left, tk) : undefined} width={half} />
						<Half lref={row.right} side="right" tokens={row.right ? tokensFor(row.right, tk) : undefined} width={half} />
					</div>
				);
			case "note": {
				const { icon: Icon, text } = noteText[row.note];
				return (
					<div className="h-full border-b">
						<div className="sticky left-0 flex h-full items-center gap-2 px-4 text-[13px] text-muted-foreground" style={{ width: vw || undefined }}>
							<Icon aria-hidden className="size-4 shrink-0 text-subtle" />
							<span className="truncate">{text(row.file)}</span>
						</div>
					</div>
				);
			}
		}
	};

	return (
		<div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
			{truncated ? (
				<div role="status" className="flex shrink-0 items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs text-warning">
					<TriangleAlert className="size-3.5 shrink-0" />
					The diff is larger than the display limit — some files are omitted. Narrow it by staging or committing part of the changes.
				</div>
			) : null}
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard scrolling + n/p file navigation */}
			<div
				ref={scrollRef}
				tabIndex={0}
				role="region"
				aria-label="Diff"
				onKeyDown={(e) => {
					if (e.metaKey || e.ctrlKey || e.altKey) return;
					if (e.key === "n") {
						e.preventDefault();
						goTo(activeFi + 1);
					} else if (e.key === "p") {
						e.preventDefault();
						goTo(activeFi - 1);
					}
				}}
				className="scrollbar-thin min-h-0 flex-1 overflow-auto overscroll-contain outline-none [overflow-anchor:none]"
			>
				<div className="relative" style={{ height: v.getTotalSize(), width: contentW }}>
					{items.map((item) => {
						const row = rows[item.index];
						if (!row) return null;
						const sticky = item.index === activeRef.current && row.kind === "file";
						return (
							<div
								key={item.key}
								data-index={item.index}
								style={
									sticky
										? { position: "sticky", top: 0, zIndex: 3, height: ROW_H.file, width: "100%" }
										: { position: "absolute", top: 0, left: 0, width: "100%", height: rowHeight(row), transform: `translateY(${item.start}px)` }
								}
							>
								{renderRow(row)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
