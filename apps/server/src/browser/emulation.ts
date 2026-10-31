import { DESKTOP_VIEWPORT_WIDTH, IPHONE_VIEWPORT, type BrowserClientMessage, type BrowserDevice, type BrowserViewport } from "@clam/contracts";

export interface ViewerSize {
	width: number;
	height: number;
	dpr: number;
	device: BrowserDevice;
}

/** Frames are captured at most at this device pixel ratio: more only costs bandwidth. */
export const MAX_DPR = 2;
const MIN_DIMENSION = 100;
const MAX_DIMENSION = 4096;

export const IPHONE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const clamp = (value: number): number => Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.round(value)));

/** The page viewport to emulate for a viewer of this size and device mode. */
export function computeViewport(size: ViewerSize): BrowserViewport {
	const deviceScale = Math.min(MAX_DPR, Math.max(1, size.dpr));
	if (size.device === "iphone") return { width: IPHONE_VIEWPORT.width, height: IPHONE_VIEWPORT.height, deviceScale, mobile: true, device: "iphone" };
	if (size.device === "desktop") {
		const aspect = size.height / Math.max(1, size.width);
		return { width: DESKTOP_VIEWPORT_WIDTH, height: clamp(DESKTOP_VIEWPORT_WIDTH * aspect), deviceScale, mobile: false, device: "desktop" };
	}
	return { width: clamp(size.width), height: clamp(size.height), deviceScale, mobile: false, device: "fit" };
}

export const sameViewport = (a: BrowserViewport | null, b: BrowserViewport): boolean =>
	a !== null && a.width === b.width && a.height === b.height && a.deviceScale === b.deviceScale && a.mobile === b.mobile && a.device === b.device;

type KeyMessage = Extract<BrowserClientMessage, { type: "key" }>;

const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

/** Editing shortcuts that Chromium only runs when told which command the chord means (the viewer may be a different OS than this machine). */
function editingCommands(message: KeyMessage): string[] | undefined {
	if (!(message.modifiers & (CTRL | META)) || message.modifiers & ALT) return undefined;
	const key = message.key.toLowerCase();
	if (key === "a") return ["selectAll"];
	if (key === "z") return message.modifiers & SHIFT ? ["redo"] : ["undo"];
	if (key === "y") return ["redo"];
	return undefined;
}

/** Parameters for `Input.dispatchKeyEvent` from a viewer key event. Printable keys carry their text; chords and named keys are raw key events. */
export function keyEventParams(message: KeyMessage): Record<string, unknown> {
	const { modifiers } = message;
	const printable = [...message.key].length === 1;
	const chord = Boolean(modifiers & (CTRL | META)) && !(modifiers & CTRL && modifiers & ALT && !(modifiers & META)); // AltGr (Ctrl+Alt) still types
	const text = message.key === "Enter" ? "\r" : printable && !chord ? message.key : "";
	const common = { modifiers, key: message.key, code: message.code, windowsVirtualKeyCode: message.keyCode, nativeVirtualKeyCode: message.keyCode, location: message.location, autoRepeat: message.repeat };
	if (message.action === "up") return { type: "keyUp", ...common };
	const commands = editingCommands(message);
	return text ? { type: "keyDown", ...common, text, unmodifiedText: text } : { type: "rawKeyDown", ...common, ...(commands && { commands }) };
}

/** Console-friendly text for a CDP `Runtime.RemoteObject` (strings raw, primitives as-is, objects by description and a short preview). */
export function describeRemoteObject(object: { type?: string; subtype?: string; value?: unknown; unserializableValue?: string; description?: string; preview?: { properties?: Array<{ name: string; value?: string; type: string }>; overflow?: boolean } }): string {
	if (object.type === "string") return String(object.value);
	if (object.value !== undefined) return typeof object.value === "object" ? JSON.stringify(object.value) : String(object.value);
	if (object.unserializableValue !== undefined) return object.unserializableValue;
	if (object.type === "undefined") return "undefined";
	if (object.subtype === "null") return "null";
	const properties = object.preview?.properties;
	if (properties && properties.length > 0 && object.subtype !== "error") {
		const body = properties.map((p) => `${object.subtype === "array" ? "" : `${p.name}: `}${p.type === "string" ? JSON.stringify(p.value) : (p.value ?? p.type)}`).join(", ");
		const wrapped = object.subtype === "array" ? `[${body}${object.preview?.overflow ? ", …" : ""}]` : `{${body}${object.preview?.overflow ? ", …" : ""}}`;
		return object.subtype === "array" || object.description === "Object" ? wrapped : `${object.description ?? ""} ${wrapped}`;
	}
	return object.description ?? object.type ?? "";
}
