export function slugify(text: string, max = 40): string {
	let s = text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (s.length > max) s = s.slice(0, max).replace(/-+$/g, "");
	return s || "task";
}

export function taskBranchName(i: { nodeName: string; title: string; taskId: string }): string {
	const alnum = i.taskId.toLowerCase().replace(/[^a-z0-9]/g, "");
	const short = alnum.slice(-6) || "task";
	return `clam/${slugify(i.nodeName, 30)}/${slugify(i.title)}-${short}`;
}
