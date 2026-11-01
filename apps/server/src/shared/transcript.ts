import type { UiBlock, UiMessage } from "@clam/contracts";

/** Which messages an applied event touched (for write-through persistence). */
export interface TranscriptChange {
	changed: string[];
	removed: string[];
}

const NONE: TranscriptChange = { changed: [], removed: [] };

/**
 * The transcript of a session rebuilt from its `SessionEvent` stream: the driver keeps one to serve full re-syncs of a
 * mirror, a participant keeps one per mirror to persist what it receives. Only message events matter (`message_start`
 * and `message_end` upsert a whole message by id, `message_delta` grows a text/thinking block, `message_removed` drops
 * one); everything else (tool progress, state, notices) is for live viewers and not part of the transcript.
 * Messages are replaced, never mutated, so a copy of `messages()` stays valid while events keep arriving.
 */
export class TranscriptReducer {
	private order: string[] = [];
	private readonly byId = new Map<string, UiMessage>();

	constructor(initial: readonly UiMessage[] = []) {
		this.replace(initial);
	}

	replace(messages: readonly UiMessage[]): void {
		this.order = [];
		this.byId.clear();
		for (const message of messages) {
			if (!this.byId.has(message.id)) this.order.push(message.id);
			this.byId.set(message.id, message);
		}
	}

	/**
	 * Lay the events that arrived while the snapshot given to `replace` was being read over that snapshot. The read may have seen
	 * none, some or all of them, so they are applied in the way that ends with the same transcript in every case: `message_start` and
	 * `message_end` carry the whole message (an upsert, in order), a delta only grows a message whose start is among these events
	 * (any other message may already hold it in the read; its `message_end` carries the rest), a removal removes.
	 */
	overlay(events: ReadonlyArray<{ type: string } & Record<string, unknown>>): void {
		const arrived = new TranscriptReducer();
		const removed: string[] = [];
		for (const event of events) {
			arrived.apply(event);
			if (event.type === "message_removed" && typeof event.messageId === "string") removed.push(event.messageId);
		}
		for (const message of arrived.messages()) this.apply({ type: "message_end", message });
		for (const id of removed) this.apply({ type: "message_removed", messageId: id });
	}

	get size(): number {
		return this.order.length;
	}

	get(id: string): UiMessage | undefined {
		return this.byId.get(id);
	}

	/** Chronological (first appearance). */
	messages(): UiMessage[] {
		return this.order.map((id) => this.byId.get(id) as UiMessage);
	}

	apply(event: { type: string } & Record<string, unknown>): TranscriptChange {
		switch (event.type) {
			case "message_start":
			case "message_end": {
				const message = event.message as UiMessage | undefined;
				if (!message || typeof message.id !== "string") return NONE;
				if (!this.byId.has(message.id)) this.order.push(message.id);
				this.byId.set(message.id, message);
				return { changed: [message.id], removed: [] };
			}
			case "message_delta": {
				const id = event.messageId;
				const index = event.contentIndex;
				const delta = event.delta;
				const kind = event.kind;
				if (typeof id !== "string" || typeof index !== "number" || !Number.isInteger(index) || index < 0 || typeof delta !== "string") return NONE;
				// A tool call's arguments arrive whole with `message_end`; only text and thinking grow.
				if (kind !== "text" && kind !== "thinking") return NONE;
				const message = this.byId.get(id);
				if (!message) return NONE;
				const content: UiBlock[] = [...message.content];
				while (content.length <= index) content.push({ type: kind, text: "" });
				const block = content[index] as UiBlock;
				if (block.type !== "text" && block.type !== "thinking") return NONE;
				content[index] = { ...block, text: block.text + delta };
				this.byId.set(id, { ...message, content });
				return { changed: [id], removed: [] };
			}
			case "message_removed": {
				const id = event.messageId;
				if (typeof id !== "string" || !this.byId.delete(id)) return NONE;
				this.order = this.order.filter((existing) => existing !== id);
				return { changed: [], removed: [id] };
			}
			default:
				return NONE;
		}
	}
}
