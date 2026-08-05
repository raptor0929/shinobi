#!/usr/bin/env node
/**
 * Sponsored account creation.
 *
 * A redemption pays a Stellar address, and that address has to exist before it
 * can be paid. Somebody must therefore create it — and whoever does is written
 * into the ledger permanently, both as the `create_account` source and, for a
 * sponsored account, as the `sponsoringID` on the account entry itself.
 *
 * That makes account creation a privacy decision, not a plumbing detail:
 *
 *  - If the **depositor** creates the recipient account, the chain records a
 *    direct edge from the depositor to the address their own token is about to
 *    be paid to. That is precisely the link blinding exists to remove, handed
 *    back for free.
 *  - If **one shared sponsor** creates every recipient account, the sponsor is
 *    a constant. A constant that appears on every account distinguishes none of
 *    them from each other, so it carries no information about which deposit any
 *    particular recipient corresponds to.
 *
 * So the rule this module enforces is: exactly one sponsor, never the
 * depositor. `assertSponsorIsNotDepositor` refuses the obvious mistake rather
 * than trusting an operator to notice it.
 *
 * On testnet `friendbot` happens to satisfy the "one shared constant" property
 * by accident, which is why the demo looked clean before this existed. It has
 * no mainnet equivalent, so relying on it would have meant the demo's privacy
 * story did not survive contact with production.
 *
 * ## What a shared sponsor does and does not buy
 *
 * It removes the depositor→recipient edge. It does **not** create anonymity by
 * itself: an observer still sees one account created and one redemption paid to
 * it. What protects the pairing is that the sponsor's other creations are
 * indistinguishable from this one, so the anonymity set is every account the
 * sponsor has ever made. A sponsor used by a single depositor is a constant in
 * form only — see the note in README about pool size.
 *
 * ## Limitation
 *
 * This creates the account and nothing else. A vault denominated in a
 * *non-native* asset would additionally need a trustline on the recipient
 * before it could be paid, which needs its own sponsored reserve. That case is
 * not handled here; the demo vault is denominated in native XLM, which needs no
 * trustline.
 */

import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  Account,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
  type Transaction,
} from "@stellar/stellar-sdk";

import { loadConfig, resolveFromRoot, type Config } from "./config.js";

/**
 * Per-operation fee in stroops for the classic transaction below.
 *
 * Deliberately not the contract path's `BASE_FEE`: that is sized for Soroban
 * invocations, and paying it three times over for three classic operations
 * would burn 0.3 XLM to create an account. 0.001 XLM per op is a wide margin
 * over the 100-stroop minimum.
 */
const CLASSIC_FEE_PER_OP = "10000";
const TX_TIMEOUT_SECONDS = 60;

/** Where created keypairs are recorded, so the sponsor can reclaim reserves. */
export const DEFAULT_LEDGER_FILE = resolveFromRoot(
  process.env.CPP_SPONSORED_ACCOUNTS ?? ".cpp/sponsored-accounts.jsonl",
);

export interface SponsoredAccount {
  publicKey: string;
  secret: string;
  txHash: string;
}

/**
 * Builds the sponsored-creation transaction.
 *
 * The three operations have to arrive together, in this order, in one
 * transaction — that is what the sponsorship protocol requires, and splitting
 * them would leave a half-sponsored account behind on a partial failure:
 *
 *   1. `beginSponsoringFutureReserves` — sourced by the sponsor, naming the
 *      account about to be created.
 *   2. `createAccount` with `startingBalance: "0"` — sourced by the sponsor.
 *      Zero is not a placeholder: the base reserve is being put up by the
 *      sponsor, so the new account needs no balance of its own, and giving it
 *      one would be a transfer from the sponsor worth correlating.
 *   3. `endSponsoringFutureReserves` — **sourced by the new account**, which is
 *      why its keypair must sign even though it is brand new and empty.
 *
 * Split out from submission so the operation layout can be asserted in tests
 * without a network.
 */
export function buildSponsoredCreationTx(
  sponsorAccount: Account,
  networkPassphrase: string,
  newPublicKey: string,
  feePerOp: string = CLASSIC_FEE_PER_OP,
): Transaction {
  return new TransactionBuilder(sponsorAccount, { fee: feePerOp, networkPassphrase })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: newPublicKey }))
    .addOperation(Operation.createAccount({ destination: newPublicKey, startingBalance: "0" }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: newPublicKey }))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
}

/**
 * Refuses a sponsor that is also the depositor.
 *
 * The whole point of routing creation through a shared sponsor is to keep the
 * depositor off the recipient's ledger entry. An operator who sets both
 * variables to the same key would get a demo that runs perfectly and leaks the
 * link on every redemption, with nothing on screen to say so.
 */
export function assertSponsorIsNotDepositor(
  sponsorPublicKey: string,
  depositorSecret = process.env.DEPOSITOR_SECRET,
): void {
  if (!depositorSecret) return;
  let depositorPublicKey: string;
  try {
    depositorPublicKey = Keypair.fromSecret(depositorSecret).publicKey();
  } catch {
    return; // Malformed DEPOSITOR_SECRET is the client's problem to report.
  }
  if (depositorPublicKey === sponsorPublicKey) {
    throw new Error(
      "SPONSOR_SECRET and DEPOSITOR_SECRET are the same account.\n" +
        "  A depositor who creates their own recipient account writes a\n" +
        "  depositor -> recipient edge into the ledger, which is exactly the\n" +
        "  link the blind signature removes. Use a separate shared sponsor.",
    );
  }
}

/**
 * Creates a new account whose reserve is put up by `sponsor`.
 *
 * The returned secret belongs to a live account holding a sponsored reserve;
 * losing it strands that reserve, which is why `main` records it before
 * printing anything.
 */
export async function createSponsoredAccount(
  server: rpc.Server,
  networkPassphrase: string,
  sponsor: Keypair,
  account: Keypair = Keypair.random(),
): Promise<SponsoredAccount> {
  assertSponsorIsNotDepositor(sponsor.publicKey());

  const source = await server.getAccount(sponsor.publicKey());
  const tx = buildSponsoredCreationTx(source, networkPassphrase, account.publicKey());

  // Both signatures are required: the sponsor authorises operations 1 and 2,
  // the new account authorises operation 3.
  tx.sign(sponsor, account);

  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") {
    throw new Error(`sponsored creation rejected: ${JSON.stringify(sent.errorResult)}`);
  }

  const final = await server.pollTransaction(sent.hash, {
    attempts: 30,
    sleepStrategy: rpc.LinearSleepStrategy,
  });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`sponsored creation failed on chain (${final.status}), tx ${sent.hash}`);
  }

  return { publicKey: account.publicKey(), secret: account.secret(), txHash: sent.hash };
}

/** Appends a created keypair to the local record, 0600. */
export async function recordSponsoredAccount(
  created: SponsoredAccount,
  sponsorPublicKey: string,
  path = DEFAULT_LEDGER_FILE,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const line = JSON.stringify({
    at: new Date().toISOString(),
    publicKey: created.publicKey,
    secret: created.secret,
    sponsor: sponsorPublicKey,
    txHash: created.txHash,
  });
  await appendFile(path, `${line}\n`);
  await chmod(path, 0o600);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const USAGE = `cpp sponsor — create a recipient account under one shared sponsor

  npm run sponsor                 create an account, print its address
  npm run sponsor -- --quiet      print only the address (for scripts)

Environment: SPONSOR_SECRET (required), STELLAR_NETWORK, STELLAR_RPC_URL

The secret of every account created is appended to
.cpp/sponsored-accounts.jsonl (0600) so the sponsor can reclaim the reserve
later. The sponsor must be one shared account, and must not be the depositor.`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const quiet = argv.includes("--quiet");

  const config: Config = loadConfig();
  const secret = process.env.SPONSOR_SECRET;
  if (!secret) {
    throw new Error("SPONSOR_SECRET is not set — copy example.env to .env and fill it in");
  }
  const sponsor = Keypair.fromSecret(secret);

  const server = new rpc.Server(config.rpcUrl, {
    allowHttp: config.rpcUrl.startsWith("http://"),
  });

  const created = await createSponsoredAccount(server, config.networkPassphrase, sponsor);
  // Record before printing: a crash between the two would otherwise strand the
  // sponsor's reserve behind a key nobody kept.
  await recordSponsoredAccount(created, sponsor.publicKey());

  if (quiet) {
    console.log(created.publicKey);
  } else {
    console.log(`created  ${created.publicKey}`);
    console.log(`sponsor  ${sponsor.publicKey()}`);
    console.log(`tx       ${created.txHash}`);
    console.log(`secret   recorded in ${DEFAULT_LEDGER_FILE}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
