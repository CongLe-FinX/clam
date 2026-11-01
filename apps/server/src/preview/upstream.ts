import { connect } from "node:net";

/** The loopback addresses a dev server may listen on: `localhost` resolves to either, and Node's `localhost` servers often bind only `::1`. */
const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1"] as const;
export type UpstreamAddress = (typeof LOOPBACK_ADDRESSES)[number];

const FOUND_TTL_MS = 2_000;
const MISSING_TTL_MS = 500;
const CONNECT_TIMEOUT_MS = 400;

const cache = new Map<number, { address: UpstreamAddress | null; until: number }>();

function accepts(address: string, port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = connect({ host: address, port, timeout: CONNECT_TIMEOUT_MS });
	const done = (ok: boolean): void => {
		socket.destroy();
		resolve(ok);
	};
	socket.once("connect", () => done(true));
	socket.once("timeout", () => done(false));
	socket.once("error", () => done(false));
	return promise;
}

/**
 * Where `port` answers on THIS machine: `127.0.0.1`, else `::1`, else null (nothing listens). The upstream is always loopback — a
 * preview host can name a port, never an address — and the answer is cached for a moment so a page's burst of requests probes once.
 */
export async function findUpstream(port: number): Promise<UpstreamAddress | null> {
	const now = Date.now();
	const hit = cache.get(port);
	if (hit && hit.until > now) return hit.address;
	let address: UpstreamAddress | null = null;
	for (const candidate of LOOPBACK_ADDRESSES) {
		if (await accepts(candidate, port)) {
			address = candidate;
			break;
		}
	}
	if (cache.size > 256) for (const [key, value] of cache) if (value.until <= now) cache.delete(key);
	cache.set(port, { address, until: now + (address ? FOUND_TTL_MS : MISSING_TTL_MS) });
	return address;
}

/** Forget what was learnt about a port (tests; and a connection that failed although the probe had succeeded). */
export function forgetUpstream(port: number): void {
	cache.delete(port);
}
