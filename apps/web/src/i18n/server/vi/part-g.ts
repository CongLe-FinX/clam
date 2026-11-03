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
};
export default vi;
