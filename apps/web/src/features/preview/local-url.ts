/** `http://localhost:5173/a/b?c=1#d` → `{ port: 5173, path: "/a/b?c=1#d" }`; null for anything that is not an http(s) URL with an explicit port. */
export function parseLocalApp(href: string): { port: number; path: string } | null {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	const port = Number(url.port);
	if ((url.protocol !== "http:" && url.protocol !== "https:") || !Number.isInteger(port) || port < 1 || port > 65535) return null;
	return { port, path: `${url.pathname}${url.search}${url.hash}` };
}
