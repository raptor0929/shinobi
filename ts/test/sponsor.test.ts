/**
 * Sponsored account creation.
 *
 * Creating an account is the one place in a redemption where an *identity* has
 * to be written to the ledger alongside the payout. Stellar records both the
 * `create_account` source and, for a sponsored account, the `sponsoringID` on
 * the account entry itself — permanently, queryable by anyone.
 *
 * So the properties these tests pin are not "the transaction is well-formed"
 * for its own sake; each one is a way the privacy claim could quietly fail:
 *
 *   - Wrong operation sources → the sponsorship sandwich is rejected, or worse,
 *     the reserve comes from somewhere unintended.
 *   - A non-zero starting balance → the sponsor makes a *payment* to the
 *     recipient, an amount an observer can correlate against.
 *   - The depositor as sponsor → the depositor -> recipient edge is published
 *     on every redemption, and everything else in the design stops mattering.
 *
 * The transaction build is deliberately a pure function so all of this can be
 * asserted without a network.
 */

import { Account, Keypair, Networks, Operation, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { assertSponsorIsNotDepositor, buildSponsoredCreationTx } from "../src/sponsor.js";

const NETWORK = Networks.TESTNET;

/** A sponsor with a known sequence number; no network is ever touched. */
function sponsorAccount(keypair: Keypair): Account {
  return new Account(keypair.publicKey(), "42");
}

describe("buildSponsoredCreationTx", () => {
  const sponsor = Keypair.random();
  const created = Keypair.random();

  it("wraps the creation in a begin/end sponsorship sandwich", () => {
    const tx = buildSponsoredCreationTx(sponsorAccount(sponsor), NETWORK, created.publicKey());

    // The order is protocol, not preference: reserves can only be sponsored
    // between a begin and its matching end, and the account must exist inside
    // that window for its base reserve to land on the sponsor.
    expect(tx.operations.map((op) => op.type)).toEqual([
      "beginSponsoringFutureReserves",
      "createAccount",
      "endSponsoringFutureReserves",
    ]);

    const begin = tx.operations[0] as Operation.BeginSponsoringFutureReserves;
    expect(begin.sponsoredId).toBe(created.publicKey());
  });

  it("creates the account with a zero starting balance", () => {
    const tx = buildSponsoredCreationTx(sponsorAccount(sponsor), NETWORK, created.publicKey());
    const create = tx.operations[1] as Operation.CreateAccount;

    expect(create.destination).toBe(created.publicKey());
    // Not a placeholder. The base reserve is the sponsor's, so the new account
    // needs nothing of its own — and any non-zero amount would be a transfer
    // from the sponsor, on chain, in a size an observer could match against a
    // later payout.
    // The SDK normalises the amount to 7 decimal places, so compare the value
    // rather than the spelling.
    expect(Number(create.startingBalance)).toBe(0);
  });

  it("sources the end operation from the account being created", () => {
    const tx = buildSponsoredCreationTx(sponsorAccount(sponsor), NETWORK, created.publicKey());

    // The first two operations inherit the transaction source (the sponsor);
    // only the third overrides it. This is why the brand-new, empty keypair
    // still has to sign: it is consenting to being sponsored.
    expect(tx.operations[0]!.source).toBeUndefined();
    expect(tx.operations[1]!.source).toBeUndefined();
    expect(tx.operations[2]!.source).toBe(created.publicKey());
    expect(tx.source).toBe(sponsor.publicKey());
  });

  it("is signed by both the sponsor and the new account", () => {
    const tx = buildSponsoredCreationTx(sponsorAccount(sponsor), NETWORK, created.publicKey());
    tx.sign(sponsor, created);

    const payload = tx.hash();
    expect(tx.signatures).toHaveLength(2);
    // Either signature missing means the transaction fails on submission —
    // check the actual payload rather than trusting the count.
    expect(sponsor.verify(payload, tx.signatures[0]!.signature())).toBe(true);
    expect(created.verify(payload, tx.signatures[1]!.signature())).toBe(true);
  });

  it("prices the classic operations well below the Soroban fee", () => {
    const tx = buildSponsoredCreationTx(sponsorAccount(sponsor), NETWORK, created.publicKey());

    // `fee` on a built transaction is per-op × ops. Reusing soroban.ts's
    // BASE_FEE (1 XLM per op) here would burn 3 XLM to create an account that
    // is about to receive 1.
    expect(Number(tx.fee)).toBe(30_000);
    expect(Number(tx.fee)).toBeGreaterThanOrEqual(300); // 3 × the 100-stroop floor
  });

  it("round-trips through XDR", () => {
    const tx = buildSponsoredCreationTx(sponsorAccount(sponsor), NETWORK, created.publicKey());
    const envelope = xdr.TransactionEnvelope.fromXDR(tx.toXDR(), "base64");

    expect(envelope.v1().tx().operations()).toHaveLength(3);
  });
});

describe("assertSponsorIsNotDepositor", () => {
  it("rejects a sponsor that is also the depositor", () => {
    const alice = Keypair.random();

    // The failure this catches is silent: everything works, the demo passes,
    // and every recipient account permanently names its own depositor.
    expect(() => assertSponsorIsNotDepositor(alice.publicKey(), alice.secret())).toThrow(
      /same account/,
    );
  });

  it("allows any other sponsor", () => {
    expect(() =>
      assertSponsorIsNotDepositor(Keypair.random().publicKey(), Keypair.random().secret()),
    ).not.toThrow();
  });

  it("does not block when no depositor is configured", () => {
    // The mint operator running `sponsor` has no DEPOSITOR_SECRET in scope, and
    // an absent variable is not evidence of a collision.
    expect(() => assertSponsorIsNotDepositor(Keypair.random().publicKey(), undefined)).not.toThrow();
  });

  it("does not block on a malformed depositor secret", () => {
    // Reporting that is the client's job; failing here would turn a typo in an
    // unrelated variable into an unexplained sponsor failure.
    expect(() => assertSponsorIsNotDepositor(Keypair.random().publicKey(), "not-a-secret")).not.toThrow();
  });
});
