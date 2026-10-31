import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Owner password hashing: scrypt with a per-password random salt. The stored form is self-describing
 * (`scrypt$N$r$p$salt$hash`, unpadded base64url) so the cost can be raised later without invalidating old hashes.
 */

/** OWASP's scrypt floor is N=2^17,r=8; N=2^15 (~100 ms, 32 MiB) is the minimum this node accepts and the cost it uses. */
const COST_N = 2 ** 15;
const COST_R = 8;
const COST_P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
/** Parameters read back from storage are bounded so a damaged row can never make a login allocate gigabytes. */
const MIN_N = 2 ** 14;
const MAX_N = 2 ** 18;
const MAX_R = 16;
const MAX_P = 4;

function derive(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
	const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
	scrypt(password, salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key)));
	return promise;
}

/** NFKC so the same typed password matches whichever way the OS or keyboard composed it. */
const normalize = (password: string): string => password.normalize("NFKC");

/** scrypt needs 128·N·r bytes; double it for headroom (Node's default cap of 32 MiB is exactly N=2^15, r=8 and rejects it). */
const maxmemFor = (n: number, r: number): number => 128 * n * r * 2;

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(SALT_BYTES);
	const key = await derive(normalize(password), salt, KEY_BYTES, { N: COST_N, r: COST_R, p: COST_P, maxmem: maxmemFor(COST_N, COST_R) });
	return ["scrypt", COST_N, COST_R, COST_P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

interface Parsed {
	n: number;
	r: number;
	p: number;
	salt: Buffer;
	key: Buffer;
}

function parse(stored: string): Parsed | null {
	const parts = stored.split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") return null;
	const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
	if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
	if (n < MIN_N || n > MAX_N || (n & (n - 1)) !== 0 || r < 1 || r > MAX_R || p < 1 || p > MAX_P) return null;
	const salt = Buffer.from(parts[4] ?? "", "base64url");
	const key = Buffer.from(parts[5] ?? "", "base64url");
	if (salt.length < 8 || key.length < 16) return null;
	return { n, r, p, salt, key };
}

/** Constant-time check of `password` against a stored hash; an unreadable stored value never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parsed = parse(stored);
	if (!parsed) return false;
	const candidate = await derive(normalize(password), parsed.salt, parsed.key.length, { N: parsed.n, r: parsed.r, p: parsed.p, maxmem: maxmemFor(parsed.n, parsed.r) });
	return candidate.length === parsed.key.length && timingSafeEqual(candidate, parsed.key);
}

let dummy: Promise<string> | null = null;
/**
 * A real hash of a random value, computed once. Verifying against it when no password is set (or a hash is damaged)
 * makes a failed login cost the same as a real one, so response time does not reveal whether a password exists.
 */
export function dummyHash(): Promise<string> {
	dummy ??= hashPassword(randomBytes(24).toString("base64url"));
	return dummy;
}
