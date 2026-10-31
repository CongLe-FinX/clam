import { lazy } from "react";
import type { ComponentType } from "react";

/**
 * `lazy()` with a warm-up hook. Once `preload()` has resolved, the component renders synchronously: a plain `lazy()` component
 * still suspends on its first render (even with its chunk cached), and React holds a revealed Suspense boundary back ~300 ms.
 */
export function lazyPreload<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): { Component: ComponentType<P>; preload: () => Promise<unknown> } {
	let loaded: ComponentType<P> | null = null;
	let pending: Promise<unknown> | null = null;
	const preload = () =>
		(pending ??= load().then((m) => {
			loaded = m.default;
			return m;
		}));
	const Lazy = lazy(() => preload() as Promise<{ default: ComponentType<P> }>);
	const Component = (props: P) => {
		const Ready = loaded;
		return Ready ? <Ready {...props} /> : <Lazy {...(props as P & React.JSX.IntrinsicAttributes)} />;
	};
	return { Component, preload };
}
