/**
 * Mint idempotency.
 *
 * Deposit events arrive at-least-once by construction. `getEvents` re-scans the
 * ledger a page ended on rather than risk advancing a durable cursor past
 * unread events (see events.test.ts for why that trade is the right way round),
 * and a restart replays whatever the cursor has not passed. So the daemon sees
 * the same deposit more than once as a matter of routine, not as an error.
 *
 * It used to handle that badly, and the failure was quiet. On the second
 * delivery the depositor lookup could still read pre-announce state, so the
 * "already fulfilled" skip did not catch it; `announce` then rebuilt a
 * byte-identical transaction — same source, same sequence number, therefore the
 * same hash — which the network deduplicated and `pollTransaction` reported as
 * a success. The mint logged a second `allow` carrying the first one's tx hash.
 * Nothing broke; the audit log just claimed two admissions where one happened,
 * which for a compliance record is the wrong kind of wrong.
 *
 * The fix makes the audit log itself the dedup store. These tests pin both
 * halves of it: decided deposits are not re-handled, and skipped ones still are.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The poll interval is read once at module load, and `drain` below needs to run
// several polls per test. Hoisted so it lands before mint.js is evaluated.
vi.hoisted(() => {
  process.env.CPP_MINT_POLL_MS = "0";
});

import {
  blindToken,
  deriveTokenSecrets,
  mintKeypairFromSeed,
  serializeG1,
  toHex,
  type MintKeypair,
} from "../src/crypto.js";
import { Mint, decidedDepositsFrom, type AuditRecord } from "../src/mint.js";
import { PolicyEngine } from "../src/screening.js";
import type { EventPage, VaultEvent, VaultRpc } from "../src/soroban.js";

const DEPOSITOR = "GAMQSJSFZ2WQJGLTBGO32TDBT343UUNX5AD5PANKX7KZSYAAEP7NIZSW";
const keys: MintKeypair = mintKeypairFromSeed(new Uint8Array(32).fill(7));

/** A `deposit` event carrying a genuinely valid blinded point. */
function depositEvent(index: number, ledger = 100): VaultEvent {
  const secrets = deriveTokenSecrets(new Uint8Array(32).fill(index + 1), index);
  const { B } = blindToken(secrets.nullifier, secrets.r);
  return {
    name: "deposit",
    key: secrets.depositId,
    data: serializeG1(B),
    ledger,
    txHash: `tx-${index}`,
  };
}

/**
 * A vault that always reports a pending depositor.
 *
 * Deliberately unhelpful: it never lets the "no pending depositor entry" skip
 * fire. That path masked the bug in production, so a fake that leans on it
 * would test the mask rather than the fix.
 */
class FakeVault {
  readonly vaultId = "CB72LNFU3AWO34Q5PFV7NKINO5KVTQIXYE4PCH4TE32T7I6K2OL5QCFA";
  readonly announced: string[] = [];
  depositor: string | null = DEPOSITOR;
  pages: EventPage[] = [];

  readonly server = { getLatestLedger: async () => ({ sequence: 100 }) };

  async getEvents(): Promise<EventPage> {
    return this.pages.shift() ?? { events: [], nextLedger: 101 };
  }

  async getDepositor(): Promise<string | null> {
    return this.depositor;
  }

  async announce(_signer: Keypair, depositId: Uint8Array): Promise<string> {
    this.announced.push(toHex(depositId));
    return `announce-tx-${this.announced.length}`;
  }
}

/** The real composer, over one provider that admits everyone. */
const allowAll = new PolicyEngine([
  {
    name: "test",
    screen: async () => ({ decision: "allow" as const, reason: "test policy", provider: "test" }),
  },
]);

/** Runs the poll loop for exactly as many iterations as there are queued pages. */
async function drain(mint: Mint, vault: FakeVault): Promise<void> {
  const controller = new AbortController();
  const pending = vault.pages.length;
  let polls = 0;
  const original = vault.getEvents.bind(vault);
  vault.getEvents = async () => {
    const page = await original();
    if (++polls >= pending) controller.abort();
    return page;
  };
  await mint.run(controller.signal);
}

describe("decidedDepositsFrom", () => {
  it("collects allow and deny, but never skip", () => {
    const log = [
      { depositId: "aa", decision: "allow" },
      { depositId: "bb", decision: "deny" },
      // A skip is "not actionable right now", and a transient RPC failure looks
      // exactly like a permanent one in the record. Retiring a deposit on this
      // evidence would strand a depositor the mint meant to sign for.
      { depositId: "cc", decision: "skip" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");

    expect(decidedDepositsFrom(log)).toEqual(new Set(["aa", "bb"]));
  });

  it("survives a truncated final line", () => {
    // A crash mid-append leaves half a record. The daemon has to start anyway.
    const log = `${JSON.stringify({ depositId: "aa", decision: "allow" })}\n{"depositId":"bb","dec`;
    expect(decidedDepositsFrom(log)).toEqual(new Set(["aa"]));
  });

  it("is empty for an empty log", () => {
    expect(decidedDepositsFrom("")).toEqual(new Set());
    expect(decidedDepositsFrom("\n\n")).toEqual(new Set());
  });
});

describe("Mint replay handling", () => {
  let dir: string;
  let vault: FakeVault;
  let mint: Mint;

  async function auditRecords(): Promise<AuditRecord[]> {
    const text = await readFile(join(dir, "audit.jsonl"), "utf8").catch(() => "");
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as AuditRecord);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cpp-mint-"));
    vault = new FakeVault();
    mint = new Mint(vault as unknown as VaultRpc, Keypair.random(), keys, allowAll, {
      cursor: join(dir, "cursor.json"),
      audit: join(dir, "audit.jsonl"),
    });
  });

  it("announces and audits a deposit once", async () => {
    const event = depositEvent(0);
    vault.pages = [{ events: [event], nextLedger: 101 }];

    await drain(mint, vault);

    expect(vault.announced).toEqual([toHex(event.key)]);
    const records = await auditRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.decision).toBe("allow");
  });

  it("does not re-announce a deposit redelivered in a later page", async () => {
    const event = depositEvent(0);
    // The same event twice is not a contrived case: it is what the ledger
    // re-scan produces on every page boundary.
    vault.pages = [
      { events: [event], nextLedger: 101 },
      { events: [event], nextLedger: 102 },
    ];

    await drain(mint, vault);

    // One announce, one audit line. Before the fix this was two of each, the
    // second carrying the first's tx hash.
    expect(vault.announced).toHaveLength(1);
    expect(await auditRecords()).toHaveLength(1);
  });

  it("does not re-announce after a restart", async () => {
    const event = depositEvent(0);
    vault.pages = [{ events: [event], nextLedger: 101 }];
    await drain(mint, vault);

    // A fresh process against the same files: the cursor may not have advanced
    // past this ledger, so the event arrives again. Only the audit log knows
    // the deposit was already decided.
    const restarted = new Mint(vault as unknown as VaultRpc, Keypair.random(), keys, allowAll, {
      cursor: join(dir, "cursor.json"),
      audit: join(dir, "audit.jsonl"),
    });
    vault.pages = [{ events: [event], nextLedger: 102 }];
    await drain(restarted, vault);

    expect(vault.announced).toHaveLength(1);
    expect(await auditRecords()).toHaveLength(1);
  });

  it("still retries a deposit that was only skipped", async () => {
    const event = depositEvent(0);
    // First pass: the depositor read comes back empty — indistinguishable from
    // an RPC blip. Second pass: it succeeds.
    vault.depositor = null;
    vault.pages = [{ events: [event], nextLedger: 101 }];
    await drain(mint, vault);

    expect(vault.announced).toHaveLength(0);
    expect((await auditRecords())[0]!.decision).toBe("skip");

    vault.depositor = DEPOSITOR;
    vault.pages = [{ events: [event], nextLedger: 102 }];
    await drain(mint, vault);

    // The retry is the point. Suppressing skips would have retired this deposit
    // permanently on one bad read, leaving the depositor to notice and refund.
    expect(vault.announced).toEqual([toHex(event.key)]);
    const records = await auditRecords();
    expect(records.map((r) => r.decision)).toEqual(["skip", "allow"]);
  });

  it("seeds the decided set from an audit log it did not write", async () => {
    const event = depositEvent(0);
    // Simulates the state this bug left behind: a prior run's decisions on disk
    // with no in-memory index.
    await writeFile(
      join(dir, "audit.jsonl"),
      `${JSON.stringify({ at: "earlier", depositId: toHex(event.key), depositor: DEPOSITOR, decision: "allow", reason: "prior run", provider: "test" })}\n`,
    );

    vault.pages = [{ events: [event], nextLedger: 101 }];
    await drain(mint, vault);

    expect(vault.announced).toHaveLength(0);
    expect(await auditRecords()).toHaveLength(1);
  });

  it("keeps handling deposits it has not seen", async () => {
    const first = depositEvent(0);
    const second = depositEvent(1);
    vault.pages = [
      { events: [first], nextLedger: 101 },
      // The re-scan redelivers `first` alongside a genuinely new deposit; the
      // new one must not be lost to the dedup.
      { events: [first, second], nextLedger: 102 },
    ];

    await drain(mint, vault);

    expect(vault.announced).toEqual([toHex(first.key), toHex(second.key)]);
    expect(await auditRecords()).toHaveLength(2);
  });
});
