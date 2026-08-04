import { describe, expect, it } from "vitest";

import {
  G1_BYTES,
  G2_BYTES,
  HASH_TO_G1_DST,
  REDEEM_DOMAIN,
  blindSign,
  blindToken,
  bytesToScalar,
  deriveTokenSecrets,
  deserializeG1,
  fromHex,
  hashNullifierToG1,
  mintKeypairFromSeed,
  scalarToBytes,
  serializeG1,
  signRedemption,
  toHex,
  unblindSignature,
  verifyBlindSignature,
  verifyRedemption,
} from "../src/crypto.js";
import { buildRedemptionMessage } from "../src/soroban.js";
import { generate } from "../src/vectors.js";

const SEED = fromHex("11".repeat(32));
const MINT = mintKeypairFromSeed(fromHex("00".repeat(31) + "2a"));
const VAULT = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";
const ALICE = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";

describe("token derivation", () => {
  it("is deterministic in the seed and index", () => {
    const a = deriveTokenSecrets(SEED, 3);
    const b = deriveTokenSecrets(SEED, 3);
    expect(toHex(a.nullifier)).toBe(toHex(b.nullifier));
    expect(toHex(a.depositId)).toBe(toHex(b.depositId));
    expect(a.r).toBe(b.r);
  });

  it("gives every index a distinct identity", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const token = deriveTokenSecrets(SEED, i);
      seen.add(toHex(token.nullifier));
      seen.add(toHex(token.depositId));
    }
    expect(seen.size).toBe(32);
  });

  it("separates deposit id from nullifier", () => {
    // These are the two values that appear on chain. If one could be derived
    // from the other, deposits and redemptions would be trivially linkable.
    const token = deriveTokenSecrets(SEED, 0);
    expect(toHex(token.depositId)).not.toBe(toHex(token.nullifier));
  });

  it("produces a blinding factor inside the scalar field", () => {
    for (let i = 0; i < 8; i++) {
      const { r } = deriveTokenSecrets(SEED, i);
      expect(r).toBeGreaterThan(0n);
      expect(scalarToBytes(r)).toHaveLength(32);
      expect(bytesToScalar(scalarToBytes(r))).toBe(r);
    }
  });

  it("rejects an out-of-range index rather than silently aliasing", () => {
    expect(() => deriveTokenSecrets(SEED, -1)).toThrow();
    expect(() => deriveTokenSecrets(SEED, 1.5)).toThrow();
    expect(() => deriveTokenSecrets(SEED, 2 ** 32)).toThrow();
  });
});

describe("blind signatures", () => {
  it("round-trips blind, sign, unblind", () => {
    const token = deriveTokenSecrets(SEED, 0);
    const { Y, B } = blindToken(token.nullifier, token.r);
    const s = unblindSignature(blindSign(B, MINT.sk), token.r);

    // The unblinded signature is exactly sk·Y — a signature over a point the
    // mint never saw.
    expect(toHex(serializeG1(s))).toBe(toHex(serializeG1(Y.multiply(MINT.sk))));
    expect(verifyBlindSignature(serializeG1(s), token.nullifier, MINT.pk)).toBe(true);
  });

  it("hides the nullifier behind the blinding factor", () => {
    const token = deriveTokenSecrets(SEED, 0);
    const { Y, B } = blindToken(token.nullifier, token.r);
    expect(toHex(serializeG1(B))).not.toBe(toHex(serializeG1(Y)));
  });

  it("rejects a signature that is still blinded", () => {
    const token = deriveTokenSecrets(SEED, 0);
    const { B } = blindToken(token.nullifier, token.r);
    const sPrime = blindSign(B, MINT.sk);
    expect(verifyBlindSignature(serializeG1(sPrime), token.nullifier, MINT.pk)).toBe(false);
  });

  it("rejects a signature bound to a different nullifier", () => {
    const a = deriveTokenSecrets(SEED, 0);
    const b = deriveTokenSecrets(SEED, 1);
    const s = unblindSignature(blindSign(blindToken(a.nullifier, a.r).B, a.r), a.r);
    expect(verifyBlindSignature(serializeG1(s), b.nullifier, MINT.pk)).toBe(false);
  });

  it("rejects a signature from a different mint", () => {
    const rogue = mintKeypairFromSeed(fromHex("ff".repeat(32)));
    const token = deriveTokenSecrets(SEED, 0);
    const { B } = blindToken(token.nullifier, token.r);
    const s = unblindSignature(blindSign(B, rogue.sk), token.r);
    expect(verifyBlindSignature(serializeG1(s), token.nullifier, MINT.pk)).toBe(false);
  });

  it("rejects malformed input instead of throwing", () => {
    const token = deriveTokenSecrets(SEED, 0);
    expect(verifyBlindSignature(new Uint8Array(G1_BYTES), token.nullifier, MINT.pk)).toBe(false);
    expect(verifyBlindSignature(new Uint8Array(10), token.nullifier, MINT.pk)).toBe(false);
  });

  it("makes different blinding factors give different deposits", () => {
    const token = deriveTokenSecrets(SEED, 0);
    const first = blindToken(token.nullifier, token.r);
    const second = blindToken(token.nullifier, token.r + 1n);
    expect(toHex(serializeG1(first.B))).not.toBe(toHex(serializeG1(second.B)));
  });
});

describe("serialisation", () => {
  it("uses the uncompressed lengths Soroban expects", () => {
    expect(serializeG1(hashNullifierToG1(new Uint8Array(32)))).toHaveLength(G1_BYTES);
    expect(MINT.pk).toHaveLength(G2_BYTES);
  });

  it("round-trips G1 points", () => {
    const Y = hashNullifierToG1(deriveTokenSecrets(SEED, 4).nullifier);
    expect(toHex(serializeG1(deserializeG1(serializeG1(Y))))).toBe(toHex(serializeG1(Y)));
  });

  it("leaves the flag bits clear on uncompressed points", () => {
    // Soroban reads the top three bits of the first byte as compression,
    // infinity, and sort flags; a set bit here would be rejected on chain.
    const bytes = serializeG1(hashNullifierToG1(deriveTokenSecrets(SEED, 0).nullifier));
    expect(bytes[0]! & 0b1110_0000).toBe(0);
    expect(MINT.pk[0]! & 0b1110_0000).toBe(0);
  });

  it("rejects wrong-length points", () => {
    expect(() => deserializeG1(new Uint8Array(64))).toThrow(/96 bytes/);
  });
});

describe("redemption messages", () => {
  it("commits to the domain, the vault, and the recipient", () => {
    const message = buildRedemptionMessage(VAULT, ALICE);
    expect(message.slice(0, REDEEM_DOMAIN.length)).toEqual(REDEEM_DOMAIN);
    expect(message.length).toBeGreaterThan(REDEEM_DOMAIN.length);
  });

  it("differs per recipient, which is what stops front-running", () => {
    const bob = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
    const contract = "CBRXA4DSMVRWS4DJMVXHIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABUQE";
    expect(toHex(buildRedemptionMessage(VAULT, bob))).not.toBe(
      toHex(buildRedemptionMessage(VAULT, contract)),
    );
  });

  it("differs per vault, which is what stops cross-vault replay", () => {
    const other = "CBRXA4DSMVRWS4DJMVXHIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABUQE";
    expect(toHex(buildRedemptionMessage(VAULT, ALICE))).not.toBe(
      toHex(buildRedemptionMessage(other, ALICE)),
    );
  });

  it("verifies only under the token's own spend key", () => {
    const token = deriveTokenSecrets(SEED, 0);
    const other = deriveTokenSecrets(SEED, 1);
    const message = buildRedemptionMessage(VAULT, ALICE);
    const sig = signRedemption(token.spendSecret, message);

    expect(verifyRedemption(token.nullifier, message, sig)).toBe(true);
    expect(verifyRedemption(other.nullifier, message, sig)).toBe(false);
  });

  it("does not verify against a different recipient's message", () => {
    const token = deriveTokenSecrets(SEED, 0);
    const contract = "CBRXA4DSMVRWS4DJMVXHIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABUQE";
    const sig = signRedemption(token.spendSecret, buildRedemptionMessage(VAULT, ALICE));
    expect(verifyRedemption(token.nullifier, buildRedemptionMessage(VAULT, contract), sig)).toBe(
      false,
    );
  });
});

describe("test vectors", () => {
  const vectors = generate();

  it("uses the DST the contract advertises", () => {
    expect(vectors.dst).toBe(HASH_TO_G1_DST);
  });

  it("regenerates identically", () => {
    // The Rust side hardcodes these bytes. If generation were not reproducible,
    // `vectors.rs` would silently drift out of date.
    expect(JSON.stringify(generate())).toBe(JSON.stringify(vectors));
  });

  it("holds up under its own verification", () => {
    for (const token of vectors.tokens) {
      const nullifier = fromHex(token.nullifier);
      expect(verifyBlindSignature(fromHex(token.s), nullifier, fromHex(vectors.mintPk))).toBe(true);
      expect(
        verifyRedemption(nullifier, fromHex(vectors.messageAccount), fromHex(token.spendSigAccount)),
      ).toBe(true);
      expect(
        verifyRedemption(
          nullifier,
          fromHex(vectors.messageContract),
          fromHex(token.spendSigContract),
        ),
      ).toBe(true);
    }
  });

  it("matches what the derivation functions produce today", () => {
    for (const vector of vectors.tokens) {
      const token = deriveTokenSecrets(fromHex(vectors.walletSeed), vector.index);
      expect(toHex(token.nullifier)).toBe(vector.nullifier);
      expect(toHex(token.depositId)).toBe(vector.depositId);
      expect(toHex(serializeG1(hashNullifierToG1(token.nullifier)))).toBe(vector.y);
    }
  });
});
