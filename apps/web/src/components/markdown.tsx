import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code-block.tsx";

const components: Components = {
	pre: ({ children }) => <>{children}</>,
	code({ className, children, node: _node, ...rest }) {
		const text = String(children ?? "");
		const m = /language-([\w+#-]+)/.exec(className ?? "");
		const isBlock = Boolean(m) || text.includes("\n");
		if (!isBlock) return <code {...rest}>{children}</code>;
		return <CodeBlock code={text.replace(/\n$/, "")} lang={m?.[1] ?? null} className="my-3" />;
	},
	a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
};

const plugins = [remarkGfm];

/** Split into top-level blocks so settled blocks keep memoized output while the tail streams. */
export function splitBlocks(src: string): string[] {
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

const Block = memo(function Block({ text }: { text: string }) {
	return (
		<ReactMarkdown remarkPlugins={plugins} components={components}>
			{text}
		</ReactMarkdown>
	);
});

function Markdown({ text }: { text: string }) {
	const blocks = useMemo(() => splitBlocks(text), [text]);
	return (
		<div className="prose-clam">
			{blocks.map((b, i) => (
				<Block key={i} text={b} />
			))}
		</div>
	);
}
export default memo(Markdown);
