import type { Catalog } from "../../core";

/** Preview (open a local web app in your own browser through its own preview hostname). */
const vi: Catalog = {
	"Preview is switched off for remote sign-ins on this machine. Turn it on from the machine's local UI (Settings → Security).": "Xem trước đang tắt đối với đăng nhập từ xa trên máy này. Hãy bật từ giao diện cục bộ của máy (Cài đặt → Bảo mật).",
	"Too many preview requests. Try again in a moment.": "Quá nhiều yêu cầu xem trước. Hãy thử lại sau giây lát.",
	"Previews need a named tunnel with a hostname. Set one up under Settings → Cloudflare Tunnel first.": "Xem trước cần một tunnel có tên kèm hostname. Hãy thiết lập trong Cài đặt → Cloudflare Tunnel trước.",
	"Port {port} belongs to CL Agent Mesh itself and cannot be previewed": "Cổng {port} thuộc về chính CL Agent Mesh nên không thể xem trước",
	"Port {port} cannot be previewed (databases, remote login, debuggers and other non-web services are never opened)": "Không thể xem trước cổng {port} (cơ sở dữ liệu, đăng nhập từ xa, trình gỡ lỗi và các dịch vụ không phải web không bao giờ được mở)",
	"path must start with a single /": "path phải bắt đầu bằng một dấu /",
	"The preview host must differ from this machine's tunnel hostname (that one serves the UI)": "Preview host phải khác hostname tunnel của máy này (hostname đó dùng để phục vụ giao diện)",
	"The preview host must be a plain hostname such as {example}": "Preview host phải là hostname thông thường, ví dụ {example}",
	"Could not reach https://{host} ({error}). Check that this public hostname exists in Cloudflare and points at this machine's network listener, and give DNS a minute.": "Không truy cập được https://{host} ({error}). Hãy kiểm tra public hostname này đã có trong Cloudflare và trỏ tới network listener của máy này, rồi chờ DNS một phút.",
	"https://{host} reaches this machine. Previews are ready.": "https://{host} tới được máy này. Xem trước đã sẵn sàng.",
	"https://{host} answered, but not from this machine. Check that it is routed to this machine's network listener and that no other tunnel claims it.": "https://{host} có phản hồi nhưng không phải từ máy này. Hãy kiểm tra nó được định tuyến tới network listener của máy này và không tunnel nào khác giữ nó.",
};

export default vi;
