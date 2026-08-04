# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`cpp` (Compliant Privacy Pool) is a fixed-denomination Soroban vault: deposit one
denomination, withdraw it later to an unrelated address with no on-chain link
between the two, while the operator still screens depositors at the entrance.

The primitive is a **Chaum blind signature over BLS12-381**, not a ZK proof —
there is no circuit, no trusted setup, no Merkle tree. It is a port of the
`../nozkash` EVM vault; `sep_blindsignaturevault.md` is the standards proposal
that came out
of it. `docs/` holds the architecture write-up and the frontend integration
guide — both are judged deliverables, so keep them true rather than tidy.

## Commands

```bash
cargo test                                  # 50 contract tests (Rust)
cargo test full_lifecycle_pays_recipient    # one test by name
cargo test test_vectors::                   # only the cross-language parity tests
stellar contract build                      # → target/wasm32v1-none/release/cpp_vault.wasm

npm --prefix ts install
npm --prefix ts test                        # vitest, 66 client tests
npm --prefix ts test -- events              # one file
npm --prefix ts test -- -t "clamps a start ledger"   # one test by name
npm --prefix ts run typecheck               # tsc --noEmit
```

Live paths (need `stellar` CLI 22+ and a funded testnet identity):

```bash
./scripts/deploy.sh                 # identities, mint key, build, deploy, write .env (0600)
npm --prefix ts run mint &          # daemon: watch → screen → blind-sign → announce
./scripts/demo.sh                   # full deposit → redeem cycle to a fresh account
npm --prefix ts run sponsor         # create a recipient account under SPONSOR_SECRET
npm --prefix ts run client -- {init|deposit|scan|status|redeem <G…>|refund --index n|recover}
```

`demo.sh` deletes `.cpp/wallet.json` and starts a fresh seed — never run it
against a wallet holding unspent tokens.

## The invariant that governs everything

The TypeScript client computes crypto that the Rust contract verifies. They
must agree **byte for byte**, and nothing in either build catches divergence —
only the parity tests do.

Values duplicated across both languages (`contracts/vault/src/crypto.rs` ↔
`ts/src/crypto.ts`): `HASH_TO_G1_DST` (`CPP-V1-CS01-with-BLS12381G1_XMD:SHA-256_SSWU_RO_`),
`REDEEM_DOMAIN` (`CPP-V1-REDEEM`), the G2 generator and its precomputed
negation, and the uncompressed big-endian ZCash point layout
(`be(X)||be(Y)` for G1, `be(X_c1)||be(X_c0)||be(Y_c1)||be(Y_c0)` for G2).

`contracts/vault/src/vectors.rs` is **generated** — TypeScript produces the
tokens with `@noble/curves`, Rust replays them through the Soroban host, so the
contract redeems tokens whose crypto Rust never computed. After **any** change
to `ts/src/crypto.ts` or the shared constants:

```bash
npm --prefix ts run vectors -- --rust > contracts/vault/src/vectors.rs
cargo test
```

Generation is deterministic, so an unchanged client produces a byte-identical
file — diff it to confirm the two sides are still in sync. Both test suites can
pass while the languages silently disagree if this step is skipped.

## Architecture

**Derivation chain** (`ts/src/crypto.ts`). Everything for token `i` comes from
one seed: `base = sha256(seed || u32be(i))`, then domain-separated into
`spend_sk` (`CPP-V1-spend`), `deposit_id` (`CPP-V1-deposit-id`), and the
blinding factor `r` (`CPP-V1-blind`). The nullifier *is* the Ed25519 public key
of `spend_sk`. `deposit_id` is public at deposit, `nullifier` is public at
redemption, and nothing links them without the seed — that is the unlinkability.
`.cpp/wallet.json` is a cache, not the wallet; `client -- recover` rebuilds it
from the seed plus chain state.

**Contract state machine** (`contracts/vault/src/lib.rs`). Per `deposit_id`:
`None → Pending → Announced`, or `Pending → Refunded`. The vault is immutable —
no admin, no upgrade; rotating the mint key or the denomination means a new
vault. `announce` deletes the `Depositor` entry, dropping the funder↔slot link
on chain. Nullifiers are persistent entries that are extended on every touch and
survive archival, which is what makes the double-spend guard durable.

**`redeem` deliberately takes no `require_auth`.** The Ed25519 spend signature
carries the whole right to spend, so any relayer can submit and pay the fee —
this is what stops the fee payer from becoming the link that blinding removed.
The signed message is `REDEEM_DOMAIN || xdr(vault) || xdr(recipient)`; binding
both is what prevents cross-vault replay and mempool redirection. Never add an
auth check here, and never let a caller supply `Y` — the contract always derives
it from the nullifier.

**Mint daemon** (`ts/src/mint.ts`). Polls `deposit` events from a durable cursor
in `.cpp/mint-cursor.json`, screens the depositor through `ts/src/screening.ts`
(providers compose with unanimous-allow, stop at first deny, risk API fails
closed), calls `announce`, and appends every decision to `.cpp/mint-audit.jsonl`.
The cursor advances only past ledgers genuinely scanned, so a crash replays
rather than drops. The audit log doubles as the dedup store: `decidedDepositsFrom`
seeds an in-memory set of ids that reached `allow`/`deny`, and `run` passes over
those before `handleDeposit`. `skip` is never treated as terminal — a transient
RPC failure is indistinguishable from a permanent one in the record, and
suppressing the retry would strand a depositor. Append to the log *before*
updating the set; the log is the durable copy.

**Event pagination** (`ts/src/soroban.ts`). A single RPC `getEvents` scans only a
bounded ledger window and returns a cursor whether or not it found anything, so
`getEvents` here follows the cursor to chain head. `nextLedger` must never
exceed a ledger that was actually examined; a full page's cursor points at an
*event*, so its ledger is reported as unfinished and gets re-scanned. Both
consumers match on ids and tolerate replay — do not "optimise" the re-scan away.
RPC retains only a few days of events; `retentionFloor()` clamps a start ledger
the server no longer serves rather than erroring.

## Things that will otherwise surprise you

- A bad Ed25519 spend signature has **no error code**: `ed25519_verify` traps in
  the host before any contract error can be raised. Contract errors are 1–8 in
  `contracts/vault/src/error.rs`; `AlreadySpent` is 7.
- `npm --prefix ts run …` executes with `ts/` as the working directory, so
  relative paths from `.env` are anchored on the `.env` file itself by
  `projectRoot()` in `ts/src/config.ts`. Keep new path-valued env vars going
  through `resolveFromRoot`.
- `refund` and `redeem` flip status / burn the nullifier **before** transferring,
  so a re-entrant token contract cannot drain the vault. Preserve that ordering.
- `.env`, `.cpp/`, `target/` and `test_snapshots/` are local state and gitignored.
  `test_snapshots/` is regenerated by `cargo test`; a diff there reflects a
  change in metered cost or contract behaviour and is worth reading, not just
  accepting.
- With no screening provider configured the mint allows everything and warns at
  startup. Fine for a demo, never for production.
- Recipient accounts are created by `ts/src/sponsor.ts` under a single shared
  `SPONSOR_SECRET`, never by the depositor and never by friendbot — whoever
  creates an account is written onto it permanently, so a depositor-created
  recipient publishes the link blinding removes. `assertSponsorIsNotDepositor`
  enforces it. Non-native denominations would also need a sponsored trustline;
  that is not implemented.
