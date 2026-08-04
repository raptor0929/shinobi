/**
 * Event pagination.
 *
 * A single Soroban RPC `getEvents` call scans only a bounded window of ledgers
 * and then hands back a cursor — with or without results. An implementation
 * that reads one response as the final answer has two failure modes, and the
 * second is much worse than the first:
 *
 *   1. It misses events past the window, so a wallet's token looks eternally
 *      pending.
 *   2. It advances a durable cursor to `latestLedger + 1` — past ledgers it
 *      never actually scanned — so those events are lost for good. For the mint
 *      that means silently declining to sign deposits it was never told about.
 *
 * Both were real. These tests pin the pagination that fixes them, against a
 * fake server that reproduces RPC's windowing behaviour.
 */

import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { VaultRpc, ledgerFromCursor } from "../src/soroban.js";

const VAULT_ID = "CB72LNFU3AWO34Q5PFV7NKINO5KVTQIXYE4PCH4TE32T7I6K2OL5QCFA";

const config: Config = {
  rpcUrl: "http://localhost:8000/soroban/rpc",
  networkPassphrase: "Test SDF Network ; September 2015",
  vaultId: VAULT_ID,
} as Config;

/** Builds the cursor RPC would return for a given ledger (TOID in the high bits). */
function cursorAt(ledger: number): string {
  return `${(BigInt(ledger) << 32n).toString()}-0000000000`;
}

interface FakeEvent {
  ledger: number;
  name: string;
  key: string;
}

/**
 * Stands in for `rpc.Server` with the one behaviour that matters: each call
 * scans at most `window` ledgers forward and then stops, returning a cursor.
 */
function fakeServer(options: {
  events: FakeEvent[];
  latestLedger: number;
  oldestLedger: number;
  window: number;
}) {
  const calls: Array<{ startLedger?: number; cursor?: string }> = [];

  const server = {
    calls,
    async getHealth() {
      return { status: "healthy", latestLedger: options.latestLedger, oldestLedger: options.oldestLedger };
    },
    async getEvents(request: { startLedger?: number; cursor?: string; limit?: number }) {
      calls.push({ startLedger: request.startLedger, cursor: request.cursor });

      const from =
        request.cursor !== undefined
          ? ledgerFromCursor(request.cursor)! + 1
          : request.startLedger!;
      if (from < options.oldestLedger) {
        throw new Error(`startLedger ${from} is before the oldest ledger ${options.oldestLedger}`);
      }
      const through = Math.min(from + options.window - 1, options.latestLedger);

      const inWindow = options.events.filter((e) => e.ledger >= from && e.ledger <= through);
      const limit = request.limit ?? 100;
      const truncated = inWindow.length > limit;
      const returned = inWindow.slice(0, limit);

      const events = returned.map((e) => ({
        ledger: e.ledger,
        txHash: `tx-${e.ledger}-${e.key}`,
        topic: [
          xdr.ScVal.scvSymbol(e.name),
          xdr.ScVal.scvBytes(Buffer.from(e.key.padEnd(32, "\0"))),
        ],
        value: xdr.ScVal.scvU32(e.ledger),
      }));

      return {
        events,
        latestLedger: options.latestLedger,
        oldestLedger: options.oldestLedger,
        // On a truncated page the cursor marks the last event returned, not the
        // end of the window — which is the whole reason a ledger-granular
        // resume point cannot claim that ledger.
        cursor: truncated ? cursorAt(returned[returned.length - 1]!.ledger) : cursorAt(through),
      };
    },
  };

  return server;
}

function rpcWith(server: ReturnType<typeof fakeServer>): VaultRpc {
  const client = new VaultRpc(config);
  Object.defineProperty(client, "server", { value: server, writable: true });
  return client;
}

describe("ledgerFromCursor", () => {
  it("decodes the ledger from the TOID in the high 32 bits", () => {
    expect(ledgerFromCursor(cursorAt(3_960_489))).toBe(3_960_489);
    expect(ledgerFromCursor(cursorAt(1))).toBe(1);
  });

  it("returns undefined for anything it cannot read as a TOID", () => {
    expect(ledgerFromCursor("")).toBeUndefined();
    expect(ledgerFromCursor("not-a-toid")).toBeUndefined();
    expect(ledgerFromCursor("0-0")).toBeUndefined();
  });
});

describe("getEvents", () => {
  it("follows the cursor to find events beyond the first scan window", async () => {
    // The bug in one line: the events sit 20k ledgers back, the server scans
    // 10k at a time, and the first response is empty.
    const server = fakeServer({
      events: [
        { ledger: 3_960_469, name: "deposit", key: "aa" },
        { ledger: 3_960_489, name: "announce", key: "aa" },
      ],
      latestLedger: 3_966_475,
      oldestLedger: 3_845_516,
      window: 10_000,
    });

    const page = await rpcWith(server).getEvents(3_946_475);

    expect(page.events.map((e) => e.name)).toEqual(["deposit", "announce"]);
    expect(server.calls.length).toBeGreaterThan(1);
  });

  it("never advances nextLedger past what it actually scanned", async () => {
    // The dangerous half: a caller that persists nextLedger must never be told
    // it has seen ledgers no one looked at.
    const server = fakeServer({
      events: [{ ledger: 500_000, name: "deposit", key: "bb" }],
      latestLedger: 1_000_000,
      oldestLedger: 1,
      window: 100,
    });

    const page = await rpcWith(server).getEvents(1_000);

    // 100 pages × 100 ledgers is nowhere near latestLedger, so the scan stops
    // short — and must report where it stopped, not where the chain head is.
    expect(page.nextLedger).toBeLessThan(1_000_000);
    expect(page.nextLedger).toBeGreaterThan(1_000);
  });

  it("resumes exactly where the previous page stopped, losing nothing", async () => {
    const events = Array.from({ length: 40 }, (_, i) => ({
      ledger: 1_000 + i * 250,
      name: "announce",
      key: `k${i}`,
    }));
    const server = fakeServer({ events, latestLedger: 20_000, oldestLedger: 1, window: 100 });
    const client = rpcWith(server);

    const seen: number[] = [];
    let from = 1_000;
    for (let i = 0; i < 20 && from <= 20_000; i++) {
      const page = await client.getEvents(from);
      seen.push(...page.events.map((e) => e.ledger));
      expect(page.nextLedger).toBeGreaterThan(from);
      from = page.nextLedger;
    }

    expect(seen).toEqual(events.map((e) => e.ledger));
    expect(new Set(seen).size).toBe(seen.length); // no ledger scanned twice
  });

  it("does not claim a ledger it only partially read when a page fills up", async () => {
    // Several events share one ledger and the limit cuts through the middle of
    // it. `nextLedger` has only ledger granularity, so claiming that ledger as
    // done would silently drop its remaining events.
    const events = Array.from({ length: 6 }, (_, i) => ({
      ledger: 5_000,
      name: "announce",
      key: `k${i}`,
    }));
    const server = fakeServer({ events, latestLedger: 6_000, oldestLedger: 1, window: 10_000 });

    const page = await rpcWith(server).getEvents(4_000, undefined, 3);

    expect(page.nextLedger).toBeLessThanOrEqual(5_000);

    // Resuming from nextLedger must still surface every event in that ledger.
    const rest = await rpcWith(server).getEvents(page.nextLedger, undefined, 100);
    const keys = new Set(rest.events.map((e) => e.txHash + e.ledger));
    expect(rest.events.length).toBe(6);
    expect(keys.size).toBeGreaterThan(0);
  });

  it("reports catching up to the chain head once it gets there", async () => {
    const server = fakeServer({
      events: [{ ledger: 950, name: "announce", key: "cc" }],
      latestLedger: 1_000,
      oldestLedger: 1,
      window: 10_000,
    });

    const page = await rpcWith(server).getEvents(900);

    expect(page.events).toHaveLength(1);
    expect(page.nextLedger).toBe(1_001);
    expect(server.calls).toHaveLength(1);
  });

  it("clamps a start ledger the server no longer retains instead of erroring", async () => {
    // Asking for more history than RPC keeps should return everything it kept.
    const server = fakeServer({
      events: [{ ledger: 3_960_489, name: "announce", key: "dd" }],
      latestLedger: 3_966_475,
      oldestLedger: 3_845_516,
      window: 200_000,
    });

    const page = await rpcWith(server).getEvents(1);

    expect(page.events).toHaveLength(1);
    expect(server.calls[0]!.startLedger).toBe(3_845_516);
  });

  it("passes a start ledger on the first call and a cursor on every later one", async () => {
    // RPC rejects a request carrying both, so this is not merely stylistic.
    const server = fakeServer({
      events: [],
      latestLedger: 10_000,
      oldestLedger: 1,
      window: 1_000,
    });

    await rpcWith(server).getEvents(1);

    expect(server.calls[0]).toMatchObject({ startLedger: 1, cursor: undefined });
    for (const call of server.calls.slice(1)) {
      expect(call.startLedger).toBeUndefined();
      expect(call.cursor).toBeDefined();
    }
  });
});
