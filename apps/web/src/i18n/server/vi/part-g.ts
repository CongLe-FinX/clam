import type { Catalog } from "../../core";

/** System monitor (CPU / memory / disk alerts of the host machine). */
const vi: Catalog = {
	"Memory is almost out · {percent}%": "RAM gần cạn · {percent}%",
	"Memory is running low · {percent}%": "RAM gần hết · {percent}%",
	"CPU is maxed out · {percent}%": "CPU đang kịch tải · {percent}%",
	"CPU is under heavy load · {percent}%": "CPU đang tải nặng · {percent}%",
	"Disk is almost full · {free} free": "Ổ đĩa gần đầy · còn trống {free}",
	"Disk is getting full · {free} free": "Ổ đĩa sắp đầy · còn trống {free}",
	"Folder sizes cannot be measured on this platform": "Không thể đo dung lượng thư mục trên nền tảng này",
	"OMP is already being updated": "OMP đang được cập nhật",
	"The checkpoint could not be pushed: {branch} has commits another participant pushed. The lead was asked to pull them in; the next checkpoint pushes.": "Checkpoint chưa push được: {branch} có commit do thành viên khác đã push. Trưởng nhóm đã được nhờ kéo về; checkpoint tiếp theo sẽ push.",
	"No account {account} is available for this session's provider.": "Không có tài khoản {account} cho nhà cung cấp của phiên này.",
	"\"{rel}\" was changed since you opened it": "\"{rel}\" đã thay đổi kể từ khi bạn mở",
	"\"{rel}\" was deleted since you opened it": "\"{rel}\" đã bị xóa kể từ khi bạn mở",
};
export default vi;
