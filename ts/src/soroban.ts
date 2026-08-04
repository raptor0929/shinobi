/**
 * Soroban RPC plumbing: argument encoding, invocation, and event queries.
 *
 * Everything above this layer (`client.ts`, `mint.ts`) deals in bytes and
 * bigints; this module is the only place that knows about ScVal, transaction
 * assembly, or RPC pagination.
 */

import {
  Address,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import type { Config } from "./config.js";
import { REDEEM_DOMAIN, concatBytes } from "./crypto.js";

/** Base fee in stroops. Simulation adds the resource fee on top. */
const BASE_FEE = "1000000";
const TX_TIMEOUT_SECONDS = 60;

// ---------------------------------------------------------------------------
// ScVal encoding
// ---------------------------------------------------------------------------

export function bytesArg(value: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(value));
}

export function addressArg(value: string): xdr.ScVal {
  return Address.fromString(value).toScVal();
}

export function i128Arg(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

// ---------------------------------------------------------------------------
// Redemption message
// ---------------------------------------------------------------------------

/**
 * Rebuilds the exact byte string the contract's `redemption_message` view
 * returns: `REDEEM_DOMAIN || xdr(vault_address) || xdr(recipient)`.
 *
 * Built locally rather than fetched, so signing a redemption needs no RPC
 * round-trip. `Address.toScVal().toXDR()` is byte-identical to Soroban's
 * `Address::to_xdr` — `test/parity.test.ts` pins that against vectors taken
 * from the Rust side, and `checkRedemptionMessage` below can confirm it
 * against a live contract.
 */
export function buildRedemptionMessage(vaultId: string, recipient: string): Uint8Array {
  return concatBytes(
    REDEEM_DOMAIN,
    new Uint8Array(Address.fromString(vaultId).toScVal().toXDR()),
    new Uint8Array(Address.fromString(recipient).toScVal().toXDR()),
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** A decoded contract event, with topics already split the way we emit them. */
export interface VaultEvent {
  /** `deposit` | `announce` | `redeem` | `refund` */
  name: string;
  /** Second topic: `deposit_id` for deposit/announce/refund, `nullifier` for redeem. */
  key: Uint8Array;
  /** The `single-value` data payload, converted to a native JS value. */
  data: unknown;
  ledger: number;
  txHash: string;
}

export interface EventPage {
  events: VaultEvent[];
  /**
   * Ledger to resume from on the next poll.
   *
   * This is one past the highest ledger actually scanned — never merely one
   * past whatever the server called "latest". Advancing a durable cursor to an
   * unscanned ledger loses events permanently, so the two must not be confused.
   */
  nextLedger: number;
}

/**
 * Cap on cursor-follows within one `getEvents` call.
 *
 * A caller starting from genesis would otherwise loop for a very long time. The
 * bound is generous enough to cross the full RPC retention window in one call
 * and, because `nextLedger` reflects only what was scanned, stopping early
 * costs a caller nothing but another round of polling.
 */
const MAX_EVENT_PAGES = 100;

/**
 * Extracts the ledger sequence from an RPC event cursor.
 *
 * The cursor's first component is a TOID — `(ledger << 32) | (tx_order << 20) |
 * op_index` — so the high 32 bits are the ledger. Reading it is what lets us
 * tell "scanned this far and found nothing" apart from "found nothing at all",
 * which is precisely the distinction a paginating scan turns on.
 */
export function ledgerFromCursor(cursor: string): number | undefined {
  const [toid] = cursor.split("-");
  if (!toid || !/^\d+$/.test(toid)) return undefined;
  const ledger = Number(BigInt(toid) >> 32n);
  return Number.isSafeInteger(ledger) && ledger > 0 ? ledger : undefined;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class VaultRpc {
  readonly server: rpc.Server;
  readonly config: Config;
  private readonly contract: Contract;

  constructor(config: Config) {
    this.config = config;
    this.server = new rpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
    this.contract = new Contract(config.vaultId);
  }

  get vaultId(): string {
    return this.config.vaultId;
  }

  /**
   * Simulates a call without submitting it. Used for views (`config`,
   * `is_spent`, `deposit_status`) and to pre-flight a redemption so a client
   * learns about a failure before paying for it.
   *
   * Simulation needs a source account, but never signs or charges it — any
   * funded account works.
   */
  async view(method: string, args: xdr.ScVal[], sourcePublicKey: string): Promise<unknown> {
    const account = await this.server.getAccount(sourcePublicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`simulation of ${method} failed: ${sim.error}`);
    }
    return sim.result?.retval ? scValToNative(sim.result.retval) : undefined;
  }

  /**
   * Invokes a contract method and waits for it to land.
   *
   * Signing happens after assembly so the signature covers the simulated
   * footprint and resource fee, which is what the network actually charges.
   */
  async invoke(
    signer: Keypair,
    method: string,
    args: xdr.ScVal[],
  ): Promise<{ hash: string; returnValue: unknown }> {
    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`${method} would fail: ${sim.error}`);
    }

    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(signer);

    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === "ERROR") {
      throw new Error(`${method} rejected by RPC: ${JSON.stringify(sent.errorResult)}`);
    }

    const final = await this.server.pollTransaction(sent.hash, {
      attempts: 30,
      sleepStrategy: rpc.LinearSleepStrategy,
    });
    if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`${method} failed on chain (${final.status}), tx ${sent.hash}`);
    }

    return {
      hash: sent.hash,
      returnValue: final.returnValue ? scValToNative(final.returnValue) : undefined,
    };
  }

  /**
   * The oldest ledger this RPC server still serves events for.
   *
   * Retention is a few days; anything earlier is gone as far as this endpoint
   * is concerned, and a wallet that needs it must go to an archive source.
   */
  async retentionFloor(): Promise<number> {
    const health = await this.server.getHealth();
    return health.oldestLedger ?? 0;
  }

  /**
   * Fetches vault events from `startLedger` up to the current ledger.
   *
   * `names` filters server-side on the first topic, so a wallet scanning for
   * its own `announce` events does not download every deposit in the pool.
   *
   * **Pagination is not optional.** A single `getEvents` call scans only a
   * bounded window of ledgers and then returns a cursor, whether or not it
   * found anything. Treating one response as the whole answer silently misses
   * events beyond the window — and, worse, invites a caller to advance its
   * cursor past ledgers that were never scanned. This method follows the cursor
   * until it has caught up to the ledger the server reported as latest, so
   * `nextLedger` is only ever a ledger that has genuinely been examined.
   */
  async getEvents(startLedger: number, names?: string[], limit = 200): Promise<EventPage> {
    const topicFilter: string[] = names?.length
      ? [names.map((n) => xdr.ScVal.scvSymbol(n).toXDR("base64")).join("|"), "*"]
      : ["*", "*"];
    const filters = [
      { type: "contract" as const, contractIds: [this.config.vaultId], topics: [topicFilter] },
    ];

    // RPC rejects a startLedger below its retention floor outright, so a caller
    // asking for more history than the server keeps gets everything it kept
    // rather than an error. The floor moves as ledgers close; re-reading it per
    // call is one cheap request against the alternative of a stale clamp.
    const floor = await this.retentionFloor();
    const from = Math.max(startLedger, floor);

    const events: VaultEvent[] = [];
    let cursor: string | undefined;
    let scannedThrough = from - 1;
    let latestLedger = from;

    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      const response = await this.server.getEvents(
        cursor ? { filters, limit, cursor } : { startLedger: from, filters, limit },
      );
      latestLedger = response.latestLedger;

      for (const raw of response.events) {
        if (raw.topic.length < 2) continue;
        events.push({
          name: String(scValToNative(raw.topic[0]!)),
          key: Uint8Array.from(scValToNative(raw.topic[1]!) as Buffer),
          data: scValToNative(raw.value),
          ledger: raw.ledger,
          txHash: raw.txHash,
        });
      }

      cursor = response.cursor;
      const cursorLedger = cursor ? ledgerFromCursor(cursor) : undefined;
      const truncated = response.events.length >= limit;

      if (cursorLedger !== undefined) {
        // A cursor from a full page points at an *event*, not at the end of the
        // scanned window: there may be more events left in that same ledger.
        // `nextLedger` has only ledger granularity, so the last ledger of a
        // truncated page cannot be claimed as done — resuming past it would
        // drop its remaining events. Re-scanning it is harmless by comparison,
        // since both consumers match on ids and tolerate a replay.
        scannedThrough = Math.max(scannedThrough, cursorLedger - (truncated ? 1 : 0));
      }

      // Caught up, or the server stopped giving us a way to continue.
      if (!cursor || (!truncated && scannedThrough >= latestLedger)) {
        scannedThrough = Math.max(scannedThrough, latestLedger);
        break;
      }
      if (events.length >= limit) break;
    }

    return { events, nextLedger: scannedThrough + 1 };
  }

  // -- Typed wrappers over the vault's ABI ----------------------------------

  async fetchConfig(sourcePublicKey: string): Promise<VaultConfig> {
    const raw = (await this.view("config", [], sourcePublicKey)) as {
      mint_authority: string;
      mint_pk: Buffer;
      token: string;
      denomination: bigint;
    };
    return {
      mintAuthority: raw.mint_authority,
      mintPk: Uint8Array.from(raw.mint_pk),
      token: raw.token,
      denomination: raw.denomination,
    };
  }

  async isSpent(nullifier: Uint8Array, sourcePublicKey: string): Promise<boolean> {
    return (await this.view("is_spent", [bytesArg(nullifier)], sourcePublicKey)) as boolean;
  }

  async depositStatus(depositId: Uint8Array, sourcePublicKey: string): Promise<DepositStatus> {
    const raw = await this.view("deposit_status", [bytesArg(depositId)], sourcePublicKey);
    return normalizeStatus(raw);
  }

  /**
   * Reads the `Depositor(deposit_id)` persistent entry directly.
   *
   * This is how the mint learns who to screen: the `deposit` event carries only
   * `deposit_id` and `B`, deliberately, so the funder's address is not baked
   * into the permanent event log. The entry exists only while the deposit is
   * `Pending` — `announce` removes it — so a `null` here means the deposit was
   * already fulfilled, already refunded, or never existed.
   */
  async getDepositor(depositId: Uint8Array): Promise<string | null> {
    const key = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Depositor"),
      xdr.ScVal.scvBytes(Buffer.from(depositId)),
    ]);

    try {
      const entry = await this.server.getContractData(
        this.config.vaultId,
        key,
        rpc.Durability.Persistent,
      );
      const value = entry.val.contractData().val();
      return String(scValToNative(value));
    } catch {
      return null;
    }
  }

  /**
   * Asks the contract what it expects to be signed and compares it with what
   * `buildRedemptionMessage` produces. Cheap insurance against an XDR encoding
   * drift between the SDK and the host; the demo script runs it once.
   */
  async checkRedemptionMessage(recipient: string, sourcePublicKey: string): Promise<boolean> {
    const onChain = (await this.view(
      "redemption_message",
      [addressArg(recipient)],
      sourcePublicKey,
    )) as Buffer;
    const local = buildRedemptionMessage(this.config.vaultId, recipient);
    return Buffer.from(local).equals(onChain);
  }

  async deposit(
    signer: Keypair,
    depositId: Uint8Array,
    blindedB: Uint8Array,
  ): Promise<string> {
    const { hash } = await this.invoke(signer, "deposit", [
      addressArg(signer.publicKey()),
      bytesArg(depositId),
      bytesArg(blindedB),
    ]);
    return hash;
  }

  async announce(signer: Keypair, depositId: Uint8Array, sPrime: Uint8Array): Promise<string> {
    const { hash } = await this.invoke(signer, "announce", [
      bytesArg(depositId),
      bytesArg(sPrime),
    ]);
    return hash;
  }

  async refund(signer: Keypair, depositId: Uint8Array): Promise<string> {
    const { hash } = await this.invoke(signer, "refund", [bytesArg(depositId)]);
    return hash;
  }

  /**
   * Submits a redemption. `signer` only pays the fee — it proves nothing about
   * token ownership and need not be the recipient, which is the whole point of
   * `redeem` taking no `require_auth`.
   */
  async redeem(
    signer: Keypair,
    recipient: string,
    nullifier: Uint8Array,
    spendSig: Uint8Array,
    unblindedS: Uint8Array,
  ): Promise<string> {
    const { hash } = await this.invoke(signer, "redeem", [
      addressArg(recipient),
      bytesArg(nullifier),
      bytesArg(spendSig),
      bytesArg(unblindedS),
    ]);
    return hash;
  }
}

export interface VaultConfig {
  mintAuthority: string;
  mintPk: Uint8Array;
  token: string;
  denomination: bigint;
}

export type DepositStatus = "None" | "Pending" | "Announced" | "Refunded";

const STATUS_ORDER: DepositStatus[] = ["None", "Pending", "Announced", "Refunded"];

/**
 * `DepositStatus` is a unit-variant `#[contracttype]` enum. Depending on the
 * SDK version, `scValToNative` hands it back as a discriminant or as the
 * variant name, so accept both rather than guessing.
 */
function normalizeStatus(raw: unknown): DepositStatus {
  if (typeof raw === "number") {
    const name = STATUS_ORDER[raw];
    if (!name) throw new Error(`unknown deposit status discriminant ${raw}`);
    return name;
  }
  if (typeof raw === "string" && (STATUS_ORDER as string[]).includes(raw)) {
    return raw as DepositStatus;
  }
  throw new Error(`unexpected deposit status: ${JSON.stringify(raw)}`);
}

/** Convenience for scripts that hardcode testnet. */
export const TESTNET_PASSPHRASE = Networks.TESTNET;
