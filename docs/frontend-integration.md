# Frontend integration guide

For a developer building a web UI on top of a deployed `cpp` vault. Read
[`architecture.md`](./architecture.md) first — this document assumes you know
what a blind signature buys and what it does not.

The short version: **the browser is the wallet.** All the cryptography that
matters runs client-side, because the moment a server sees the blinding factor
`r` the privacy guarantee is gone. Your backend's job is to *not* learn things.

---

## What you are integrating with

Three things, only one of which is the contract:

| Piece | What it is | Who runs it |
|---|---|---|
| **Vault contract** | Deployed Soroban contract, immutable | anyone; you just need its ID |
| **Mint daemon** | `npm --prefix ts run mint` — watches, screens, signs | the operator |
| **Sponsor + relayer** | Two funded accounts with an HTTP wrapper | the operator |

The mint is not an API you call. It reacts to on-chain `deposit` events on its
own schedule; your frontend observes the resulting `announce` event. There is no
endpoint to poll and no request to authenticate.

> **This repo ships the sponsor and relayer as CLI tools, not services.**
> `npm run sponsor` creates an account under `SPONSOR_SECRET`; `client -- redeem`
> submits under `RELAYER_SECRET`. Both hold secret keys and neither has an HTTP
> surface. Putting them behind an endpoint is work you have to do, and
> [below](#the-two-services-you-have-to-build) is what those endpoints must and
> must not do.

---

## Reusing the client crypto

`ts/src/crypto.ts` is the reference implementation of the values the contract
verifies. Do not reimplement it — reimplementing it is exactly how the two sides
drift, and nothing in either build catches that.

It depends only on `@noble/curves` and `@noble/hashes`, both browser-native. Its
one Node-ism is `Buffer`, used in `toHex` and `fromHex` (lines 69 and 75).
Bundlers polyfill `Buffer` by default; if yours does not, those two functions
are three lines each to replace with a hex loop. Everything else — derivation,
blinding, unblinding, pairing verification, Ed25519 signing — is portable as
written.

`buildRedemptionMessage` in `ts/src/soroban.ts` is also browser-safe: it uses
only `Address.fromString(...).toScVal().toXDR()` from `@stellar/stellar-sdk`.

Do **not** port `ts/src/wallet.ts` as-is — it writes JSON to disk. Port the
`WalletFile` / `TokenRecord` shapes and back them with IndexedDB or
`localStorage`. Wallet state is a cache; the seed is the wallet.

---

## The flow, screen by screen

### 1 · The seed

```ts
import { deriveTokenSecrets } from "./crypto";

const seed = crypto.getRandomValues(new Uint8Array(32));
```

Everything for token `i` — spend key, deposit id, blinding factor — comes from
`deriveTokenSecrets(seed, i)`. Nothing else needs to be stored, and nothing else
can be recovered without it.

This is the hardest UX problem in the whole integration, and it is worth
treating as one rather than as a modal:

- **Nobody can restore it.** Not the mint, not the vault. A lost seed is a
  permanently locked deposit — the funds sit in the vault forever, unspendable
  even by the operator.
- **Force an explicit backup before the deposit button becomes live.** After the
  deposit, a lost seed loses money. Before it, it loses nothing.
- **Never transmit it.** Not for "backup", not in telemetry, not to Sentry. If
  it leaves the browser, treat the token as compromised.
- Encrypting it under a passphrase in `localStorage` is a reasonable default,
  as long as the passphrase prompt is not skippable.

### 2 · Deposit

Needs the user's own Stellar account, because `deposit` calls
`depositor.require_auth()`. This is the one step where the user signs with their
real wallet — Freighter, xBull, Albedo, whatever. It is meant to be public: the
deposit is the screened, attributable half of the transaction.

```ts
const t = deriveTokenSecrets(seed, index);
const { B } = blindToken(t.nullifier, t.r);   // B = r · H(nullifier)

// invoke: deposit(depositor, deposit_id, B)
//   addressArg(userPublicKey), bytesArg(t.depositId), bytesArg(serializeG1(B))
```

`VaultRpc.deposit(signer, depositId, blindedB)` shows the argument order, but it
signs with a local `Keypair`. In a browser you build the transaction, simulate,
`assembleTransaction`, then hand the XDR to the wallet extension to sign and
submit.

Before the user commits, show them:

- the exact denomination (the vault takes one amount and only that amount)
- that their address is screened and recorded off chain by the operator
- that they can `refund` if the mint declines

Persist the token record as `pending` **before** submitting. A deposit whose
index you forgot is recoverable from the seed, but only if you know to look.

### 3 · Wait for the mint

Poll `announce` events, matching on `deposit_id`:

```ts
const page = await vault.getEvents(cursor, ["announce"]);
for (const ev of page.events) {
  if (equalBytes(ev.key, t.depositId)) {
    const sPrime = deserializeG1(ev.data as Uint8Array);
    // ...
  }
}
cursor = page.nextLedger;
```

Three things about this loop:

- **`nextLedger` is authoritative — do not compute your own.** It is one past
  the highest ledger *actually scanned*, which is not the same as one past
  "latest". Advancing past an unscanned ledger drops events permanently.
- **Events replay.** Match on ids and make handling idempotent. Do not try to
  optimise the re-scan away.
- **RPC keeps only a few days of events.** `retentionFloor()` clamps a start
  ledger the server no longer serves. A wallet that has been closed for a week
  must reconcile through `deposit_status`, not through events.

If you would rather not run an event loop, `depositStatus(depositId, source)`
returns `"None" | "Pending" | "Announced" | "Refunded"` from a single simulated
view call. It tells you *whether* the mint signed but not *what* it signed, so
you still need the event (or a rescan) to obtain `S′`.

There is no promised latency. The mint polls on its own interval and screening
may call an external API. Show a genuinely open-ended progress state, and offer
refund as an escape hatch rather than a failure mode.

### 4 · Unblind and verify

```ts
const S = unblindSignature(sPrime, t.r);          // S = S′ · r⁻¹
const ok = verifyBlindSignature(config.mintPk, t.nullifier, S);
if (!ok) throw new Error("mint signed something unusable");
```

**Verify locally before telling the user the token is spendable.** The mint
cannot forge a valid signature, but it can publish garbage, and the failure is
otherwise invisible until redemption reverts with `InvalidBlindSignature` (8).
`verifyBlindSignature` runs the same pairing check the contract does.

Store `S` alongside the record and mark it `ready`. From here the token is
bearer value: whoever holds `S` and can sign with `spend_sk` can spend it.

### 5 · The recipient account

The recipient must be an account the depositor did **not** create. On Stellar,
the account that puts up a new account's base reserve is written onto it
permanently — as the `create_account` source and, under sponsorship, as
`sponsoringID`. A depositor-created recipient publishes the exact edge the blind
signature removes.

So: call the operator's sponsor endpoint, which runs the three-operation
sponsorship (`begin_sponsoring_future_reserves` / `create_account` with starting
balance `0` / `end_sponsoring_future_reserves`) under one shared key.

One shared sponsor on every recipient distinguishes none of them. That is the
whole property, and it is why friendbot works on testnet — it is a single
constant — and why "let the user fund it" does not.

An existing account the user already controls is also fine, and is better if
that account has no relationship to the depositor. It is worse if it does. The
UI should ask, not assume.

### 6 · Redeem — the step to get right

```ts
const message = buildRedemptionMessage(vaultId, recipient);
const sig = signRedemption(t.spendSecret, message);
// hand { recipient, nullifier, sig, S } to the relayer
```

**The user's own wallet must never submit this transaction.** `redeem` takes no
`require_auth` precisely so that someone else can pay the fee. If the depositor
pays it, the fee payer becomes the link that blinding removed — every other
control in the system is wasted by that one transaction.

The good news is that handing the redemption to a stranger is safe by
construction: `recipient` is bound into the signed message, so a relayer that
rewrites it invalidates the signature. It can refuse to submit, and it learns
`recipient ↔ nullifier ↔ your IP` — but it cannot steal.

Three UI consequences:

- Never surface the redemption as "connect your wallet to withdraw". It is not
  that kind of action, and framing it that way invites users to fix it wrongly.
- Encourage delay. The anonymity set is the deposits outstanding when you
  redeem; immediate redemption pairs up by timing regardless of the
  cryptography. Say this in the interface, not in a whitepaper.
- Consider routing the relayer call over Tor/a proxy, or at minimum do not
  co-locate it with your analytics.

### 7 · Recovery

A wallet with only the seed rebuilds itself: derive indices `0, 1, 2, …`, call
`depositStatus(depositId)` and `isSpent(nullifier)` for each, and stop after a
run of `None`s. `client -- recover` in `ts/src/client.ts` is the reference.

Ship this. Browser storage is evicted routinely, and a user whose IndexedDB was
cleared has not lost anything — but only if you give them the button.

---

## Contract reference

### Functions

| Function | Auth | Arguments |
|---|---|---|
| `deposit` | `depositor.require_auth()` | `depositor: Address`, `deposit_id: BytesN<32>`, `blinded_b: BytesN<96>` |
| `announce` | `mint_authority.require_auth()` | `deposit_id: BytesN<32>`, `s_prime: BytesN<96>` |
| `refund` | `depositor.require_auth()` | `deposit_id: BytesN<32>` |
| `redeem` | **none** | `recipient: Address`, `nullifier: BytesN<32>`, `spend_sig: BytesN<64>`, `unblinded_s: BytesN<96>` |

Views (simulate, no fee): `config() -> Config`, `deposit_status(deposit_id) -> DepositStatus`,
`is_spent(nullifier) -> bool`, `redemption_message(recipient) -> Bytes`,
`hash_to_g1_dst() -> Bytes`.

`redemption_message` is worth calling once at startup and comparing against your
local `buildRedemptionMessage`. It is cheap insurance against XDR encoding drift
between the SDK and the host — a mismatch would otherwise show up as an
unexplained trap at redemption. `VaultRpc.checkRedemptionMessage` does exactly
this.

`Config` is `{ mint_authority: Address, mint_pk: BytesN<192>, token: Address,
denomination: i128 }`. Read it once and cache it: the vault is immutable, so it
cannot change under you.

### Events

All four carry the key as a topic and the payload as `single-value` data.

| Topic | Key (topic 2) | Data |
|---|---|---|
| `deposit` | `deposit_id` | `blinded_b` (96 B) |
| `announce` | `deposit_id` | `s_prime` (96 B) |
| `redeem` | `nullifier` | `recipient` |
| `refund` | `deposit_id` | `to` |

The depositor's address is deliberately **not** in the `deposit` event. It lives
in the `Depositor(deposit_id)` ledger entry, which `announce` deletes — so it is
readable while the deposit is pending, and gone from the chain afterwards. The
mint reads it there (`VaultRpc.getDepositor`); your frontend should not need it.

### Errors

| # | Error | Typically means |
|---|---|---|
| 1 | `InvalidDenomination` | constructor only |
| 2 | `InvalidMintKey` | constructor only |
| 3 | `DepositIdAlreadyUsed` | index reused — your `nextIndex` is stale |
| 4 | `DepositNotFound` | refunding or announcing an unknown slot |
| 5 | `AlreadyAnnounced` | duplicate `announce`; benign, treat as success |
| 6 | `NotDepositor` | refund from the wrong account |
| 7 | `AlreadySpent` | nullifier burned — double spend, or a duplicate submit |
| 8 | `InvalidBlindSignature` | `S` does not pair against `mint_pk` |

**A bad Ed25519 spend signature has no error code.** `ed25519_verify` traps in
the host before any contract error can be raised, so you get a host trap rather
than a numbered failure. Do not build error handling that assumes every
redemption failure carries a code.

Because `redeem` checks the signature *first*, a trap and a `7` mean very
different things: a trap is a malformed or wrongly-bound signature (wrong
recipient, wrong vault, wrong key), while `7` means the token genuinely was
already spent. Show those differently.

---

## The two services you have to build

### Sponsor endpoint

Wraps `createSponsoredAccount` from `ts/src/sponsor.ts`.

- Holds `SPONSOR_SECRET`. Must **never** be the depositor's key —
  `assertSponsorIsNotDepositor` enforces this and should stay enforced.
- Returns the new account's public key and secret. The secret is generated
  server-side by `Keypair.random()` and returned over the wire, which is
  acceptable for a demo and is not acceptable if you are custodying value: let
  the browser generate the keypair and send only the public key.
- Rate-limit it. It costs a base reserve per call and is otherwise a faucet.
- It sees the recipient address and nothing else. Keep it that way — do not
  accept a `deposit_id` "for correlation".

### Relayer endpoint

Accepts `{ recipient, nullifier, spendSig, unblindedS }` and submits `redeem`.

- Holds only a funded fee account. It cannot steal: the recipient is signed.
- Log as little as you can bear. `nullifier ↔ recipient` is already public in
  the `redeem` event; `nullifier ↔ IP ↔ timestamp` is not, and it is the
  strongest deanonymising signal in the system.
- Failures are ordinary and safe to retry — a duplicate submit of an already
  landed redemption returns `AlreadySpent` (7), not a second payout.
- The dream is that this is not your endpoint at all. Any third party can run
  one; a frontend that lets the user pick their relayer is strictly better than
  one that hard-codes yours.

---

## Privacy checklist

Every item here is a way to leak the link that the cryptography removes.
Cryptographic failure is not the realistic threat; these are.

- [ ] The seed never leaves the browser — including via error reporting.
- [ ] The redemption is submitted by a relayer, never the depositor's wallet.
- [ ] The recipient account was created by the shared sponsor, not the depositor.
- [ ] `deposit_id` and `nullifier` are never sent to the same server in one
      request, or written to the same analytics event.
- [ ] The UI states, plainly, that redeeming shortly after depositing defeats
      the pool.
- [ ] Deposit and redeem are not fired from the same page load in a way that
      correlates them in your own logs.
- [ ] Users are told the operator screens depositors and can refuse — this is a
      compliance feature, not a hidden one.

---

## Limits to design around

Do not paper over these; a UI that overstates the guarantee is worse than one
that explains it.

- **One denomination.** No partial withdrawals, no change. `n` tokens means `n`
  independent deposits and `n` independent redemptions.
- **The anonymity set is small and visible.** Anyone can count outstanding
  deposits. Consider showing the number honestly rather than hiding it.
- **The mint can refuse.** By design. `refund` bounds it, and the UI should make
  refund a first-class action, not an error state.
- **Non-native assets are not fully supported.** A non-native denomination would
  need a sponsored trustline on each recipient before it could be paid. Only
  account creation is implemented.
- **No mobile-wallet story is implemented.** Deposit needs a Stellar signer;
  everything else is plain HTTP and local crypto.

---

## Verifying you got it right

Before shipping, do one cycle and check it on chain:

1. The recipient's operation history contains exactly the sponsored creation and
   the vault's payment. **The depositor's address must not appear.**
2. The `redeem` transaction's source account is the relayer.
3. `deposit_status(deposit_id)` is `Announced` and the `Depositor` entry is
   gone.
4. `is_spent(nullifier)` is `true`.

`./scripts/demo.sh` performs exactly this cycle end to end against a deployed
vault and prints the three unlinked facts to compare against. If your frontend's
on-chain footprint differs from the demo's, the difference is the leak.
