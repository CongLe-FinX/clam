// i18n quality gate (run by `pnpm --filter @clam/web build`; `--only <path-prefix>` narrows the report, e.g. `--only features/overview`).
//
// 1. Extracts every `t("…")` / `msg("…")` / `<T text="…">` literal (only in files that import them from "@/i18n").
// 2. Fails on: non-literal first argument; a vi entry missing/empty for an extracted key; stale vi keys; placeholder/tag
//    mismatch between the English key and the vi value (or the params passed at the call site); conflicting translations
//    of the same key across catalogs; "CL Agent Mesh" dropped from a translation.
// 3. Lint: in the directories listed in scripts/i18n-scope.json, flags JSX text / user-facing string props / toast
//    messages that are not wrapped. False positives go in scripts/i18n-allowlist.json.
//
// Catalog layout (see src/i18n/CONVENTIONS.md): features/<f>/i18n/vi.ts · src/i18n/shell/vi.ts (merges shards
// src/i18n/shell/vi/{app,components,lib}.ts) · src/i18n/server/vi.ts (keys = `i18nMsg("…")` literals in the server).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(web, "src");
const repo = join(web, "..", "..");
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx > 0 ? process.argv[onlyIdx + 1] : null;
const scope = JSON.parse(readFileSync(join(web, "scripts/i18n-scope.json"), "utf8")).lint;
const allow = JSON.parse(readFileSync(join(web, "scripts/i18n-allowlist.json"), "utf8"));
const BRAND = "CL Agent Mesh";

const problems = []; // { file, msg }
const err = (file, msg) => problems.push({ file, msg });
const rel = (f) => relative(web, f).replaceAll("\\", "/");

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) {
			if (name !== "node_modules") walk(p, out);
		} else if (/\.tsx?$/.test(name) && !/\.(test|spec|d)\.tsx?$/.test(name)) out.push(p);
	}
	return out;
}

// Every source file must be inside the lint scope (a new feature folder is a build error until it is listed), except the i18n machinery itself.
for (const file of walk(src)) {
	const r = rel(file);
	if (r.startsWith("src/i18n/")) continue;
	if (!scope.some((s) => r.startsWith(s))) err(r, `outside scripts/i18n-scope.json "lint": add its directory so unwrapped text is caught`);
}

/** file → catalog id. Features: their folder. Shell: shard app | components | lib. */
function namespaceOf(file) {
	const r = rel(file);
	const f = /^src\/features\/([^/]+)\//.exec(r);
	if (f) return { kind: "feature", name: f[1] };
	if (r.startsWith("src/app/")) return { kind: "shell", name: "app" };
	if (r.startsWith("src/components/")) return { kind: "shell", name: "components" };
	return { kind: "shell", name: "lib" };
}

// ── template helpers ──────────────────────────────────────────────────────────
/** Placeholder names (`{x}`, plural/select selector + nested) and rich tags (`<b>`) of a template, as a sorted unique list. */
function signature(template) {
	const names = new Set();
	const scan = (s, i, nested) => {
		while (i < s.length) {
			const c = s[i];
			if (c === "}" && nested) return i;
			if (c === "{" && s[i + 1] === "{") i += 2;
			else if (c === "{") {
				i++;
				const nameEnd = s.slice(i).search(/[,}]/);
				if (nameEnd < 0) throw new Error("unclosed {");
				names.add(s.slice(i, i + nameEnd).trim());
				i += nameEnd;
				if (s[i] === ",") {
					i = s.indexOf(",", i + 1) + 1;
					if (i === 0) throw new Error("bad plural/select");
					for (;;) {
						while (/\s/.test(s[i] ?? "")) i++;
						if (s[i] === "}") break;
						const open = s.indexOf("{", i);
						if (open < 0) throw new Error("bad plural option");
						i = scan(s, open + 1, true) + 1;
						if (i === 0 || i > s.length) throw new Error("unclosed option");
					}
				}
				i++;
			} else i++;
		}
		if (nested) throw new Error("unclosed {");
		return i;
	};
	scan(template, 0, false);
	for (const m of template.matchAll(/<\/?([a-z][a-z0-9]*)\s*\/?>/g)) names.add(`<${m[1]}>`);
	return [...names].sort();
}
const sigStr = (s) => s.join(", ") || "(none)";

// ── extraction ────────────────────────────────────────────────────────────────
function literal(node) {
	if (!node) return null;
	if (ts.isStringLiteralLike(node)) return node.text;
	if (ts.isParenthesizedExpression(node)) return literal(node.expression);
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const a = literal(node.left);
		const b = literal(node.right);
		return a != null && b != null ? a + b : null;
	}
	return null;
}

const TEXT_PROPS = new Set(["title", "placeholder", "aria-label", "aria-description", "alt", "label", "description", "tooltip", "summary", "heading", "subtitle", "emptyText", "confirmLabel", "cancelLabel", "hint"]);
const OBJ_PROPS = new Set(["label", "title", "description", "placeholder", "hint", "tooltip", "heading", "subtitle", "emptyText"]);
const TOAST = new Set(["success", "error", "info", "warning", "message", "loading"]);
const looksLikeText = (s) => /\p{L}{2,}/u.test(s);

/** keys: Map<key, {files:Set, sig}>  per namespace */
const extracted = new Map(); // `${kind}:${name}` → Map<key, Set<file>>
function addKey(ns, key, file) {
	const id = `${ns.kind}:${ns.name}`;
	if (!extracted.has(id)) extracted.set(id, new Map());
	const m = extracted.get(id);
	if (!m.has(key)) m.set(key, new Set());
	m.get(key).add(rel(file));
}

function lintAllowed(file, text) {
	const t = text.trim();
	return (allow["*"] ?? []).includes(t) || (allow[rel(file)] ?? []).includes(t);
}

function scanFile(file) {
	const text = readFileSync(file, "utf8");
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	const ns = namespaceOf(file);
	const inScope = scope.some((s) => rel(file).startsWith(s));
	const local = { t: null, msg: null, T: null };
	for (const st of sf.statements) {
		if (ts.isImportDeclaration(st) && st.moduleSpecifier.text === "@/i18n" && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
			for (const el of st.importClause.namedBindings.elements) {
				const orig = (el.propertyName ?? el.name).text;
				if (orig in local) local[orig] = el.name.text;
			}
		}
	}
	const where = (n) => `${rel(file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
	const flag = (n, what, t) => {
		if (!lintAllowed(file, t)) err(rel(file), `${where(n)} unwrapped ${what}: ${JSON.stringify(t.trim().slice(0, 80))}`);
	};

	const checkCall = (node, fnName) => {
		const key = literal(node.arguments[0]);
		if (key == null) return err(rel(file), `${where(node)} ${fnName}() needs a string literal (use msg("…") + tr(x) for tables)`);
		let sig;
		try {
			sig = signature(key);
		} catch (e) {
			return err(rel(file), `${where(node)} invalid message ${JSON.stringify(key)}: ${e.message}`);
		}
		addKey(ns, key, file);
		const p = node.arguments[1];
		if (fnName === "t" && p && ts.isObjectLiteralExpression(p) && p.properties.every((x) => ts.isShorthandPropertyAssignment(x) || ts.isPropertyAssignment(x))) {
			const given = [...new Set(p.properties.map((x) => x.name.getText(sf).replace(/^["']|["']$/g, "")))].sort();
			const want = sig.filter((s) => !s.startsWith("<"));
			if (given.join() !== want.join()) err(rel(file), `${where(node)} params {${given}} do not match placeholders {${want}} of ${JSON.stringify(key)}`);
		} else if (fnName === "t" && sig.some((s) => !s.startsWith("<")) && !p) {
			err(rel(file), `${where(node)} ${JSON.stringify(key)} has placeholders but no params`);
		}
	};

	const visit = (node) => {
		if (ts.isCallExpression(node)) {
			const fn = node.expression;
			if (ts.isIdentifier(fn) && (fn.text === local.t || fn.text === local.msg) && fn.text) checkCall(node, fn.text === local.t ? "t" : "msg");
			if (inScope && ts.isPropertyAccessExpression(fn) && ts.isIdentifier(fn.expression) && fn.expression.text === "toast" && TOAST.has(fn.name.text)) {
				const lit = literal(node.arguments[0]);
				if (lit != null && looksLikeText(lit)) flag(node, "toast", lit);
			}
		} else if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ts.isIdentifier(node.tagName) && local.T && node.tagName.text === local.T) {
			const attr = node.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.text === "text");
			const init = attr?.initializer;
			const key = init && (ts.isStringLiteral(init) ? init.text : ts.isJsxExpression(init) ? literal(init.expression) : null);
			if (key == null) err(rel(file), `${where(node)} <T text> needs a string literal`);
			else {
				try {
					signature(key);
					addKey(ns, key, file);
				} catch (e) {
					err(rel(file), `${where(node)} invalid message ${JSON.stringify(key)}: ${e.message}`);
				}
			}
		} else if (inScope && ts.isPropertyAssignment(node) && OBJ_PROPS.has(node.name.getText(sf).replace(/^["']|["']$/g, ""))) {
			const lit = literal(node.initializer);
			if (lit != null && looksLikeText(lit)) flag(node, `property ${node.name.getText(sf)} (wrap in msg("…") and render with tr())`, lit);
		} else if (inScope && ts.isJsxText(node)) {
			if (looksLikeText(node.text)) flag(node, "JSX text", node.text.replace(/\s+/g, " "));
		} else if (inScope && ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent)) {
			const lit = literal(node.expression);
			if (lit != null && looksLikeText(lit)) flag(node, "JSX string", lit);
		} else if (inScope && ts.isJsxAttribute(node) && TEXT_PROPS.has(node.name.text) && node.initializer) {
			const lit = ts.isStringLiteral(node.initializer) ? node.initializer.text : ts.isJsxExpression(node.initializer) ? literal(node.initializer.expression) : null;
			if (lit != null && looksLikeText(lit)) flag(node, `prop ${node.name.text}`, lit);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
}

// ── catalogs ──────────────────────────────────────────────────────────────────
async function loadCatalog(path) {
	if (!existsSync(path)) return null;
	const mod = await import(`${pathToFileURL(path).href}?t=${Date.now()}`);
	return mod.default;
}

function checkEntries(file, label, keys, catalog, { requireAll = true } = {}) {
	if (!catalog) {
		if (keys.size) err(file, `${label}: catalog file missing — it must hold ${keys.size} key(s)`);
		return;
	}
	const missing = [];
	for (const [key, files] of keys) {
		const v = catalog[key];
		if (v == null || v === "") {
			if (requireAll) missing.push(key);
			continue;
		}
		try {
			const a = sigStr(signature(key));
			const b = sigStr(signature(v));
			if (a !== b) err(file, `${label}: placeholders differ for ${JSON.stringify(key)} — en {${a}} vs vi {${b}}`);
		} catch (e) {
			err(file, `${label}: invalid vi message for ${JSON.stringify(key)}: ${e.message}`);
		}
		if (key.includes(BRAND) && !v.includes(BRAND)) err(file, `${label}: "${BRAND}" must stay untranslated in ${JSON.stringify(key)}`);
	}
	if (missing.length) err(file, `${label}: ${missing.length} missing vi entr${missing.length === 1 ? "y" : "ies"}; add:\n${missing.map((k) => `\t${JSON.stringify(k)}: "",`).join("\n")}`);
	const stale = Object.keys(catalog).filter((k) => !keys.has(k));
	if (stale.length) err(file, `${label}: ${stale.length} stale vi key(s) no longer used: ${stale.map((k) => JSON.stringify(k)).join(", ")}`);
}

function serverKeys() {
	const keys = new Map();
	const roots = [join(repo, "apps/server/src"), ...(existsSync(join(repo, "packages")) ? readdirSync(join(repo, "packages")).map((p) => join(repo, "packages", p, "src")) : [])];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		for (const f of walk(root)) {
			const text = readFileSync(f, "utf8");
			if (!text.includes("i18nMsg(")) continue;
			const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
			const visit = (n) => {
				if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "i18nMsg") {
					const k = literal(n.arguments[0]);
					const at = `${relative(repo, f)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
					if (k == null) err(relative(repo, f), `${at} i18nMsg() needs a string literal`);
					else {
						try {
							signature(k);
						} catch (e) {
							err(relative(repo, f), `${at} invalid message ${JSON.stringify(k)}: ${e.message}`);
						}
						if (!keys.has(k)) keys.set(k, new Set());
						keys.get(k).add(at);
					}
				}
				ts.forEachChild(n, visit);
			};
			visit(sf);
		}
	}
	return keys;
}

// ── main ──────────────────────────────────────────────────────────────────────
for (const f of walk(src)) {
	if (rel(f).startsWith("src/i18n/")) continue;
	scanFile(f);
}

const catalogs = new Map(); // path → catalog, for cross-catalog conflicts
const remember = (path, c) => c && catalogs.set(path, c);

const featureDirs = readdirSync(join(src, "features")).filter((d) => statSync(join(src, "features", d)).isDirectory());
for (const name of new Set([...featureDirs, ...[...extracted.keys()].filter((k) => k.startsWith("feature:")).map((k) => k.slice(8))])) {
	const path = join(src, "features", name, "i18n/vi.ts");
	const c = await loadCatalog(path);
	remember(path, c);
	const keys = extracted.get(`feature:${name}`) ?? new Map();
	if (keys.size || c) checkEntries(rel(path), `features/${name}`, keys, c);
}

const shellPath = join(src, "i18n/shell/vi.ts");
const shell = await loadCatalog(shellPath);
remember(shellPath, shell);
const union = new Map();
for (const shard of ["app", "components", "lib"]) {
	const keys = extracted.get(`shell:${shard}`) ?? new Map();
	for (const [k, v] of keys) union.set(k, v);
	const path = join(src, `i18n/shell/vi/${shard}.ts`);
	const c = await loadCatalog(path);
	remember(path, c);
	if (keys.size || c) checkEntries(rel(path), `shell/${shard}`, keys, c);
}
if (union.size || shell) {
	if (!shell) err(rel(shellPath), "shell catalog missing: src/i18n/shell/vi.ts must merge the shards in src/i18n/shell/vi/");
	else for (const k of union.keys()) if (!shell[k]) err(rel(shellPath), `shell/vi.ts does not include shard entry ${JSON.stringify(k)} (spread every shard)`);
}

const serverPath = join(src, "i18n/server/vi.ts");
const server = await loadCatalog(serverPath);
remember(serverPath, server);
const sKeys = serverKeys();
if (sKeys.size || server) checkEntries(rel(serverPath), "server", sKeys, server);

const seenVi = new Map();
for (const [path, c] of catalogs) {
	for (const [k, v] of Object.entries(c)) {
		const prev = seenVi.get(k);
		if (prev && prev.v !== v) err(rel(path), `conflicting vi for ${JSON.stringify(k)}: ${JSON.stringify(v)} vs ${JSON.stringify(prev.v)} in ${rel(prev.path)}`);
		else seenVi.set(k, { v, path });
	}
}

const shown = problems.filter((p) => !only || p.file.startsWith(only) || p.file.includes(`/${only}`) || p.file.includes(only));
if (shown.length) {
	console.error(`check-i18n: ${shown.length} problem(s)${only ? ` (filtered by "${only}")` : ""}`);
	for (const p of shown) console.error(p.msg.startsWith(p.file) ? `  ${p.msg}` : `  ${p.file}\n    ${p.msg.replaceAll("\n", "\n    ")}`);
	process.exit(1);
}
const total = [...extracted.values()].reduce((n, m) => n + m.size, 0) + sKeys.size;
console.log(`check-i18n: ok — ${total} keys across ${extracted.size + (sKeys.size ? 1 : 0)} namespaces; lint scope: ${scope.length} dirs`);
