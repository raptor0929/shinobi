# cpp — Compliant Privacy Pool

A Soroban vault that lets you deposit a fixed amount and later withdraw it to an
unrelated address, with **no on-chain link between the two** — while still
giving the operator a real compliance gate at the entrance.

It is a port of the [nozkash](../nozkash) EVM vault to Stellar. The port is not
a translation: Soroban's BLS12-381 host functions make it **smaller, cheaper,
and simpler than the original**, and that is the point of the proposal in
[**`SEP-DRAFT.md`**](./SEP-DRAFT.md) — a complete draft Stellar Ecosystem
Proposal, titled *Blind Signature Transfer Vault*, ready to submit to
[`stellar/stellar-protocol`](https://github.com/stellar/stellar-protocol).

Status: working end-to-end on testnet. 50 Rust tests, 66 TypeScript tests.

Design notes and diagrams live in [`docs/architecture.md`](./docs/architecture.md);
building a UI on top of a deployed vault is covered in
[`docs/frontend-integration.md`](./docs/frontend-integration.md).

---

## How it works

The primitive is a **Chaum blind signature**, not a ZK proof. There is no
circuit, no trusted setup, no Merkle tree, and no proving time.

```
      Alice (public)                  Mint                   Bob (unlinkable)
      -------------                   ----                   ----------------
  1.  pick nullifier N
      B = r · H(N)          ─ deposit(id, B) ─►  vault locks 1 XLM from Alice
                                                 │
  2.                                             ├─ screens Alice's address
                                                 │  (public anyway — costs no
                                                 │   privacy that isn't spent)
                                                 │
                            ◄─ announce(id, S') ─┤  S' = sk · B     (allow)
                                                 └─ (deny → Alice calls refund)
  3.  S = r⁻¹ · S' = sk · H(N)
      ────────────────────── wait ──────────────────────

  4.                        ─ redeem(Bob, N, sig, S) ─►  vault checks
                                                          e(S, G2) == e(H(N), PK)
                                                          N unspent → pays Bob
```

The mint signs `B`, a point blinded by a secret `r` only Alice knows. When `S`
shows up at redemption the mint cannot tell which of its signatures it is —
`r` is gone. **The anonymity set is every token the mint has ever signed.**

### What the compliance gate does and does not buy

- It **does** keep screened-out funds out of the anonymity set entirely, which
  is what an operator with sanctions obligations actually needs.
- It **does not** let anyone — including the operator — trace an exit back to an
  entrance. There is no viewing key and no escrowed link. If a policy question
  can only be answered by de-anonymising a past redemption, this design cannot
  answer it, by construction rather than by omission.
- A refusal is **not a seizure**: the depositor calls `refund` and gets their
  money back. The gate can decline to admit funds; it can never keep them.

### Why this is simpler on Stellar than on EVM

The EVM original hashes to the curve with try-and-increment over BN254, because
Ethereum gives you no `hash_to_g1`. CAP-59 gives Soroban a **native RFC 9380
`hash_to_g1`** on BLS12-381, plus `pairing_check` and subgroup checks as host
functions. The contract is 12 KB of WASM and the whole verification is:

```rust
// e(S, -G2) · e(H(N), PK) == 1   ⟺   e(S, G2) == e(H(N), PK)
env.crypto().bls12_381().pairing_check(g1_points, g2_points)
```

BN254 is also exposed by the SDK, but has no `hash_to_g1` and there is no
modexp host function — try-and-increment inside WASM would be prohibitive.
BLS12-381 is the right curve here for reasons specific to Stellar.

---

## Layout

```
contracts/vault/src/
  lib.rs           the contract: deposit, announce, refund, redeem + views
  crypto.rs        DST, domain tags, G2 generator, pairing verification
  storage.rs       instance/persistent keys and TTL bumping
  event.rs         the four events a wallet needs to recover from chain
  test.rs          39 unit tests
  test_vectors.rs  cross-language parity: TS-generated tokens, replayed in Rust
  vectors.rs       GENERATED — do not edit (npm run vectors -- --rust)

ts/src/
  crypto.ts        off-chain crypto: derivation, blinding, unblinding, signing
  soroban.ts       ScVal encoding, invocation, paginated event queries
  wallet.ts        local token cache (disposable — the seed is the wallet)
  client.ts        CLI: init, deposit, scan, status, redeem, refund, recover
  mint.ts          the mint daemon: watch → screen → blind-sign → announce
  screening.ts     denylist / allowlist / risk-API providers + policy engine
  sponsor.ts       creates recipient accounts under one shared sponsor key
  vectors.ts       test-vector generator (source of truth for vectors.rs)

docs/
  architecture.md          components, lifecycle, trust boundaries, diagrams
  frontend-integration.md  building a web UI against a deployed vault

SEP-DRAFT.md       the draft SEP — renamed to sep_blindsignaturevault.md
                   when submitted, per the ecosystem repo's convention
```

### Testing strategy worth knowing about

The test vectors are generated entirely by the **TypeScript** client using
`@noble/curves`, then replayed through the **Soroban host** in Rust. The
contract redeems tokens whose crypto Rust never computed.

That is what makes the parity tests meaningful: they catch divergence in domain
separation, scalar reduction, point encoding, and address XDR layout — the four
places where an off-chain client and an on-chain verifier quietly stop agreeing.
Two recipients are covered, one `G…` account and one `C…` contract, because the
address XDR encodings differ in length and layout.

---

## Running it

Prerequisites: Rust with `wasm32v1-none`, `stellar` CLI 22+, Node 22+.

```bash
npm --prefix ts install
cargo test                  # 50 contract tests
npm --prefix ts test        # 66 client tests
```

### Deploy to testnet

```bash
./scripts/deploy.sh
```

This creates and funds four identities (`cpp-mint`, `cpp-alice`, `cpp-relayer`,
`cpp-sponsor`), derives the mint's BLS keypair from `MINT_SEED`, resolves the
native XLM SAC, builds, deploys with constructor arguments, and writes `.env`
with mode 0600. Denomination defaults to 1 XLM.

### Run the demo

```bash
npm --prefix ts run mint &        # watch, screen, blind-sign, announce
./scripts/demo.sh
```

Or step by step:

```bash
npm --prefix ts run client -- init
npm --prefix ts run client -- deposit        # Alice locks 1 XLM
npm --prefix ts run client -- scan           # collect and unblind the signature
npm --prefix ts run client -- status
npm --prefix ts run client -- redeem G...    # pay anyone, from a fresh account
```

The `redeem` call takes **no `require_auth`** — the token authorises itself. The
submitter pays the fee and can be a relayer with no relationship to either side,
which is what keeps the fee-payer from becoming the link that the blinding
removed.

### Creating the account that gets paid

A redemption pays a Stellar address, and that address has to exist first.
Whoever creates it is recorded on it permanently — as the `create_account`
source, and as `sponsoringID` on the account entry. Account creation is
therefore a privacy decision, not plumbing:

```bash
npm --prefix ts run sponsor            # create one, print its address
npm --prefix ts run sponsor -- --quiet # address only, for scripts
```

`SPONSOR_SECRET` puts up the base reserve through
`begin_sponsoring_future_reserves` / `create_account` (starting balance `0`) /
`end_sponsoring_future_reserves`. Two rules make it work:

- **One shared sponsor.** A sponsor that appears on every recipient distinguishes
  none of them, so it carries no information about which deposit any given
  payout came from.
- **Never the depositor.** A depositor who creates their own recipient publishes
  a direct depositor → recipient edge, which is exactly the link the blind
  signature removes. `sponsor` refuses to run in that configuration rather than
  leaving it to an operator to notice.

Testnet's friendbot satisfies the first rule by accident and has no mainnet
equivalent, which is why the demo no longer uses it. Secrets of created accounts
are appended to `.cpp/sponsored-accounts.jsonl` (mode 0600) so the sponsor can
reclaim the reserves; lose that file and the reserves are stranded.

Known gap: this creates the account and nothing more. A vault denominated in a
**non-native** asset would also need a sponsored trustline on the recipient
before it could be paid. The demo vault is native XLM, which needs none.

### If the wallet file is lost

It is a cache, not the wallet. Everything derives from the seed:

```bash
npm --prefix ts run client -- recover --depth 32
```

This walks derivation indices, re-derives each `deposit_id`, asks the vault for
its status, and pulls the matching `announce` signature off the chain.

---

## Compliance configuration

The mint composes providers with unanimous-allow semantics and stops at the
first `deny`:

| Variable | Meaning |
|---|---|
| `CPP_DENYLIST_FILE` | JSON `{ "blocked": ["G…", "C…"] }` |
| `CPP_ALLOWLIST_FILE` | JSON `{ "allowed": [...] }` — deny-by-default |
| `CPP_RISK_API_URL` | external scorer returning `{ "risk": 0..100 }` |
| `CPP_RISK_API_KEY` | bearer token for the above |
| `CPP_RISK_THRESHOLD` | deny at or above this score (default 70) |

The risk provider **fails closed**: a timeout, an HTTP error, or a malformed
response denies the deposit. An operator who could not screen has not screened,
and the depositor loses nothing but time, since `refund` is always available.

With no providers configured the policy allows everything. That is fine for a
demo and must never be a production configuration; the mint logs a warning when
it starts up that way.

Every decision, allow or deny, is appended to `.cpp/mint-audit.jsonl`:

```json
{"depositId":"60883462…","depositor":"GBAI6UEO…","decision":"allow",
 "reason":"cleared denylist","provider":"policy","announceTx":"96a59123…"}
```

That file is also what makes the daemon idempotent. Deposit events are
delivered at-least-once on purpose — the poller re-scans the ledger each page
ended on rather than risk advancing its cursor past events it never read — so
the mint sees the same deposit again routinely, and again after any restart. At
startup it rebuilds the set of deposits that already reached an `allow` or
`deny` from the log itself, and passes over those without re-handling them. A
`skip` is deliberately *not* treated as final: it means "not actionable right
now", and a transient RPC failure is indistinguishable in the record from a
permanent one, so those are always retried.

---

## Live testnet deployment

| | |
|---|---|
| Vault | `CB72LNFU3AWO34Q5PFV7NKINO5KVTQIXYE4PCH4TE32T7I6K2OL5QCFA` |
| Token | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` (native XLM SAC) |
| Denomination | 1 XLM |
| WASM | 12,236 bytes |

Three full deposit → screen → announce → scan → redeem cycles ran end to end.
Alice deposited 1 XLM, the mint screened her against the denylist and signed,
and each time a **brand-new account** received exactly 1 XLM — submitted by a
relayer, with nothing on chain connecting it to Alice:

| Cycle | Recipient | Created by | Redeem tx |
|---|---|---|---|
| 1 | `GDTJK2U4…` | friendbot | [`5a63931d…`](https://stellar.expert/explorer/testnet/tx/5a63931d6c784c597a0d11179e6cf06cf5193af17494fbfae3db8b687071b210) |
| 2 | `GAMQSJSF…` | friendbot | [`236858a5…`](https://stellar.expert/explorer/testnet/tx/236858a5dd0db7525df30304d0a1f2930ec6727217aff9169c3be93b29f183af) |
| 3 | `GB4ZYWZD…` | `cpp-sponsor` | [`0561cbdd…`](https://stellar.expert/explorer/testnet/tx/0561cbddbc3cf7f46c3b4f0d98da2f7ddecfe23cad122c764b0a3fb5dcc3b681) |

Cycle 3 is the first run under the shared sponsor. Its recipient's *entire*
operation history is four entries — `begin_sponsoring_future_reserves`,
`create_account`, `end_sponsoring_future_reserves`, then the redeem — so the
account went from a `0` balance to exactly `1.0000000` XLM, and Alice appears
on none of them. Horizon reports `sponsor` as the sponsor account rather than
the `none` that friendbot leaves behind.

Verified on chain after that cycle: `deposit_status` is `Announced`, `is_spent`
is `true`, and the `Depositor` entry for the deposit id is **absent** — deleted
by `announce`, which is what drops the funder↔slot link.

Replaying a spent token was rejected by the contract with `AlreadySpent`
(error #7), and the wallet's `recover` command rebuilt a token's spendable
state from nothing but the seed and the chain.

---

## Known limits

These are properties of the design, not bugs, and the SEP draft states them too.

- **The mint is a trusted issuer of value.** It cannot steal deposits and cannot
  de-anonymise anyone, but it can mint tokens against a vault it did not fund,
  and it can refuse to sign (the depositor's remedy is `refund`). Splitting the
  key across signers is the obvious hardening and is not implemented here.
- **Fixed denomination.** One vault, one amount. Varying amounts would leak the
  link that blinding removes.
- **The anonymity set is the mint's signing history**, so a young or quiet pool
  offers little cover. Timing correlation between a deposit and a redemption is
  a real attack and is the user's to manage.
- **RPC retains only a few days of events.** A wallet that misses its `announce`
  beyond that window needs an archive source; `recover` will say so rather than
  failing silently.
