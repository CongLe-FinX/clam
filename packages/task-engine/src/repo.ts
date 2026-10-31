export interface NormalizedRepo {
	owner: string;
	name: string;
	key: string;
	url: string;
}

const SEG = /^[A-Za-z0-9._-]+$/;

export function repoKey(owner: string, name: string): string {
	return `${owner}/${name}`.toLowerCase();
}

export function normalizeRepoUrl(input: string): NormalizedRepo | null {
	let s = input.trim();
	if (!s) return null;
	let path: string;
	let m: RegExpMatchArray | null;
	if ((m = s.match(/^[A-Za-z0-9._-]+@github\.com:(.+)$/i))) {
		path = m[1]!;
	} else if (/^https:\/\//i.test(s) || /^ssh:\/\//i.test(s)) {
		let u: URL;
		try {
			u = new URL(s);
		} catch {
			return null;
		}
		if (u.hostname.toLowerCase() !== "github.com") return null;
		if (u.port) return null;
		path = u.pathname;
	} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
		return null;
	} else if ((m = s.match(/^github\.com\/(.+)$/i))) {
		path = m[1]!;
		path = path.replace(/[?#].*$/, "");
	} else {
		return null;
	}
	const parts = path.split("/").filter((p) => p.length > 0);
	if (parts.length !== 2) return null;
	const owner = parts[0]!;
	let name = parts[1]!;
	if (name.toLowerCase().endsWith(".git")) name = name.slice(0, -4);
	if (!SEG.test(owner) || !SEG.test(name)) return null;
	if (owner === "." || owner === ".." || name === "." || name === "..") return null;
	return { owner, name, key: repoKey(owner, name), url: `https://github.com/${owner}/${name}` };
}

const encodeRef = (r: string): string => r.split("/").map(encodeURIComponent).join("/");

export function compareUrl(repo: { owner: string; name: string }, base: string | null, branch: string): string {
	const root = `https://github.com/${repo.owner}/${repo.name}`;
	if (base === null) return `${root}/tree/${encodeRef(branch)}`;
	return `${root}/compare/${encodeRef(base)}...${encodeRef(branch)}`;
}
