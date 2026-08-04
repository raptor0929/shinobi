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
 *
 * That log is also the daemon's durable memory. Event delivery here is
 * at-least-once by design — see `getEvents` in soroban.ts, which re-scans the
 * ledger a full page ended on rather than risk advancing past unread events —
 * so the mint must be idempotent per deposit, and the audit file is what makes
 * it idempotent across restarts as well as within a run.
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

export interface AuditRecord {
  at: string;
  depositId: string;
  depositor: string | null;
  decision: "allow" | "deny" | "skip";
  reason: string;
  provider: string;
  announceTx?: string;
}

/** Overridable file locations, so tests do not write to the real `.cpp/`. */
export interface MintFiles {
  cursor?: string;
  audit?: string;
}

/**
 * Extracts the deposits that already reached a **terminal** decision.
 *
 * `allow` and `deny` are final judgements about a deposit: the mint either
 * announced it or refused it, and seeing the same event again changes neither.
 *
 * `skip` is deliberately excluded, and the asymmetry is the whole point. A skip
 * means "not actionable *right now*" — the depositor entry read came back empty,
 * or the handler threw. Some of those are permanent (already announced, already
 * refunded) but some are transient (an RPC hiccup mid-poll), and the two are not
 * distinguishable from the record. Treating a skip as final would mean one bad
 * read permanently retires a deposit the mint was supposed to sign, stranding
 * that depositor until they notice and refund. Re-examining a deposit that was
 * genuinely finished costs one wasted state read and one extra log line.
 *
 * Malformed lines are ignored rather than fatal: a truncated final line from a
 * crash mid-append must not stop the daemon from starting.
 */
export function decidedDepositsFrom(auditLog: string): Set<string> {
  const decided = new Set<string>();
  for (const line of auditLog.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Partial<AuditRecord>;
      if (record.depositId && (record.decision === "allow" || record.decision === "deny")) {
        decided.add(record.depositId);
      }
    } catch {
      // Not a record we can read; nothing to learn from it.
    }
  }
  return decided;
}

export class Mint {
  private readonly cursorFile: string;
  private readonly auditFile: string;

  /**
   * Deposits already decided, by hex id. Seeded from the audit log at startup
   * and kept current as decisions are made — the log is the durable copy, this
   * is just the index into it.
   */
  private readonly decided = new Set<string>();

  constructor(
    private readonly rpc: VaultRpc,
    private readonly authority: Keypair,
    private readonly keys: MintKeypair,
    private readonly policy: PolicyEngine,
    files: MintFiles = {},
  ) {
    this.cursorFile = files.cursor ?? CURSOR_FILE;
    this.auditFile = files.audit ?? AUDIT_FILE;
  }

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

    await this.loadDecided();
    let cursor = await this.loadCursor();
    console.log(`[mint] authority ${this.authority.publicKey()}`);
    console.log(`[mint] vault ${this.rpc.vaultId}, resuming from ledger ${cursor}`);
    if (this.decided.size > 0) {
      console.log(`[mint] ${this.decided.size} deposit(s) already decided in the audit log`);
    }

    while (!signal?.aborted) {
      try {
        const page = await this.rpc.getEvents(cursor, ["deposit"]);
        for (const event of page.events) {
          const depositId = toHex(event.key);

          // Re-delivery is expected, not exceptional: the pagination re-scans
          // the ledger each page ended on. Stopping here rather than inside
          // `handleDeposit` is what matters — the previous behaviour rebuilt a
          // byte-identical `announce` (same source, same sequence, so the same
          // hash), the network deduplicated it, `pollTransaction` reported the
          // original success, and a second `allow` was logged carrying the
          // first one's tx hash. An audit log that double-counts admissions is
          // worse than one that is merely noisy.
          if (this.decided.has(depositId)) {
            console.log(`[mint] replay ${depositId.slice(0, 16)}… already decided, not re-logged`);
            continue;
          }

          const record = await this.handleDeposit(event).catch((error) => ({
            at: new Date().toISOString(),
            depositId,
            depositor: null,
            decision: "skip" as const,
            reason: `handler error: ${error instanceof Error ? error.message : String(error)}`,
            provider: "mint",
          }));

          // Append first, then remember: the log is the durable copy, so a
          // crash between the two costs a repeated decision, never a lost one.
          await this.audit(record);
          if (record.decision !== "skip") this.decided.add(record.depositId);

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

  /**
   * Rebuilds the decided-deposit index from the audit log.
   *
   * The cursor alone cannot carry this. It records how far the *ledger* scan
   * got, and the re-scan that makes the scan safe is precisely what re-delivers
   * already-handled events; a restart replays them too. The audit log is the
   * only durable record of what the mint actually decided, so it doubles as the
   * dedup store — no second file to keep consistent with it.
   */
  private async loadDecided(): Promise<void> {
    try {
      for (const id of decidedDepositsFrom(await readFile(this.auditFile, "utf8"))) {
        this.decided.add(id);
      }
    } catch {
      // No audit log yet — first run, nothing decided.
    }
  }

  private async loadCursor(): Promise<number> {
    try {
      const parsed = JSON.parse(await readFile(this.cursorFile, "utf8")) as { ledger?: number };
      if (typeof parsed.ledger === "number") return parsed.ledger;
    } catch {
      // No cursor yet — start from the current ledger below.
    }
    const { sequence } = await this.rpc.server.getLatestLedger();
    return sequence;
  }

  private async saveCursor(ledger: number): Promise<void> {
    await mkdir(dirname(this.cursorFile), { recursive: true });
    await writeFile(this.cursorFile, JSON.stringify({ ledger }, null, 2));
  }

  private async audit(record: AuditRecord): Promise<void> {
    await mkdir(dirname(this.auditFile), { recursive: true });
    await appendFile(this.auditFile, `${JSON.stringify(record)}\n`);
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
  // An already-aborted signal never fires `abort` again, so without this check
  // a Ctrl-C landing mid-poll would still wait out the full interval before the
  // loop noticed.
  if (signal?.aborted) return Promise.resolve();
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
