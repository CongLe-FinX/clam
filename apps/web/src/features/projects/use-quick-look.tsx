import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect } from "react";

const QuickLook = lazy(() => import("./quick-look.tsx"));

/** True while the open Quick Look was pushed as its own history entry, so closing can simply go back (the back button closes it too). */
let pushed = false;

export interface QuickLookState {
	/** Project-relative path of the open file, from `?file=`. */
	file: string | undefined;
	open: (path: string) => void;
	/** Show another file in place (replaces the history entry: previous / next never stack up). */
	show: (path: string) => void;
	close: () => void;
}

/**
 * Quick Look lives in the URL (`?file=`), so a reload or a shared link reopens it and the back button closes it. Works on any route
 * whose search schema has an optional `file`.
 */
export function useQuickLook(): QuickLookState {
	const navigate = useNavigate();
	const router = useRouter();
	const file = (useSearch({ strict: false }) as { file?: string }).file;

	const go = useCallback(
		(next: string | undefined, replace: boolean) => {
			void navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, file: next })) as never, replace });
		},
		[navigate],
	);
	useEffect(() => {
		if (!file) pushed = false;
	}, [file]);

	const open = useCallback(
		(path: string) => {
			pushed = file === undefined;
			go(path, file !== undefined);
		},
		[file, go],
	);
	const show = useCallback((path: string) => go(path, true), [go]);
	const close = useCallback(() => {
		if (pushed) {
			pushed = false;
			router.history.back();
		} else go(undefined, true);
	}, [go, router]);
	return { file, open, show, close };
}

/** Mounts Quick Look (a lazy chunk) only while a file is open. */
export function QuickLookHost({ projectId, ql }: { projectId: string; ql: QuickLookState }) {
	if (!ql.file) return null;
	return (
		<Suspense fallback={null}>
			<QuickLook projectId={projectId} path={ql.file} onNavigate={ql.show} onClose={ql.close} />
		</Suspense>
	);
}
