import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadNamespace, useLocale } from "./i18n";
import { createAppRouter } from "./app/router.tsx";
import { createQueryClient } from "./lib/queries.ts";
import "./index.css";

const queryClient = createQueryClient();
const router = createAppRouter(queryClient);

/** Re-keying by locale re-renders the whole tree on a language switch, so every `t()` call is re-evaluated (no reload, router state kept). */
function App() {
	const locale = useLocale();
	return (
		<QueryClientProvider client={queryClient}>
			<RouterProvider key={locale} router={router} />
		</QueryClientProvider>
	);
}

// The Vite plugin replaces the token with the feature namespaces statically reachable from here (none today). No top-level
// await anywhere: in lazy chunks it makes Rollup fragment the entry chunk (+1.6 KB gzip).
const INITIAL_NAMESPACES = JSON.parse("__INITIAL_NAMESPACES__") as string[];
void Promise.all(["shell", "server", ...INITIAL_NAMESPACES].map(loadNamespace)).then(() =>
	createRoot(document.getElementById("root") as HTMLElement).render(
		<StrictMode>
			<App />
		</StrictMode>,
	),
);
