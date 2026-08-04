/**
 * The mint daemon.
 *
 * Watches the vault for `deposit` events, screens the depositor against the
 * configured policy, and — if the deposit clears — blind-signs `B` and calls
 * `announce`.
 *
 * The mint holds real power and real limits, and both are worth stating plainly
 * because they are the security argument for the whole design:
 *
 *  - It **cannot forge** a token. `announce` publishes `S' = sk·B`; the vault
 *    pays out only against `S` that pairs with `PK` over `H(nullifier)`. A mint
 *    that signs garbage produces a token nobody can spend, including itself.
 *  - It **cannot steal**. It never holds custody, and redemption pays the
 *    recipient named in the holder's Ed25519 signature.
 *  - It **cannot link** a deposit to a redemption. It signs `B = r·Y` and never
 *    sees `Y`. This is not a promise about the operator's behaviour; it is what
 *    the operator is mathematically unable to do.
 *  - It **can refuse**. That is the compliance gate, and it is the one power
 *    the design deliberately grants. `refund` bounds it: a refused depositor
 *    reclaims their funds.
 *
 * Every decision, allow or deny, is appended to a JSONL audit log. Note what
 * that log can and cannot contain: it records who was admitted to the pool and
 * why, never who was paid.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Keypair } from "@stellar/stellar-sdk";

import { loadConfig, requiredHex, resolveFromRoot } from "./config.js";
import {
  blindSign,
  deserializeG1,
  mintKeypairFromSeed,
  serializeG1,
  toHex,
  type MintKeypair,
} from "./crypto.js";
import { policyFromEnv, type PolicyEngine, type ScreeningResult } from "./screening.js";
import { VaultRpc, type VaultEvent } from "./soroban.js";

const POLL_INTERVAL_MS = Number(process.env.CPP_MINT_POLL_MS ?? 5_000);
const CURSOR_FILE = resolveFromRoot(process.env.CPP_MINT_CURSOR ?? ".cpp/mint-cursor.json");
const AUDIT_FILE = resolveFromRoot(process.env.CPP_MINT_AUDIT ?? ".cpp/mint-audit.jsonl");

interface AuditRecord {
  at: string;
  depositId: string;
  depositor: string | null;
  decision: "allow" | "deny" | "skip";
  reason: string;
  provider: string;
  announceTx?: string;
}

export class Mint {
  constructor(
    private readonly rpc: VaultRpc,
    private readonly authority: Keypair,
    private readonly keys: MintKeypair,
    private readonly policy: PolicyEngine,
  ) {}

  /**
   * Handles one `deposit` event.
   *
   * Returns the audit record rather than writing it, so the caller controls
   * durability ordering and tests can assert on decisions without touching the
   * filesystem.
   */
  async handleDeposit(event: VaultEvent): Promise<AuditRecord> {
    const depositId = event.key;
    const at = new Date().toISOString();
    const base = { at, depositId: toHex(depositId) };

    // The depositor entry disappears on announce, so its absence means this
    // deposit is no longer actionable — most often because we already signed
    // it and are replaying events after a restart.
    const depositor = await this.rpc.getDepositor(depositId);
    if (!depositor) {
      return {
        ...base,
        depositor: null,
        decision: "skip",
        reason: "no pending depositor entry; already fulfilled, refunded, or unknown",
        provider: "mint",
      };
    }

    const screening: ScreeningResult = await this.policy.screen(depositor);
    if (screening.decision === "deny") {
      return { ...base, depositor, decision: "deny", ...pick(screening) };
    }

    // Validate `B` before signing. An off-curve or small-order point is the one
    // thing a malicious depositor could submit that would make our signature
    // mean something other than what we intend, so it never reaches `sk`.
    let sPrime: Uint8Array;
    try {
      const blindedB = deserializeG1(asBytes(event.data));
      sPrime = serializeG1(blindSign(blindedB, this.keys.sk));
    } catch (error) {
      return {
        ...base,
        depositor,
        decision: "deny",
        reason: `unusable blinded point: ${error instanceof Error ? error.message : String(error)}`,
        provider: "mint",
      };
    }

    const announceTx = await this.rpc.announce(this.authority, depositId, sPrime);
    return { ...base, depositor, decision: "allow", ...pick(screening), announceTx };
  }

  /** Polls for new deposits until the process is stopped. */
  async run(signal?: AbortSignal): Promise<void> {
    if (this.policy.isEmpty) {
      console.warn(
        "[mint] WARNING: no screening providers configured — every deposit will be signed.\n" +
          "        Set CPP_DENYLIST_FILE / CPP_ALLOWLIST_FILE / CPP_RISK_API_URL for a real policy.",
      );
    }

    let cursor = await this.loadCursor();
    console.log(`[mint] authority ${this.authority.publicKey()}`);
    console.log(`[mint] vault ${this.rpc.vaultId}, resuming from ledger ${cursor}`);

    while (!signal?.aborted) {
      try {
        const page = await this.rpc.getEvents(cursor, ["deposit"]);
        for (const event of page.events) {
          const record = await this.handleDeposit(event).catch((error) => ({
            at: new Date().toISOString(),
            depositId: toHex(event.key),
            depositor: null,
            decision: "skip" as const,
            reason: `handler error: ${error instanceof Error ? error.message : String(error)}`,
            provider: "mint",
          }));

          await this.audit(record);
          console.log(
            `[mint] ${record.decision.padEnd(5)} ${record.depositId.slice(0, 16)}… ${record.reason}`,
          );
        }

        // Advance only after the whole page is durably recorded, so a crash
        // replays a deposit rather than dropping it. Replay is safe: `announce`
        // rejects an already-announced deposit and the skip path catches it.
        cursor = page.nextLedger;
        await this.saveCursor(cursor);
      } catch (error) {
        console.error(`[mint] poll failed: ${error instanceof Error ? error.message : error}`);
      }

      await sleep(POLL_INTERVAL_MS, signal);
    }
  }

  private async loadCursor(): Promise<number> {
    try {
      const parsed = JSON.parse(await readFile(CURSOR_FILE, "utf8")) as { ledger?: number };
      if (typeof parsed.ledger === "number") return parsed.ledger;
    } catch {
      // No cursor yet — start from the current ledger below.
    }
    const { sequence } = await this.rpc.server.getLatestLedger();
    return sequence;
  }

  private async saveCursor(ledger: number): Promise<void> {
    await mkdir(dirname(CURSOR_FILE), { recursive: true });
    await writeFile(CURSOR_FILE, JSON.stringify({ ledger }, null, 2));
  }

  private async audit(record: AuditRecord): Promise<void> {
    await mkdir(dirname(AUDIT_FILE), { recursive: true });
    await appendFile(AUDIT_FILE, `${JSON.stringify(record)}\n`);
  }
}

function pick(result: ScreeningResult): { reason: string; provider: string } {
  return { reason: result.reason, provider: result.provider };
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return Uint8Array.from(value);
  throw new Error(`expected the event payload to be bytes, got ${typeof value}`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const config = loadConfig();
  const rpc = new VaultRpc(config);

  const authority = Keypair.fromSecret(requireEnv("MINT_AUTHORITY_SECRET"));
  const keys = mintKeypairFromSeed(requiredHex("MINT_SEED", 32));
  const policy = await policyFromEnv();

  // Refuse to run against a vault configured for a different key. Without this
  // check the mint would happily sign deposits whose signatures the vault would
  // then reject, stranding depositors until they refund.
  const onChain = await rpc.fetchConfig(authority.publicKey());
  if (!Buffer.from(keys.pk).equals(Buffer.from(onChain.mintPk))) {
    throw new Error(
      `MINT_SEED does not match the vault's mint key.\n` +
        `  vault expects ${toHex(onChain.mintPk).slice(0, 32)}…\n` +
        `  seed produces ${toHex(keys.pk).slice(0, 32)}…`,
    );
  }
  if (onChain.mintAuthority !== authority.publicKey()) {
    throw new Error(
      `MINT_AUTHORITY_SECRET is ${authority.publicKey()}, but the vault's authority is ${onChain.mintAuthority}`,
    );
  }

  const controller = new AbortController();
  process.on("SIGINT", () => {
    console.log("\n[mint] shutting down");
    controller.abort();
  });

  await new Mint(rpc, authority, keys, policy).run(controller.signal);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — copy example.env to .env and fill it in`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
