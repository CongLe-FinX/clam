/**
 * The "First prompt" typed in the New session dialog is sent by the server at creation time, before the session
 * page exists. The dialog hands the text over here so the page can render it optimistically (same `clientId`
 * the server uses, `init_<sessionId>`) instead of showing an empty conversation until OMP echoes it.
 */
const pending = new Map<string, string>();

export const initialPromptClientId = (sessionId: string): string => `init_${sessionId}`;

export function rememberInitialPrompt(sessionId: string, text: string): void {
	pending.set(sessionId, text);
}

export const peekInitialPrompt = (sessionId: string): string | null => pending.get(sessionId) ?? null;
export const clearInitialPrompt = (sessionId: string): void => void pending.delete(sessionId);
