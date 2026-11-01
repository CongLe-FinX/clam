# Vietnamese review notes

Native-quality pass over every vi catalog (shell, server shards, feature catalogs). Terms follow `GLOSSARY.md`.

## Terminology decisions
- Participant → **Thành viên** (never "người tham gia"); peer in prose → **máy từ xa**; mirror → **bản sao**; checkpoint → **điểm khôi phục**.
- Kept English (developer terms): agent, workspace, terminal, tunnel ("Tunnel có tên"), dependency, runtime, driver ("vai trò driver"), manifest, token, daemon, secret, prompt ("Prompt mẫu"), epoch fence, git terms.
- "tool" → **công cụ** everywhere ("Lệnh gọi công cụ"); "Home" → **Thư mục chính**; "Shared session" → **phiên chia sẻ**.
- English key says "node" → "node"; says "machine" → "máy".
- Done → **Xong** (used across handoff/network/settings/tasks; the glossary now reflects this), Review → **Xem lại** (every catalog; was "Xem xét"), Crashed → **Bị lỗi**, Capabilities → **Năng lực**, Idle timeout → **Thời gian chờ khi rảnh**, Direction → **Chiều**, Approval mode → **Chế độ phê duyệt**.
- Incoming / Outgoing → **Nhận / Gửi** (handoff and task direction chips; was "Đến / Đi"); Removed → **Đã xóa** everywhere (never "Đã gỡ"); "Create PR" stays English (git term).
- Style: "của bạn" dropped wherever the owner is obvious; Vietnamese sentence case; no plural words; “” quotes kept; "Vui lòng" → "Hãy".

## Notable fixes
- Calques removed: "Quyền truy cập đã bị từ chối" → "GitHub đã từ chối cấp quyền"; "Lần cuối thấy" → "Thấy lần cuối"; "Đăng nhập kéo dài" → "Thời hạn đăng nhập"; "Mức độ mở ra mạng" → "Phạm vi truy cập mạng"; doubled words ("yêu cầu yêu cầu", "đang … đang", "kết kết thúc") fixed; typo "chia s ẻ".
- Conflict labels "Bản của tôi / Bản của họ"; "Keep going" → "Không hủy", "Ask me" → "Hỏi trước"; "Không có quyền truy cập" → "Không có quyền".
- "Too many sign-in attempts" translated correctly; "Cần password" → "Cần mật khẩu".

## Left-over English pass (status words, durations, server text)
- **Enum values are never shown raw.** One label map per enum: runtime state `RUNTIME_STATE_LABEL` and session status `SESSION_STATUS_LABEL` (components/session-status.tsx), node health / dot status `DOT_STATUS_LABEL` (ui/status-dot.tsx), tunnel state + mode `TUNNEL_STATE` / `TUNNEL_MODE_LABEL` (features/network/format.ts), handoff step `stepName()` and state `STATE_META` (features/handoff/meta.ts), task event type `TYPE_LABEL`, quota status `LIMIT_STATUS_LABEL`.
- **Server sentences with enum params** (`"Handoff is {state}"`, `"{fromStatus} → {toStatus}"`, `"Retrying step {n} ({step})"`): the server sends the raw English word; `renderServerText` translates params named `state`, `status`, `fromStatus`, `toStatus`, `reported`, `side`, `role`, `step` through the lowercase word catalog declared in `lib/server-words.ts` (vi: "đã chấp nhận → đang chạy"). New enum words go in that file.
- Server literals that were unwrapped now have `i18nMsg` twins: node health checks (`{active, plural, …} running`), autostart detail/errors (`autoStartI18n` in the settings payload), tunnel `lastErrorI18n` and `TunnelConfigError`.
- Context panel counts: `"{user, plural, one {# message from you} …} · {assistant, plural, …}"` → "5 tin của bạn · 5 tin của agent" (was "5 từ bạn · 5 từ assistant").
- **Durations** are formatted by `formatDuration` (lib/utils.ts) with `Intl.NumberFormat` units + `Intl.ListFormat`, at most two parts and never a zero trailing part: en `6m`, `6m 5s`, `1h 5m`, `2d 3h`; vi `6 phút`, `6 phút 5 giây`, `1 giờ 5 phút`, `2 ngày 3 giờ`. Single-unit ages (`formatUnit`): `5m` / `5 phút`. Whole-unit spans such as provider quota windows (`formatSpan`): "7 days" / "7 ngày", "5 hours" / "5 giờ" (the provider's English `windowLabel` is only a fallback; `windowMs` carries the length). Hand-built `${m}m ${s}s` strings are gone.

## Known open items
None from the wording decisions: "Review", "Removed", "Create PR" and "Incoming/Outgoing" are settled above.
