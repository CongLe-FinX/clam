/**
 * What every agent session is told about the chat that shows its answers: appended to the agent's system prompt
 * (`--append-system-prompt`) for EVERY session, plain no-folder chats included. Keep it short (it is paid on every request)
 * and in step with what the web chat renders (`apps/web/src/components/rich/`: markdown, mermaid, the `chart` fence, KaTeX,
 * the files strip under each turn).
 */
export const CHAT_RENDERING_GUIDANCE =
	'The chat renders markdown. Embed an image with ![alt](relative/path.png) (path relative to your working folder). Draw diagrams in ```mermaid blocks (flowchart, sequence, pie, xychart-beta, gantt) and charts in ```chart blocks holding JSON: {"type":"bar|line|area|pie|donut|scatter","title":"…","labels":[…],"datasets":[{"label":"…","data":[…]}]}. Write math as $…$ or $$…$$. Files you create or modify in the working folder (images, video, audio, PDF, office files, csv…) are shown to the user automatically after your turn: no base64, no asking them to open files.';
