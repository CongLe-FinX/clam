import type { ServerResponse } from "node:http";

/** A refusal on a preview host: a small page for a browser, the usual JSON envelope for everything else. Never says what is behind the host. */
export interface Refusal {
	status: number;
	code: string;
	/** English text (also the JSON message). */
	title: string;
	detail: string;
	/** Vietnamese twin of title/detail for the page a browser lands on (the web app's catalog is not available on a preview host). */
	vi: { title: string; detail: string };
}

export const REFUSALS = {
	signIn: {
		status: 401,
		code: "auth_required",
		title: "Open this preview from CLAM",
		detail: "Preview links are one-time and signed. Open this app from CLAM (the “Open preview” button) to get a fresh link.",
		vi: { title: "Hãy mở bản xem trước từ CLAM", detail: "Liên kết xem trước dùng một lần và có chữ ký. Hãy mở ứng dụng này từ CLAM (nút “Mở bản xem trước”) để có liên kết mới." },
	},
	disabled: {
		status: 403,
		code: "preview_disabled",
		title: "Preview is switched off",
		detail: "Turn it on from the local CLAM on this machine (Settings → Security).",
		vi: { title: "Xem trước đang tắt", detail: "Hãy bật nó trong CLAM chạy trên máy này (Cài đặt → Bảo mật)." },
	},
	port: {
		status: 403,
		code: "port_not_allowed",
		title: "This port cannot be previewed",
		detail: "CLAM only opens web apps running on this machine — never CLAM itself, databases or other services.",
		vi: { title: "Không thể xem trước cổng này", detail: "CLAM chỉ mở các ứng dụng web chạy trên máy này — không bao giờ mở chính CLAM, cơ sở dữ liệu hay dịch vụ khác." },
	},
	nothing: {
		status: 502,
		code: "nothing_listening",
		title: "Nothing is answering on this port",
		detail: "Start the app on this machine, then reload this page.",
		vi: { title: "Không có gì phản hồi ở cổng này", detail: "Hãy khởi động ứng dụng trên máy này rồi tải lại trang." },
	},
	noPort: {
		status: 409,
		code: "port_not_selected",
		title: "Choose an app to preview",
		detail: "Open this preview from CLAM, or pick one of the apps running on this machine.",
		vi: { title: "Chọn một ứng dụng để xem trước", detail: "Hãy mở bản xem trước từ CLAM, hoặc chọn một ứng dụng đang chạy trên máy này." },
	},
	notFound: {
		status: 404,
		code: "not_found",
		title: "Not found",
		detail: "",
		vi: { title: "Không tìm thấy", detail: "" },
	},
} as const satisfies Record<string, Refusal>;

const escape = (text: string): string => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export interface RefusalRequest {
	accept: string | undefined;
	acceptLanguage: string | undefined;
}

/** Write `refusal`; `extraHeaders` (for example a cookie to clear) ride along. */
export function sendRefusal(res: ServerResponse, ask: RefusalRequest, refusal: Refusal, extraHeaders: Record<string, string | string[]> = {}): void {
	const html = (ask.accept ?? "").includes("text/html");
	const common = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", ...extraHeaders };
	if (!html) {
		const body = JSON.stringify({ error: { code: refusal.code, message: refusal.detail ? `${refusal.title}. ${refusal.detail}` : refusal.title } });
		res.writeHead(refusal.status, { ...common, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
		res.end(body);
		return;
	}
	const vi = (ask.acceptLanguage ?? "").toLowerCase().startsWith("vi");
	const text = vi ? refusal.vi : refusal;
	const body = `<!doctype html><html lang="${vi ? "vi" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(text.title)}</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}main{max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;opacity:.75}</style></head><body><main><h1>${escape(text.title)}</h1>${text.detail ? `<p>${escape(text.detail)}</p>` : ""}</main></body></html>`;
	res.writeHead(refusal.status, { ...common, "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
	res.end(body);
}

/** One app the port picker lists. */
export interface PickerApp {
	port: number;
	title: string | null;
	process: string | null;
}

/** The port picker (no port selected yet): the allowed listening apps, each a link to `/port/<port>/`. A page for browsers, the refusal envelope for everything else. */
export function sendPicker(res: ServerResponse, ask: RefusalRequest, apps: PickerApp[]): void {
	if (!(ask.accept ?? "").includes("text/html")) return sendRefusal(res, ask, REFUSALS.noPort);
	const vi = (ask.acceptLanguage ?? "").toLowerCase().startsWith("vi");
	const text = vi ? REFUSALS.noPort.vi : REFUSALS.noPort;
	const empty = vi ? "Không có ứng dụng web nào đang chạy trên máy này." : "No web apps are running on this machine.";
	const items = apps
		.map((a) => `<li><a href="/port/${a.port}/"><span>${escape(a.title?.trim() || a.process || (vi ? "Ứng dụng web" : "Web app"))}</span><code>:${a.port}</code></a></li>`)
		.join("");
	const body = `<!doctype html><html lang="${vi ? "vi" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(text.title)}</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}main{width:min(28rem,100%);padding:2rem 1.25rem}h1{font-size:1.25rem;margin:0 0 .25rem}p{margin:0 0 1rem;opacity:.75}ul{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}a{display:flex;justify-content:space-between;gap:1rem;padding:.75rem 1rem;border-radius:.75rem;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);color:inherit;text-decoration:none}a:hover,a:focus-visible{background:color-mix(in srgb,CanvasText 8%,transparent)}code{opacity:.65}</style></head><body><main><h1>${escape(text.title)}</h1><p>${escape(text.detail)}</p>${apps.length > 0 ? `<ul>${items}</ul>` : `<p>${escape(empty)}</p>`}</main></body></html>`;
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
	res.end(body);
}
