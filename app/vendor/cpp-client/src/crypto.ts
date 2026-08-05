/**
 * Compliant Privacy Pool — client-side cryptography.
 *
 * This module is the off-chain source of truth. Every value it produces is
 * consumed by `contracts/vault`, so the two must agree byte-for-byte:
 *
 *  - G1/G2 points serialise uncompressed, big-endian, in the ZCash layout that
 *    Soroban's BLS12-381 host functions expect (`be(X)||be(Y)` for G1,
 *    `be(X_c1)||be(X_c0)||be(Y_c1)||be(Y_c0)` for G2). @noble/curves emits
 *    exactly this from `toBytes(false)`.
 *  - `hashToCurve` uses the same RFC 9380 suite and the same DST as the
 *    contract's `hash_to_g1` call.
 *
 * `test/parity.test.ts` pins both against vectors the contract verifies.
 */

import { bls12_381 } from "@noble/curves/bls12-381.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

const { Fr } = bls12_381.fields;

export const G1_BYTES = 96;
export const G2_BYTES = 192;

/**
 * RFC 9380 domain separation tag. Must equal `crypto::HASH_TO_G1_DST` in the
 * contract — a mismatch produces a different `Y` and every pairing fails.
 */
export const HASH_TO_G1_DST = "CPP-V1-CS01-with-BLS12381G1_XMD:SHA-256_SSWU_RO_";

/** Must equal `crypto::REDEEM_DOMAIN` in the contract. */
export const REDEEM_DOMAIN = new TextEncoder().encode("CPP-V1-REDEEM");

/** Key-derivation domain separators. */
const DOMAIN_SPEND = new TextEncoder().encode("CPP-V1-spend");
const DOMAIN_BLIND = new TextEncoder().encode("CPP-V1-blind");
const DOMAIN_DEPOSIT_ID = new TextEncoder().encode("CPP-V1-deposit-id");

export type G1Point = ReturnType<typeof bls12_381.G1.Point.fromBytes>;
export type G2Point = ReturnType<typeof bls12_381.G2.Point.fromBytes>;

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Big-endian u32, matching the contract's and the mint's index encoding. */
export function u32be(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`token index must be a uint32, got ${value}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error("hex string has odd length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (const byte of bytes) acc = (acc << 8n) | BigInt(byte);
  return acc;
}

export function scalarToBytes(scalar: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let value = scalar;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

export function bytesToScalar(bytes: Uint8Array): bigint {
  return bytesToBigIntBE(bytes);
}

// ---------------------------------------------------------------------------
// Point serialisation
// ---------------------------------------------------------------------------

export function serializeG1(point: G1Point): Uint8Array {
  return point.toBytes(false);
}

export function deserializeG1(bytes: Uint8Array): G1Point {
  if (bytes.length !== G1_BYTES) {
    throw new Error(`G1 point must be ${G1_BYTES} bytes, got ${bytes.length}`);
  }
  return bls12_381.G1.Point.fromBytes(bytes);
}

export function serializeG2(point: G2Point): Uint8Array {
  return point.toBytes(false);
}

export function deserializeG2(bytes: Uint8Array): G2Point {
  if (bytes.length !== G2_BYTES) {
    throw new Error(`G2 point must be ${G2_BYTES} bytes, got ${bytes.length}`);
  }
  return bls12_381.G2.Point.fromBytes(bytes);
}

// ---------------------------------------------------------------------------
// Mint keys
// ---------------------------------------------------------------------------

export interface MintKeypair {
  /** BLS scalar in Z_r. */
  sk: bigint;
  /** `sk · G2`, serialised (192 bytes). */
  pk: Uint8Array;
}

/**
 * Derives a mint keypair from a 32-byte seed.
 *
 * Deterministic so that an operator can reproduce the same mint identity from
 * a backed-up seed. Reducing modulo `ORDER - 1` and adding one guarantees a
 * non-zero scalar; the resulting bias is ~2^-252 and irrelevant here.
 */
export function mintKeypairFromSeed(seed: Uint8Array): MintKeypair {
  const sk = (bytesToBigIntBE(sha256(seed)) % (Fr.ORDER - 1n)) + 1n;
  return { sk, pk: serializeG2(bls12_381.G2.Point.BASE.multiply(sk)) };
}

// ---------------------------------------------------------------------------
// Token derivation
// ---------------------------------------------------------------------------

export interface TokenSecrets {
  index: number;
  /** Ed25519 private key that authorises this token's redemption. */
  spendSecret: Uint8Array;
  /** Ed25519 public key. Doubles as the on-chain nullifier. */
  nullifier: Uint8Array;
  /** Public identifier for the deposit slot; unlinkable to `nullifier`. */
  depositId: Uint8Array;
  /** Multiplicative blinding factor in Z_r. Never leaves the client. */
  r: bigint;
}

/**
 * Derives every secret for one token from a master seed and an index.
 *
 * All three values come from one `base`, split by domain separator:
 *
 * ```text
 *   base       = sha256(seed || u32be(index))
 *   spend_sk   = sha256("CPP-V1-spend"      || base)
 *   deposit_id = sha256("CPP-V1-deposit-id" || base)
 *   r          = sha256("CPP-V1-blind"      || base)  reduced into Z_r*
 * ```
 *
 * `deposit_id` is public from the moment of deposit and `nullifier` is public
 * from the moment of redemption, but nothing links them without the seed —
 * that is what makes the two halves of a token's life unlinkable. A wallet
 * that loses its state recovers everything from the seed alone.
 */
export function deriveTokenSecrets(masterSeed: Uint8Array, index: number): TokenSecrets {
  if (masterSeed.length === 0) throw new Error("master seed must be non-empty");

  const base = sha256(concatBytes(masterSeed, u32be(index)));
  const spendSecret = sha256(concatBytes(DOMAIN_SPEND, base));
  const depositId = sha256(concatBytes(DOMAIN_DEPOSIT_ID, base));
  const r = (bytesToBigIntBE(sha256(concatBytes(DOMAIN_BLIND, base))) % (Fr.ORDER - 1n)) + 1n;

  return {
    index,
    spendSecret,
    nullifier: ed25519.getPublicKey(spendSecret),
    depositId,
    r,
  };
}

// ---------------------------------------------------------------------------
// Blinding
// ---------------------------------------------------------------------------

/** `Y = hash_to_g1(nullifier)` — what the chain will verify against. */
export function hashNullifierToG1(nullifier: Uint8Array): G1Point {
  return bls12_381.G1.hashToCurve(nullifier, { DST: HASH_TO_G1_DST }) as G1Point;
}

export interface BlindedPoints {
  /** `H(nullifier)`. Stays on the client until redemption. */
  Y: G1Point;
  /** `r · Y`. The only thing the mint ever sees. */
  B: G1Point;
}

export function blindToken(nullifier: Uint8Array, r: bigint): BlindedPoints {
  const Y = hashNullifierToG1(nullifier);
  return { Y, B: Y.multiply(Fr.create(r)) };
}

/**
 * `S = S' · r⁻¹`.
 *
 * The identity the scheme rests on: `S' = sk·(r·Y)`, so `S'·r⁻¹ = sk·Y`. The
 * mint produced a signature over `Y` without ever seeing `Y`.
 */
export function unblindSignature(sPrime: G1Point, r: bigint): G1Point {
  return sPrime.multiply(Fr.inv(Fr.create(r)));
}

/** `S' = sk · B` — the mint's whole job. */
export function blindSign(B: G1Point, skMint: bigint): G1Point {
  if (!B.isTorsionFree()) {
    throw new Error("refusing to sign: B is not in the G1 prime-order subgroup");
  }
  return B.multiply(Fr.create(skMint));
}

// ---------------------------------------------------------------------------
// Verification (mirrors the contract)
// ---------------------------------------------------------------------------

/**
 * Checks `e(S, G2) == e(H(nullifier), PK)`, the same statement the contract
 * verifies on chain.
 *
 * Clients call this before submitting a redemption: catching a bad signature
 * locally costs nothing, whereas discovering it on chain costs a fee.
 */
export function verifyBlindSignature(
  S: Uint8Array | G1Point,
  nullifier: Uint8Array,
  pkMint: Uint8Array | G2Point,
): boolean {
  try {
    const sig = S instanceof Uint8Array ? deserializeG1(S) : S;
    const pk = pkMint instanceof Uint8Array ? deserializeG2(pkMint) : pkMint;
    if (!sig.isTorsionFree()) return false;

    const lhs = bls12_381.pairing(sig, bls12_381.G2.Point.BASE);
    const rhs = bls12_381.pairing(hashNullifierToG1(nullifier), pk);
    return bls12_381.fields.Fp12.eql(lhs, rhs);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Redemption authorisation
// ---------------------------------------------------------------------------

/**
 * Signs the redemption message with the token's spend key.
 *
 * `message` must be exactly what the contract's `redemption_message` view
 * returns — see `buildRedemptionMessage` in `soroban.ts`, which constructs it
 * from the vault id and recipient rather than trusting a hand-rolled copy.
 */
export function signRedemption(spendSecret: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, spendSecret);
}

export function verifyRedemption(
  nullifier: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, message, nullifier);
  } catch {
    return false;
  }
}
