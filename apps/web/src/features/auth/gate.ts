/**
 * Tiny signed-out switch shared by the API client, the WebSocket client and the root layout.
 * It stays in the initial bundle; everything else in `features/auth` is lazy.
 */
type Listener = () => void;

let required = false;
const listeners = new Set<Listener>();

function emit(): void {
	for (const l of [...listeners]) l();
}

export const authGate = {
	/** True once any call answered 401 `auth_required` (or the WS handshake was refused) on the public origin. */
	isRequired: (): boolean => required,
	require(): void {
		if (required) return;
		required = true;
		emit();
	},
	clear(): void {
		if (!required) return;
		required = false;
		emit();
	},
	subscribe(l: Listener): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};

/** Only same-origin absolute paths; never `/login` itself, never protocol-relative URLs. */
export function safeRedirect(raw: unknown): string {
	if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
	if (raw === "/login" || raw.startsWith("/login?") || raw.startsWith("/login#")) return "/";
	return raw;
}
