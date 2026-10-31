import { lazy, Suspense } from "react";

const Impl = lazy(() => import("./sign-out.tsx").then((m) => ({ default: m.SignOutItem })));

/** Lazy shell entry (keeps the access query + icons out of the initial bundle). Renders nothing on the loopback UI. */
export function SignOutItem(props: { compact?: boolean; className?: string }) {
	return (
		<Suspense fallback={null}>
			<Impl {...props} />
		</Suspense>
	);
}
