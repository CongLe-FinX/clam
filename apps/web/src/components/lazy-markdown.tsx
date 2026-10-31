import { lazy, memo, Suspense } from "react";

const Markdown = lazy(() => import("./markdown.tsx"));

/** Markdown renderer loaded on demand; shows the raw text until the chunk arrives. */
export const LazyMarkdown = memo(function LazyMarkdown({ text }: { text: string }) {
	return (
		<Suspense fallback={<div className="prose-clam whitespace-pre-wrap">{text}</div>}>
			<Markdown text={text} />
		</Suspense>
	);
});
