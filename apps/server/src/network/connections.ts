/** Open inbound `/events` connections by peer, so revoking a peer can end its streams immediately. */
export class ConnectionRegistry {
	private readonly byPeer = new Map<string, Set<{ close(): void }>>();

	add(peerId: string, connection: { close(): void }): () => void {
		let set = this.byPeer.get(peerId);
		if (!set) {
			set = new Set();
			this.byPeer.set(peerId, set);
		}
		set.add(connection);
		return () => {
			set.delete(connection);
			if (set.size === 0 && this.byPeer.get(peerId) === set) this.byPeer.delete(peerId);
		};
	}

	count(peerId?: string): number {
		if (peerId) return this.byPeer.get(peerId)?.size ?? 0;
		let n = 0;
		for (const set of this.byPeer.values()) n += set.size;
		return n;
	}

	closePeer(peerId: string): void {
		for (const connection of [...(this.byPeer.get(peerId) ?? [])]) connection.close();
	}

	closeAll(): void {
		for (const peerId of [...this.byPeer.keys()]) this.closePeer(peerId);
	}
}
