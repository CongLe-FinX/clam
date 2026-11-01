# Vietnamese glossary (en → vi)

Every agent writing a `vi.ts` follows this. Tone: concise, natural Vietnamese as used by Vietnamese developers; address the
user as **bạn** (never "quý khách", never "người dùng" in UI copy); prefer short imperative button labels ("Lưu", "Hủy",
"Tạo chat"); sentence case, no trailing full stop on labels/buttons, full stop on full sentences. Keep `…` and punctuation of the source.

| English | Vietnamese | Notes |
| --- | --- | --- |
| CL Agent Mesh | CL Agent Mesh | **Never translated** (the check fails if dropped) |
| Machine | Máy | This machine → Máy này; remote machine → Máy từ xa |
| Agent / Subagent | Agent / Subagent | not translated |
| Chat | Chat | New chat → Chat mới; Group chat → Chat nhóm |
| Session | Phiên | |
| Task | Tác vụ | Delegate → Giao việc |
| Handoff / Hand over | Bàn giao | verb: Bàn giao |
| Takeover / Take over | Tiếp quản | |
| Workspace | Workspace | not translated |
| Project | Dự án | |
| Context | Ngữ cảnh | |
| Memory | Bộ nhớ | |
| Settings | Cài đặt | |
| Pairing / Pair | Ghép nối | |
| Invite | Mời | Invite link → Liên kết mời |
| Join | Tham gia | |
| Fingerprint | Dấu vân tay | |
| Approve / Reject | Duyệt / Từ chối | |
| Files | Tệp | File → Tệp |
| Terminal | Terminal | |
| Browser | Trình duyệt | |
| Plan | Kế hoạch | |
| Question | Câu hỏi | |
| Cancel / Save / Delete / Close | Hủy / Lưu / Xóa / Đóng | |
| Loading… / Retry | Đang tải… / Thử lại | |
| Sign in / Sign out / Password | Đăng nhập / Đăng xuất / Mật khẩu | |
| Online / Offline | Trực tuyến / Ngoại tuyến | |
| Usage / Cost / Tokens | Mức dùng / Chi phí / Token | |
| Overview | Tổng quan | |
| Search | Tìm kiếm | |
| Theme / Language / Appearance | Giao diện / Ngôn ngữ / Hiển thị | Light/Dark/System → Sáng/Tối/Hệ thống |
| Participant | Thành viên | in a group chat; never "người tham gia" |
| Peer | Máy ngang hàng (long) / peer (short, in technical rows) | a paired remote machine is "Máy từ xa" in prose |
| Mirror / Mirrored | Bản sao / Đã sao chép | |
| Checkpoint | Điểm khôi phục | |
| Tunnel | Tunnel | not translated (Cloudflare tunnel) |
| Dependency / Runtime / Driver / Manifest / Token / Daemon | dependency / runtime / driver / manifest / token / daemon | developer terms stay English, lowercase mid-sentence |
| Permission / Approval | Quyền / Phê duyệt | button "Duyệt" |
| Pending / Running / Done / Failed | Đang chờ / Đang chạy / Xong / Thất bại | |
| Review (button) | Xem lại | never "Xem xét" |
| Incoming / Outgoing | Nhận / Gửi | direction of a task or handoff |
| Removed | Đã xóa | never "Đã gỡ" |
| Create PR | Create PR | git term, stays English |

**Style:** "bạn" only when needed; drop "của bạn" where the owner is obvious ("Cài đặt", not "Cài đặt của bạn"). Sentence case
(only first word capitalised, never Title Case). Quotes “” as in source. No plural words ("các"/"những" only when truly needed).

**Stay in English:** git terms (commit, branch, push, pull, pull request, merge, diff, clone, stash, rebase), keyboard
keys (⌘, Ctrl, Enter, Esc, Tab), product/tool names (OMP, GitHub, Cloudflare, Markdown, Mermaid), code identifiers, routes,
file paths, API values, model names, units (KB, ms, s, h).

**Plurals:** Vietnamese has one plural form. Still write both selectors so the English key and the vi value stay
parameter-compatible: `{count, plural, one {# agent} other {# agents}}` → `{count, plural, other {# agent}}`.

**Rich text:** keep the same tags in the translation (`<b>…</b>`); the check fails if tags or `{params}` differ.
