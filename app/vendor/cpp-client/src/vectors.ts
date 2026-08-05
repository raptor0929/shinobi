#!/usr/bin/env node
/**
 * Generates cross-language test vectors.
 *
 * Everything here is produced by the TypeScript client and then consumed by
 * `contracts/vault/src/vectors.rs`, which runs it through the real Soroban host
 * — the same `hash_to_g1`, the same `pairing_check`, the same `ed25519_verify`
 * a testnet ledger would run. If the two implementations ever disagree about a
 * domain separator, a scalar reduction, or a byte order, that Rust test fails.
 *
 * The vault address is pinned so the redemption message (which commits to it)
 * is reproducible; the Rust side registers the contract at exactly that id.
 *
 *   npm run vectors            print to stdout
 *   npm run vectors -- --out vectors.json
 */

import { writeFileSync } from "node:fs";

import {
  HASH_TO_G1_DST,
  blindSign,
  blindToken,
  deriveTokenSecrets,
  fromHex,
  mintKeypairFromSeed,
  scalarToBytes,
  serializeG1,
  signRedemption,
  toHex,
  unblindSignature,
  verifyBlindSignature,
  verifyRedemption,
} from "./crypto.js";
import { buildRedemptionMessage } from "./soroban.js";

/** Fixed inputs. Changing any of these invalidates the Rust-side constants. */
const MINT_SEED = fromHex("00".repeat(31) + "2a");
const WALLET_SEED = fromHex("11".repeat(32));
const VAULT_ID = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";

/**
 * Two recipients, because Soroban encodes the two address kinds differently
 * and the redemption message commits to that encoding. Getting one right and
 * the other wrong would produce a client that can pay contracts but not people.
 */
const ACCOUNT_RECIPIENT = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
const CONTRACT_RECIPIENT = "CBRXA4DSMVRWS4DJMVXHIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABUQE";
const INDICES = [0, 1, 7];

export interface TokenVector {
  index: number;
  nullifier: string;
  depositId: string;
  r: string;
  y: string;
  blindedB: string;
  sPrime: string;
  s: string;
  /** Spend signature authorising payment to `accountRecipient`. */
  spendSigAccount: string;
  /** Spend signature authorising payment to `contractRecipient`. */
  spendSigContract: string;
}

export interface Vectors {
  dst: string;
  vaultId: string;
  accountRecipient: string;
  contractRecipient: string;
  /** `redemption_message(accountRecipient)` — same for every token. */
  messageAccount: string;
  /** `redemption_message(contractRecipient)`. */
  messageContract: string;
  mintSeed: string;
  mintSk: string;
  mintPk: string;
  walletSeed: string;
  tokens: TokenVector[];
}

export function generate(): Vectors {
  const mint = mintKeypairFromSeed(MINT_SEED);
  const messageAccount = buildRedemptionMessage(VAULT_ID, ACCOUNT_RECIPIENT);
  const messageContract = buildRedemptionMessage(VAULT_ID, CONTRACT_RECIPIENT);
  const tokens: TokenVector[] = [];

  for (const index of INDICES) {
    const token = deriveTokenSecrets(WALLET_SEED, index);
    const { Y, B } = blindToken(token.nullifier, token.r);
    const sPrime = blindSign(B, mint.sk);
    const s = unblindSignature(sPrime, token.r);

    const spendSigAccount = signRedemption(token.spendSecret, messageAccount);
    const spendSigContract = signRedemption(token.spendSecret, messageContract);

    // Self-check before publishing a vector: a wrong vector that the Rust side
    // then hardcodes would be worse than no vector at all.
    if (!verifyBlindSignature(serializeG1(s), token.nullifier, mint.pk)) {
      throw new Error(`index ${index}: unblinded signature failed local verification`);
    }
    for (const [label, message, sig] of [
      ["account", messageAccount, spendSigAccount],
      ["contract", messageContract, spendSigContract],
    ] as const) {
      if (!verifyRedemption(token.nullifier, message, sig)) {
        throw new Error(`index ${index}: ${label} spend signature failed local verification`);
      }
    }

    tokens.push({
      index,
      nullifier: toHex(token.nullifier),
      depositId: toHex(token.depositId),
      r: toHex(scalarToBytes(token.r)),
      y: toHex(serializeG1(Y)),
      blindedB: toHex(serializeG1(B)),
      sPrime: toHex(serializeG1(sPrime)),
      s: toHex(serializeG1(s)),
      spendSigAccount: toHex(spendSigAccount),
      spendSigContract: toHex(spendSigContract),
    });
  }

  return {
    dst: HASH_TO_G1_DST,
    vaultId: VAULT_ID,
    accountRecipient: ACCOUNT_RECIPIENT,
    contractRecipient: CONTRACT_RECIPIENT,
    messageAccount: toHex(messageAccount),
    messageContract: toHex(messageContract),
    mintSeed: toHex(MINT_SEED),
    mintSk: toHex(scalarToBytes(mint.sk)),
    mintPk: toHex(mint.pk),
    walletSeed: toHex(WALLET_SEED),
    tokens,
  };
}

/** Emits the vectors as a Rust module, so the contract test has no I/O. */
export function toRust(v: Vectors): string {
  const lines: string[] = [
    "//! Cross-language test vectors — GENERATED, do not edit by hand.",
    "//!",
    "//! Produced by `ts/src/vectors.ts` (`npm run vectors -- --rust`). Every",
    "//! value below was computed by the TypeScript client using @noble/curves;",
    "//! `test_vectors.rs` replays them through the Soroban host to prove the two",
    "//! implementations agree byte-for-byte.",
    "",
    `pub const VAULT_ID: &str = "${v.vaultId}";`,
    `pub const ACCOUNT_RECIPIENT: &str = "${v.accountRecipient}";`,
    `pub const CONTRACT_RECIPIENT: &str = "${v.contractRecipient}";`,
    `pub const MESSAGE_ACCOUNT: &[u8] = &${rustBytes(v.messageAccount)};`,
    `pub const MESSAGE_CONTRACT: &[u8] = &${rustBytes(v.messageContract)};`,
    `pub const MINT_PK: [u8; 192] = ${rustBytes(v.mintPk)};`,
    "",
    "pub struct TokenVector {",
    "    pub index: u32,",
    "    pub nullifier: [u8; 32],",
    "    pub deposit_id: [u8; 32],",
    "    pub y: [u8; 96],",
    "    pub blinded_b: [u8; 96],",
    "    pub s_prime: [u8; 96],",
    "    pub s: [u8; 96],",
    "    pub spend_sig_account: [u8; 64],",
    "    pub spend_sig_contract: [u8; 64],",
    "}",
    "",
    `pub const TOKENS: [TokenVector; ${v.tokens.length}] = [`,
  ];

  for (const t of v.tokens) {
    lines.push(
      "    TokenVector {",
      `        index: ${t.index},`,
      `        nullifier: ${rustBytes(t.nullifier)},`,
      `        deposit_id: ${rustBytes(t.depositId)},`,
      `        y: ${rustBytes(t.y)},`,
      `        blinded_b: ${rustBytes(t.blindedB)},`,
      `        s_prime: ${rustBytes(t.sPrime)},`,
      `        s: ${rustBytes(t.s)},`,
      `        spend_sig_account: ${rustBytes(t.spendSigAccount)},`,
      `        spend_sig_contract: ${rustBytes(t.spendSigContract)},`,
      "    },",
    );
  }

  lines.push("];", "");
  return lines.join("\n");
}

function rustBytes(hex: string): string {
  const bytes = fromHex(hex);
  const items: string[] = [];
  for (let i = 0; i < bytes.length; i += 12) {
    items.push(
      `        ${[...bytes.slice(i, i + 12)].map((b) => `0x${b.toString(16).padStart(2, "0")}`).join(", ")},`,
    );
  }
  return `[\n${items.join("\n")}\n    ]`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const vectors = generate();
  const output = argv.includes("--rust") ? toRust(vectors) : `${JSON.stringify(vectors, null, 2)}\n`;

  const outIndex = argv.indexOf("--out");
  if (outIndex >= 0 && argv[outIndex + 1]) {
    writeFileSync(argv[outIndex + 1]!, output);
    console.error(`wrote ${argv[outIndex + 1]}`);
  } else {
    process.stdout.write(output);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
