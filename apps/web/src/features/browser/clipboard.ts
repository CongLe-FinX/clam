function legacyCopy(text: string): boolean {
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.setAttribute("readonly", "");
	ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
	const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	document.body.append(ta);
	ta.select();
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	}
	ta.remove();
	prev?.focus({ preventScroll: true });
	return ok;
}

/**
 * Write the page's selected text (answered asynchronously by the server) to the user's clipboard. The ClipboardItem path
 * keeps the user gesture alive for Safari while the answer is in flight; an empty answer never overwrites the clipboard.
 * Resolves with the copied text ("" = nothing selected / not allowed).
 */
export async function copyAnswerToClipboard(answer: Promise<string>): Promise<string> {
	if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
		try {
			let copied = "";
			const blob = answer.then((text) => {
				if (!text) throw new Error("empty");
				copied = text;
				return new Blob([text], { type: "text/plain" });
			});
			await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
			return copied;
		} catch {
			// Not allowed or empty: fall through to the plain paths below.
		}
	}
	const text = await answer;
	if (!text) return "";
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		if (!legacyCopy(text)) return "";
	}
	return text;
}
