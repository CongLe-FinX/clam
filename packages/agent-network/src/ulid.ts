import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RANDOM_BITS = 80n;
const RANDOM_LIMIT = 1n << RANDOM_BITS;

let lastTime = -1;
let lastRandom = 0n;

/** Crockford base32 alphabet used by ULIDs and invitation codes. */
export const CROCKFORD_ALPHABET = ENCODING;

function encode(value: bigint, length: number): string {
	let out = "";
	let rest = value;
	for (let i = 0; i < length; i++) {
		out = ENCODING[Number(rest & 31n)] + out;
		rest >>= 5n;
	}
	return out;
}

/**
 * A ULID (26 chars: 48-bit millisecond time + 80 random bits). Within one millisecond ids are
 * strictly increasing, so ids from one process sort in creation order.
 */
export function ulid(now: number = Date.now()): string {
	let random: bigint;
	if (now === lastTime && lastRandom + 1n < RANDOM_LIMIT) {
		random = lastRandom + 1n;
	} else {
		random = BigInt(`0x${randomBytes(10).toString("hex")}`);
	}
	lastTime = now;
	lastRandom = random;
	return encode(BigInt(Math.trunc(now)), 10) + encode(random, 16);
}
