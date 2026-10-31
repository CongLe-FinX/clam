import { afterAll, describe, expect, it } from "vitest";
import {
	deriveCodeKey,
	generateInvitationCode,
	hashInvitationCode,
	helloProofParts,
	invitationIdFromCode,
	NetworkError,
	normalizeInvitationCode,
	pairingProof,
	publicKeyToBase64,
	publicKeyToWire,
	replyProofParts,
	signTranscript,
	toBase64Url,
	transcriptHash,
	verifyPairingProof,
	verifyTranscript,
	type PairingTranscript,
} from "../src/index.ts";
import { cleanupIdentities, makeNode } from "./helpers.ts";

afterAll(cleanupIdentities);

describe("invitation codes", () => {
	it("are 8 Crockford base32 symbols (40 bits) displayed as XXXX-XXXX", () => {
		for (let i = 0; i < 200; i++) {
			const code = generateInvitationCode();
			expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
			expect(normalizeInvitationCode(code)).toHaveLength(8);
		}
	});

	it("never repeats and uses the whole alphabet roughly uniformly", () => {
		const codes = Array.from({ length: 5000 }, () => generateInvitationCode());
		expect(new Set(codes).size).toBe(5000);
		const counts = new Map<string, number>();
		for (const code of codes) for (const ch of code.replace("-", "")) counts.set(ch, (counts.get(ch) ?? 0) + 1);
		expect(counts.size).toBe(32);
		const expected = (5000 * 8) / 32;
		for (const n of counts.values()) expect(Math.abs(n - expected)).toBeLessThan(expected * 0.2);
	});

	it("normalizes case, separators and Crockford confusables", () => {
		expect(normalizeInvitationCode("abcd-ef12")).toBe("ABCDEF12");
		expect(normalizeInvitationCode("  ab cd_ef.12 ")).toBe("ABCDEF12");
		expect(normalizeInvitationCode("ABCD-EF12")).toBe("ABCDEF12");
		expect(normalizeInvitationCode("ABCD----EF12")).toBe("ABCDEF12");
		expect(normalizeInvitationCode("ab0d-ef12")).toBe("AB0DEF12");
		expect(normalizeInvitationCode("abOd-efl2")).toBe("AB0DEF12");
		expect(normalizeInvitationCode("ablD-efI2")).toBe("AB1DEF12");
		expect(normalizeInvitationCode("1111-1111")).toBe("11111111");
		expect(normalizeInvitationCode("iIlL-OoOo")).toBe("11110000");
	});

	it("rejects anything that is not exactly 8 valid symbols", () => {
		for (const bad of ["", "ABCD", "ABCD-EFGH-J", "ABCD-EFGU", "ABCD-EFG!", "ABCD-EF€H", "ÅBCD-EFGH"]) {
			expect(() => normalizeInvitationCode(bad)).toThrow(NetworkError);
		}
		try {
			normalizeInvitationCode("x");
		} catch (error) {
			expect(error).toMatchObject({ code: "invalid_request", retryable: false });
		}
	});

	it("derives the same invitation id, hash and key from any spelling of the code", () => {
		const code = "ABCD-EF12";
		const id = invitationIdFromCode(code);
		expect(id).toMatch(/^inv_[0-9a-f]{24}$/);
		for (const spelling of ["abcdef12", "ABCDEF12", " abcd ef12 ", "abcd-efl2"]) {
			expect(invitationIdFromCode(spelling)).toBe(id);
			expect(hashInvitationCode(spelling, id)).toBe(hashInvitationCode(code, id));
			expect(Buffer.from(deriveCodeKey(spelling, id)).equals(Buffer.from(deriveCodeKey(code, id)))).toBe(true);
		}
	});

	it("separates codes, invitations and purposes", () => {
		const id = invitationIdFromCode("ABCD-EF12");
		expect(invitationIdFromCode("ABCD-EF13")).not.toBe(id);
		expect(hashInvitationCode("ABCD-EF12", id)).toMatch(/^[0-9a-f]{64}$/);
		expect(hashInvitationCode("ABCD-EF13", id)).not.toBe(hashInvitationCode("ABCD-EF12", id));
		expect(hashInvitationCode("ABCD-EF12", "inv_other")).not.toBe(hashInvitationCode("ABCD-EF12", id));
		expect(hashInvitationCode("ABCD-EF12", id)).not.toContain(Buffer.from(deriveCodeKey("ABCD-EF12", id)).toString("hex"));
		const key = deriveCodeKey("ABCD-EF12", id);
		expect(key).toHaveLength(32);
		expect(Buffer.from(deriveCodeKey("ABCD-EF13", id)).equals(Buffer.from(key))).toBe(false);
		expect(Buffer.from(deriveCodeKey("ABCD-EF12", "inv_other")).equals(Buffer.from(key))).toBe(false);
	});

	it("never exposes the code in what may be stored", () => {
		const id = invitationIdFromCode("ABCD-EF12");
		expect(hashInvitationCode("ABCD-EF12", id).toLowerCase()).not.toContain("abcdef12");
		expect(id.toLowerCase()).not.toContain("abcdef12");
	});
});

describe("pairing proofs", () => {
	const code = "7K3M-Q9ZD";
	const invitationId = invitationIdFromCode(code);
	const key = deriveCodeKey(code, invitationId);
	const parts = ["node_inviter", "node_joiner", "joiner-pub", "nonce-joiner"];
	const proof = pairingProof(key, "hello", parts);

	it("is a 32-byte base64url HMAC that verifies with the same inputs", () => {
		expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(verifyPairingProof(key, "hello", parts, proof)).toBe(true);
		expect(pairingProof(key, "hello", parts)).toBe(proof);
	});

	it("does not verify with the wrong code, invitation, or role", () => {
		expect(verifyPairingProof(deriveCodeKey("7K3M-Q9ZE", invitationId), "hello", parts, proof)).toBe(false);
		expect(verifyPairingProof(deriveCodeKey(code, "inv_other"), "hello", parts, proof)).toBe(false);
		expect(verifyPairingProof(key, "reply", parts, proof)).toBe(false);
	});

	it("binds every part, their order and their boundaries", () => {
		for (let i = 0; i < parts.length; i++) {
			const changed = parts.map((p, j) => (i === j ? `${p}x` : p));
			expect(verifyPairingProof(key, "hello", changed, proof)).toBe(false);
		}
		expect(verifyPairingProof(key, "hello", parts.slice(0, 3), proof)).toBe(false);
		expect(verifyPairingProof(key, "hello", [...parts, "extra"], proof)).toBe(false);
		expect(verifyPairingProof(key, "hello", [...parts].reverse(), proof)).toBe(false);
		expect(pairingProof(key, "hello", ["ab", "c"])).not.toBe(pairingProof(key, "hello", ["a", "bc"]));
		expect(pairingProof(key, "hello", ["a|b"])).not.toBe(pairingProof(key, "hello", ["a", "b"]));
	});

	it("rejects malformed proofs without throwing", () => {
		for (const bad of ["", "short", `${proof}A`, proof.slice(1), `${proof.slice(0, 42)}!`, `${proof.slice(0, 42)}${proof.endsWith("A") ? "B" : "A"}`]) {
			expect(verifyPairingProof(key, "hello", parts, bad)).toBe(false);
		}
		expect(verifyPairingProof(key, "hello", parts, `${proof}=`)).toBe(false);
	});

	it("hello and reply proof parts bind ids, keys, nonces and the invitation", () => {
		const a = makeNode();
		const b = makeNode();
		const hello = helloProofParts({ invitationId, inviterId: a.identity.nodeId, joinerId: b.identity.nodeId, joinerPub: b.identity.publicKey, nonceJoiner: "nj" });
		const reply = replyProofParts({ invitationId, inviterId: a.identity.nodeId, inviterPub: a.identity.publicKey, joinerId: b.identity.nodeId, joinerPub: b.identity.publicKey, nonceJoiner: "nj", nonceInviter: "ni" });
		const helloProof = pairingProof(key, "hello", hello);
		expect(verifyPairingProof(key, "hello", hello, helloProof)).toBe(true);
		// the same material in the other role / a reply never validates as a hello
		expect(verifyPairingProof(key, "reply", hello, helloProof)).toBe(false);
		expect(verifyPairingProof(key, "hello", reply, pairingProof(key, "reply", reply))).toBe(false);
		// key encodings are interchangeable
		const wireForm = helloProofParts({ invitationId, inviterId: a.identity.nodeId, joinerId: b.identity.nodeId, joinerPub: publicKeyToWire(b.identity.publicKey), nonceJoiner: "nj" });
		expect(wireForm).toEqual(hello);
		// a substituted key (relay attack) breaks the proof
		const c = makeNode();
		const swapped = helloProofParts({ invitationId, inviterId: a.identity.nodeId, joinerId: b.identity.nodeId, joinerPub: c.identity.publicKey, nonceJoiner: "nj" });
		expect(verifyPairingProof(key, "hello", swapped, helloProof)).toBe(false);
		const replySwapped = replyProofParts({ invitationId, inviterId: a.identity.nodeId, inviterPub: c.identity.publicKey, joinerId: b.identity.nodeId, joinerPub: b.identity.publicKey, nonceJoiner: "nj", nonceInviter: "ni" });
		expect(verifyPairingProof(key, "reply", replySwapped, pairingProof(key, "reply", reply))).toBe(false);
	});
});

describe("transcript hash and signatures", () => {
	const inviter = makeNode();
	const joiner = makeNode();
	const other = makeNode();
	const base: PairingTranscript = {
		inviterId: inviter.identity.nodeId,
		inviterPub: inviter.identity.publicKey,
		joinerId: joiner.identity.nodeId,
		joinerPub: joiner.identity.publicKey,
		nonceInviter: toBase64Url(Buffer.alloc(16, 1)),
		nonceJoiner: toBase64Url(Buffer.alloc(16, 2)),
		invitationId: "inv_0123456789abcdef01234567",
		capabilities: ["agents.read", "tasks.send"],
	};

	it("is a 32-byte hash that is stable and insensitive to capability order/duplicates and key encoding", () => {
		const hash = transcriptHash(base);
		expect(hash).toHaveLength(32);
		expect(Buffer.from(transcriptHash({ ...base })).equals(Buffer.from(hash))).toBe(true);
		expect(Buffer.from(transcriptHash({ ...base, capabilities: ["tasks.send", "agents.read", "tasks.send"] })).equals(Buffer.from(hash))).toBe(true);
		const reencoded = { ...base, inviterPub: publicKeyToWire(base.inviterPub), joinerPub: publicKeyToBase64(base.joinerPub) };
		expect(Buffer.from(transcriptHash(reencoded)).equals(Buffer.from(hash))).toBe(true);
	});

	const mutations: Array<[string, Partial<PairingTranscript>]> = [
		["inviter id", { inviterId: "node_other" }],
		["inviter key", { inviterPub: other.identity.publicKey }],
		["joiner id", { joinerId: "node_other" }],
		["joiner key", { joinerPub: other.identity.publicKey }],
		["inviter nonce", { nonceInviter: toBase64Url(Buffer.alloc(16, 9)) }],
		["joiner nonce", { nonceJoiner: toBase64Url(Buffer.alloc(16, 9)) }],
		["invitation id", { invitationId: "inv_other" }],
		["capabilities (added)", { capabilities: ["agents.read", "tasks.send", "handoff.send"] }],
		["capabilities (removed)", { capabilities: ["agents.read"] }],
		["capabilities (rejected marker)", { capabilities: ["rejected"] }],
		["swapped roles", { inviterId: base.joinerId, inviterPub: base.joinerPub, joinerId: base.inviterId, joinerPub: base.inviterPub }],
	];
	for (const [field, change] of mutations) {
		it(`signatures bind the ${field}`, () => {
			const hash = transcriptHash(base);
			const mutated = transcriptHash({ ...base, ...change });
			expect(Buffer.from(mutated).equals(Buffer.from(hash))).toBe(false);
			const signature = signTranscript(inviter.signer, hash);
			expect(verifyTranscript(inviter.identity.publicKey, hash, signature)).toBe(true);
			expect(verifyTranscript(inviter.identity.publicKey, mutated, signature)).toBe(false);
		});
	}

	it("each side's signature verifies only under its own key, in either key encoding", () => {
		const hash = transcriptHash(base);
		const a = signTranscript(inviter.signer, hash);
		const b = signTranscript(joiner.signer, hash);
		expect(a).toMatch(/^[A-Za-z0-9_-]{86}$/);
		expect(verifyTranscript(inviter.identity.publicKey, hash, a)).toBe(true);
		expect(verifyTranscript(publicKeyToWire(inviter.identity.publicKey), hash, a)).toBe(true);
		expect(verifyTranscript(joiner.identity.publicKey, hash, b)).toBe(true);
		expect(verifyTranscript(joiner.identity.publicKey, hash, a)).toBe(false);
		expect(verifyTranscript(inviter.identity.publicKey, hash, b)).toBe(false);
		expect(verifyTranscript(other.identity.publicKey, hash, a)).toBe(false);
	});

	it("rejects malformed signatures and keys without throwing", () => {
		const hash = transcriptHash(base);
		const sig = signTranscript(inviter.signer, hash);
		expect(verifyTranscript(inviter.identity.publicKey, hash, "")).toBe(false);
		expect(verifyTranscript(inviter.identity.publicKey, hash, sig.slice(1))).toBe(false);
		expect(verifyTranscript(inviter.identity.publicKey, hash, `${sig.slice(0, 85)}!`)).toBe(false);
		expect(verifyTranscript("not-a-key", hash, sig)).toBe(false);
	});

	it("domain-separates transcript signatures from plain node-key signatures over the hash", () => {
		const hash = transcriptHash(base);
		const plain = toBase64Url(inviter.signer.sign(hash));
		expect(verifyTranscript(inviter.identity.publicKey, hash, plain)).toBe(false);
		// and the reverse: a transcript signature is not a signature over the raw hash
		const sig = signTranscript(inviter.signer, hash);
		expect(inviter.signer.sign(hash).length).toBe(64);
		expect(sig).not.toBe(plain);
	});
});
