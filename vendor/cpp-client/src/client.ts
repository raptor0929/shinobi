#!/usr/bin/env node
/**
 * CPP wallet CLI.
 *
 *   cpp init                       create a wallet for the configured vault
 *   cpp deposit                    lock one denomination and request a signature
 *   cpp scan                       collect blind signatures and unblind them
 *   cpp status                     show tokens and vault configuration
 *   cpp redeem <G...> [--index n]  spend a token to any Stellar address
 *   cpp refund --index n           reclaim a deposit the mint never signed
 *   cpp recover [--depth n]        rebuild wallet state from the seed alone
 *
 * The privacy story lives in the split between `deposit` and `redeem`. They are
 * separate transactions, from separate accounts, carrying values that cannot be
 * connected without the wallet seed — so run them apart in time, and never fund
 * the redeeming account from the depositing one.
 */

import { randomBytes } from "node:crypto";

import { Keypair } from "@stellar/stellar-sdk";

import { loadConfig } from "./config.js";
import {
  blindToken,
  deserializeG1,
  fromHex,
  serializeG1,
  signRedemption,
  toHex,
  unblindSignature,
  verifyBlindSignature,
} from "./crypto.js";
import { VaultRpc, buildRedemptionMessage, type VaultConfig } from "./soroban.js";
import { Wallet, type TokenRecord } from "./wallet.js";

// ---------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      const [name, inline] = token.slice(2).split("=", 2);
      flags.set(name!, inline ?? rest[++i] ?? "true");
    } else {
      positional.push(token);
    }
  }

  return { command, positional, flags };
}

function requireFlag(args: Args, name: string): string {
  const value = args.flags.get(name);
  if (value === undefined) throw new Error(`missing required flag --${name}`);
  return value;
}

/** Reads a signing key from a flag or the environment. */
function signerFrom(args: Args, flag: string, envName: string): Keypair {
  const secret = args.flags.get(flag) ?? process.env[envName];
  if (!secret) {
    throw new Error(`no signing key: pass --${flag} S... or set ${envName}`);
  }
  return Keypair.fromSecret(secret);
}

function formatAmount(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / 10_000_000n;
  const frac = (abs % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInit(args: Args, rpc: VaultRpc): Promise<void> {
  const seed = args.flags.has("seed") ? fromHex(requireFlag(args, "seed")) : randomBytes(32);
  const wallet = await Wallet.create(Uint8Array.from(seed), rpc.vaultId);

  console.log(`wallet created at ${wallet.path}`);
  console.log(`vault          ${rpc.vaultId}`);
  console.log(`seed           ${toHex(wallet.seed)}`);
  console.log();
  console.log("Back up that seed. It is the only thing that can recover your tokens,");
  console.log("and no one — not the mint, not the vault — can restore it for you.");
}

async function cmdDeposit(args: Args, rpc: VaultRpc): Promise<void> {
  const wallet = await Wallet.load();
  const signer = signerFrom(args, "secret", "DEPOSITOR_SECRET");
  const config = await rpc.fetchConfig(signer.publicKey());

  const token = wallet.allocate();
  const { B } = blindToken(token.nullifier, token.r);

  console.log(`depositing ${formatAmount(config.denomination)} from ${signer.publicKey()}`);
  console.log(`  index      ${token.index}`);
  console.log(`  deposit id ${toHex(token.depositId)}`);

  const hash = await rpc.deposit(signer, token.depositId, serializeG1(B));

  wallet.upsert({
    index: token.index,
    state: "pending",
    depositId: toHex(token.depositId),
    nullifier: toHex(token.nullifier),
    depositTx: hash,
  });
  await wallet.save();

  console.log(`  tx         ${hash}`);
  console.log("\nRun `npm run client -- scan` once the mint has signed.");
}

async function cmdScan(args: Args, rpc: VaultRpc): Promise<void> {
  const wallet = await Wallet.load();
  const source = signerFrom(args, "secret", "DEPOSITOR_SECRET").publicKey();
  const config = await rpc.fetchConfig(source);

  // With no cursor yet, scan everything RPC still has rather than guessing a
  // window. A deposit whose `announce` fell outside the guess would look
  // eternally pending, and the wallet would give no hint why.
  const from = args.flags.has("from")
    ? Number(requireFlag(args, "from"))
    : (wallet.scanCursor ?? (await rpc.retentionFloor()));

  // Index announcements by deposit id, then match against our own derived ids.
  // The vault publishes every deposit's signature; only we can tell which are
  // ours, and only we hold the `r` that makes one usable.
  const page = await rpc.getEvents(Math.max(from, 1), ["announce"], 1000);
  const announced = new Map<string, Uint8Array>();
  for (const event of page.events) {
    announced.set(toHex(event.key), asBytes(event.data));
  }

  let collected = 0;
  for (const record of wallet.tokens) {
    if (record.state !== "pending") continue;

    const sPrimeBytes = announced.get(record.depositId);
    if (!sPrimeBytes) continue;

    const token = wallet.secretsFor(record.index);
    const s = unblindSignature(deserializeG1(sPrimeBytes), token.r);
    const sBytes = serializeG1(s);

    // Verify locally before recording it as spendable. A signature that fails
    // here would fail on chain too, and finding out now costs no fee.
    if (!verifyBlindSignature(sBytes, token.nullifier, config.mintPk)) {
      console.warn(`  index ${record.index}: signature did not verify — not marking ready`);
      continue;
    }

    wallet.upsert({ ...record, state: "ready", s: toHex(sBytes) });
    collected++;
    console.log(`  index ${record.index}: ready`);
  }

  wallet.setScanCursor(page.nextLedger);
  await wallet.save();

  console.log(
    collected
      ? `\ncollected ${collected} signature${collected === 1 ? "" : "s"}`
      : "\nnothing new — the mint may not have signed yet",
  );
}

async function cmdStatus(args: Args, rpc: VaultRpc): Promise<void> {
  const wallet = await Wallet.load();
  const source = signerFrom(args, "secret", "DEPOSITOR_SECRET").publicKey();
  const config = await rpc.fetchConfig(source);

  printConfig(rpc, config);
  console.log(`\nwallet ${wallet.path} (${wallet.tokens.length} tokens)\n`);

  if (wallet.tokens.length === 0) {
    console.log("  no tokens yet — run `deposit`");
    return;
  }

  console.log("  idx  state      deposit id        nullifier");
  console.log("  ---  ---------  ----------------  ----------------");
  for (const t of wallet.tokens) {
    console.log(
      `  ${String(t.index).padStart(3)}  ${t.state.padEnd(9)}  ` +
        `${t.depositId.slice(0, 16)}  ${t.nullifier.slice(0, 16)}`,
    );
  }

  const ready = wallet.tokens.filter((t) => t.state === "ready").length;
  console.log(
    `\n  spendable: ${ready} × ${formatAmount(config.denomination)} = ` +
      `${formatAmount(BigInt(ready) * config.denomination)}`,
  );
}

async function cmdRedeem(args: Args, rpc: VaultRpc): Promise<void> {
  const wallet = await Wallet.load();
  const recipient = args.positional[0];
  if (!recipient) throw new Error("usage: redeem <recipient-address> [--index n]");

  const record = pickSpendable(wallet, args.flags.get("index"));
  const token = wallet.secretsFor(record.index);

  // Whoever submits this transaction pays the fee and proves nothing about who
  // owns the token — `redeem` takes no `require_auth`. Using an unrelated
  // account here is what keeps the payout from pointing back at the depositor.
  const submitter = signerFrom(args, "submitter", "SUBMITTER_SECRET");

  const message = buildRedemptionMessage(rpc.vaultId, recipient);
  const spendSig = signRedemption(token.spendSecret, message);
  const s = fromHex(record.s!);

  console.log(`redeeming index ${record.index}`);
  console.log(`  nullifier  ${record.nullifier}`);
  console.log(`  recipient  ${recipient}`);
  console.log(`  submitter  ${submitter.publicKey()}`);

  if (await rpc.isSpent(token.nullifier, submitter.publicKey())) {
    throw new Error("this nullifier has already been spent on chain");
  }

  const hash = await rpc.redeem(submitter, recipient, token.nullifier, spendSig, s);

  wallet.upsert({ ...record, state: "spent", redeemTx: hash, paidTo: recipient });
  await wallet.save();

  console.log(`  tx         ${hash}`);
}

async function cmdRefund(args: Args, rpc: VaultRpc): Promise<void> {
  const wallet = await Wallet.load();
  const index = Number(requireFlag(args, "index"));
  const record = wallet.find(index);
  if (!record) throw new Error(`no token at index ${index}`);
  if (record.state !== "pending") {
    throw new Error(`index ${index} is ${record.state}; only pending deposits can be refunded`);
  }

  // Must be the original depositor — the vault checks.
  const signer = signerFrom(args, "secret", "DEPOSITOR_SECRET");
  const hash = await rpc.refund(signer, fromHex(record.depositId));

  wallet.upsert({ ...record, state: "refunded" });
  await wallet.save();

  console.log(`refunded index ${index}, tx ${hash}`);
}

/**
 * Rebuilds token state from the seed and the chain.
 *
 * Walks derivation indices from zero, asks the vault for each derived deposit
 * id's status, and pulls the matching `announce` signature. This is the payoff
 * of deriving everything from one seed: the wallet file is disposable.
 *
 * Bounded by `--depth` because indices are unbounded and each one costs an RPC
 * call; the default covers far more tokens than a demo will ever mint.
 */
async function cmdRecover(args: Args, rpc: VaultRpc): Promise<void> {
  const wallet = await Wallet.load();
  const source = signerFrom(args, "secret", "DEPOSITOR_SECRET").publicKey();
  const config = await rpc.fetchConfig(source);
  const depth = Number(args.flags.get("depth") ?? 32);

  // Pull the announce log once, from as far back as RPC still serves. Fetching
  // it per index would re-download the whole pool's announcements `depth`
  // times over to answer the same question each pass.
  const announcePage = await rpc.getEvents(await rpc.retentionFloor(), ["announce"], 1000);
  const announced = new Map<string, Uint8Array>();
  for (const event of announcePage.events) {
    announced.set(toHex(event.key), asBytes(event.data));
  }

  console.log(`scanning derivation indices 0..${depth - 1}`);
  let found = 0;

  for (let index = 0; index < depth; index++) {
    const token = wallet.secretsFor(index);
    const status = await rpc.depositStatus(token.depositId, source);
    if (status === "None") continue;

    found++;
    const spent = await rpc.isSpent(token.nullifier, source);
    const base: TokenRecord = {
      index,
      state: "pending",
      depositId: toHex(token.depositId),
      nullifier: toHex(token.nullifier),
    };

    if (spent) {
      wallet.upsert({ ...base, state: "spent" });
      console.log(`  index ${index}: spent`);
      continue;
    }
    if (status === "Refunded") {
      wallet.upsert({ ...base, state: "refunded" });
      console.log(`  index ${index}: refunded`);
      continue;
    }
    if (status === "Pending") {
      wallet.upsert(base);
      console.log(`  index ${index}: pending (mint has not signed)`);
      continue;
    }

    // Announced and unspent: recover `S'` from the event log and unblind it.
    const sPrime = announced.get(base.depositId);
    if (!sPrime) {
      wallet.upsert(base);
      console.log(`  index ${index}: announced, but the event is outside RPC's retention window`);
      continue;
    }

    const s = serializeG1(unblindSignature(deserializeG1(sPrime), token.r));
    if (!verifyBlindSignature(s, token.nullifier, config.mintPk)) {
      wallet.upsert(base);
      console.log(`  index ${index}: announced, but the signature does not verify`);
      continue;
    }

    wallet.upsert({ ...base, state: "ready", s: toHex(s) });
    console.log(`  index ${index}: ready`);
  }

  await wallet.save();
  console.log(`\nrecovered ${found} token${found === 1 ? "" : "s"}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickSpendable(wallet: Wallet, indexFlag?: string): TokenRecord {
  if (indexFlag !== undefined) {
    const record = wallet.find(Number(indexFlag));
    if (!record) throw new Error(`no token at index ${indexFlag}`);
    if (record.state !== "ready" || !record.s) {
      throw new Error(`index ${indexFlag} is ${record.state}, not ready to spend`);
    }
    return record;
  }

  const ready = wallet.tokens.find((t) => t.state === "ready" && t.s);
  if (!ready) throw new Error("no spendable tokens — run `deposit` then `scan`");
  return ready;
}

function printConfig(rpc: VaultRpc, config: VaultConfig): void {
  console.log(`vault          ${rpc.vaultId}`);
  console.log(`token          ${config.token}`);
  console.log(`denomination   ${formatAmount(config.denomination)}`);
  console.log(`mint authority ${config.mintAuthority}`);
  console.log(`mint key       ${toHex(config.mintPk).slice(0, 32)}…`);
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return Uint8Array.from(value);
  throw new Error(`expected bytes in the event payload, got ${typeof value}`);
}

const USAGE = `cpp — compliant privacy pool wallet

  init      [--seed hex]              create a wallet for VAULT_CONTRACT_ID
  deposit   [--secret S...]           lock one denomination, request a signature
  scan      [--from ledger]           collect and unblind mint signatures
  status                              show vault config and local tokens
  redeem    <G...> [--index n]        spend a token to any address
            [--submitter S...]          (fee payer; need not be the recipient)
  refund    --index n                 reclaim a deposit the mint never signed
  recover   [--depth n]               rebuild wallet state from the seed

Environment: VAULT_CONTRACT_ID, STELLAR_NETWORK, STELLAR_RPC_URL,
             DEPOSITOR_SECRET, SUBMITTER_SECRET`;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === "help" || args.flags.has("help")) {
    console.log(USAGE);
    return;
  }

  const rpc = new VaultRpc(loadConfig());

  switch (args.command) {
    case "init":
      return cmdInit(args, rpc);
    case "deposit":
      return cmdDeposit(args, rpc);
    case "scan":
      return cmdScan(args, rpc);
    case "status":
      return cmdStatus(args, rpc);
    case "redeem":
      return cmdRedeem(args, rpc);
    case "refund":
      return cmdRefund(args, rpc);
    case "recover":
      return cmdRecover(args, rpc);
    default:
      console.error(`unknown command "${args.command}"\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
