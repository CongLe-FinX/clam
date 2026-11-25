import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, HighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
	crosshairCursor,
	drawSelection,
	dropCursor,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/** Token colours from CSS variables (index.css `--syn-*`), so light and dark follow the app theme without reconfiguring the editor. */
const highlight = HighlightStyle.define([
	{ tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword], color: "var(--syn-keyword)" },
	{ tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--syn-string)" },
	{ tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--syn-number)" },
	{ tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
	{ tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--syn-function)" },
	{ tag: [tags.typeName, tags.className, tags.namespace], color: "var(--syn-type)" },
	{ tag: [tags.propertyName, tags.attributeName], color: "var(--syn-property)" },
	{ tag: [tags.tagName, tags.angleBracket], color: "var(--syn-tag)" },
	{ tag: tags.heading, color: "var(--syn-heading)", fontWeight: "600" },
	{ tag: [tags.link, tags.url], color: "var(--syn-link)", textDecoration: "underline" },
	{ tag: tags.emphasis, fontStyle: "italic" },
	{ tag: tags.strong, fontWeight: "600" },
	{ tag: tags.invalid, color: "var(--danger)" },
]);

const theme = EditorView.theme({
	"&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--background)", color: "var(--foreground)" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "20px", overscrollBehavior: "contain" },
	".cm-content": { caretColor: "var(--accent)", paddingBlock: "6px" },
	".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
	".cm-gutters": { backgroundColor: "var(--background)", color: "var(--subtle)", border: "none" },
	".cm-lineNumbers .cm-gutterElement": { paddingInline: "8px 12px" },
	".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--accent) 5%, transparent)" },
	".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
	"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
		backgroundColor: "color-mix(in oklab, var(--accent) 24%, transparent)",
	},
	".cm-selectionMatch": { backgroundColor: "color-mix(in oklab, var(--accent) 12%, transparent)" },
	".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "color-mix(in oklab, var(--accent) 18%, transparent)", outline: "none" },
	".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--warning) 30%, transparent)" },
	".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in oklab, var(--warning) 55%, transparent)" },
	".cm-foldPlaceholder": { backgroundColor: "var(--surface-3)", border: "none", color: "var(--muted-foreground)" },
	".cm-panels": { backgroundColor: "var(--surface-1)", color: "var(--foreground)" },
	".cm-panels-top": { borderBottom: "1px solid var(--border)" },
	".cm-panels-bottom": { borderTop: "1px solid var(--border)" },
	".cm-panel.cm-search": { padding: "6px 8px", fontFamily: "var(--font-sans)", fontSize: "12px" },
	".cm-panel.cm-search input, .cm-panel.cm-search button": { fontSize: "12px", borderRadius: "6px" },
	".cm-textfield": { backgroundColor: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--foreground)" },
	".cm-button": { backgroundImage: "none", backgroundColor: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--foreground)" },
	".cm-tooltip": { backgroundColor: "var(--overlay)", border: "1px solid var(--border-strong)", borderRadius: "8px" },
});

export interface CodeEditorProps {
	/** Text the editor starts with; later changes of this prop are ignored (remount with a new `key` to load other text). */
	initial: string;
	/** File name or path: picks the language (by extension or well-known name). */
	path: string;
	onChange: (text: string) => void;
	/** Cmd/Ctrl+S. */
	onSave: () => void;
	wrap: boolean;
	autoFocus?: boolean;
	className?: string;
}

/**
 * A code editor for one text file (CodeMirror 6): line numbers, syntax highlighting by file name, undo history, search (Cmd/Ctrl+F),
 * multiple cursors, bracket matching, folding, Tab to indent and Cmd/Ctrl+S to save. Keeps the file's line endings (CRLF stays CRLF).
 */
export default function CodeEditor({ initial, path, onChange, onSave, wrap, autoFocus = false, className }: CodeEditorProps) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const wrapping = useRef(new Compartment());
	const callbacks = useRef({ onChange, onSave });
	callbacks.current = { onChange, onSave };

	// biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once per mount; `initial`/`path` changes remount it (key)
	useEffect(() => {
		const language = new Compartment();
		const state = EditorState.create({
			doc: initial,
			extensions: [
				...(initial.includes("\r\n") ? [EditorState.lineSeparator.of("\r\n")] : []),
				lineNumbers(),
				foldGutter(),
				highlightActiveLineGutter(),
				highlightSpecialChars(),
				history(),
				drawSelection(),
				dropCursor(),
				EditorState.allowMultipleSelections.of(true),
				indentOnInput(),
				syntaxHighlighting(highlight),
				bracketMatching(),
				rectangularSelection(),
				crosshairCursor(),
				highlightActiveLine(),
				highlightSelectionMatches(),
				search({ top: true }),
				keymap.of([
					{
						key: "Mod-s",
						preventDefault: true,
						run: () => {
							callbacks.current.onSave();
							return true;
						},
					},
					indentWithTab,
					...defaultKeymap,
					...historyKeymap,
					...searchKeymap,
				]),
				language.of([]),
				wrapping.current.of(wrap ? EditorView.lineWrapping : []),
				theme,
				EditorView.updateListener.of((update) => {
					if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
				}),
			],
		});
		const editor = new EditorView({ state, parent: host.current as HTMLDivElement });
		view.current = editor;
		if (autoFocus) editor.focus();
		// The grammar loads as its own small chunk, after the editor is already usable.
		const name = path.split("/").at(-1) ?? path;
		let alive = true;
		LanguageDescription.matchFilename(languages, name)
			?.load()
			.then((support) => {
				if (alive) editor.dispatch({ effects: language.reconfigure(support) });
			})
			.catch(() => undefined);
		return () => {
			alive = false;
			editor.destroy();
			view.current = null;
		};
	}, []);

	useEffect(() => {
		view.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
	}, [wrap]);

	return <div ref={host} className={cn("h-full min-h-0 overflow-hidden", className)} />;
}
