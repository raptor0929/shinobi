## Preamble

```
SEP: To Be Assigned
Title: Blind Signature Transfer Vault
Author: Fabio Laura (@raptor0929)
Status: Draft
Created: 2026-08-04
Updated: 2026-08-04
Version: 0.1.0
Discussion: <opened before submission at https://github.com/orgs/stellar/discussions>
```

> **Editorial note, to be removed before submission.** This file is `SEP-DRAFT.md`
> in the reference implementation's repository, where the audience is someone
> reading the project. When submitted to `stellar/stellar-protocol` it must be
> **renamed to `sep_blindsignaturevault.md`**, per the `sep_{shorttitle}.md`
> convention that repository expects from drafts.
>
> The SEP number is left as `To Be Assigned` deliberately: the ecosystem README
> instructs authors not to self-assign, reference, or request one. Nor should
> `ecosystem/README.md` be edited in the submitting PR — a maintainer adds both
> the number and the index row on merge. The `Discussion` link must be filled in
> with a real GitHub Discussion URL before the PR is opened.
>
> The reference implementation is named **CPP (Compliant Privacy Pool)**. The
> title here describes the interface rather than the implementation, following
> the convention of SEP-1 (*Stellar Info File*) and SEP-41 (*Soroban Token
> Interface*), and avoids "privacy pool", which is an established term of art
> for the association-set and zero-knowledge design this proposal deliberately
> does not use.

## Simple Summary

A fixed-denomination privacy pool for Soroban that uses **blind signatures**
instead of zero-knowledge proofs, and enforces compliance at **ingress** rather
than at exit. Deposits are screened when they enter the pool, where the funder's
address is public anyway. Redemptions are unlinkable to deposits — including to
the operator, who is mathematically unable to correlate them.

## Dependencies

- **CAP-59** — BLS12-381 host functions. This proposal depends on
  `bls12_381_hash_to_g1`, `bls12_381_check_pairing`, `bls12_381_g1_mul`, and the
  G1/G2 curve and subgroup checks.
- **SEP-41** — token interface, satisfied by any Stellar Asset Contract.
- **RFC 9380** — `BLS12381G1_XMD:SHA-256_SSWU_RO_`, the hash-to-curve suite the
  host implements.
- **RFC 8032** — Ed25519, via the `ed25519_verify` host function.

## Motivation

### The problem with exit-side compliance

Existing on-chain privacy pools screen at the wrong end. A user deposits, waits,
and then proves at withdrawal time that their funds trace back to an approved
set of deposits. This has three costs that have kept regulated institutions away:

1. **It requires a ZK circuit.** Proving membership in an association set means
   a Merkle inclusion proof inside a SNARK, which means a trusted setup or a
   large verifier, a proving key to distribute, and a circuit that is expensive
   to audit and effectively impossible to amend.
2. **The compliance decision is made after the fact.** Funds are already inside
   the anonymity set when screening happens. An operator who later discovers a
   sanctioned depositor has already provided that depositor with an anonymity
   set, which is the service they were obliged not to provide.
3. **It pushes the burden onto the honest user.** Every withdrawer must fetch an
   association set, build a proof, and pay for its verification — including
   users nobody ever had a question about.

### The observation this proposal rests on

**A depositor's address is already public.** It appears in the transaction that
funds the deposit. Screening it reveals nothing that was private.

So screen there. Do the compliance work at the moment it costs no privacy, and
let the anonymity set contain only funds that have already been cleared. What
remains private — who was ultimately paid, and when — is exactly what a payment
system should keep private, and exactly what no one has a standing right to
know about a cleared transaction.

This inverts the trust model in a way that is better for both sides. The
operator gets a decision point *before* funds are commingled, which is what
their obligations actually require. The user gets an anonymity set with no
retroactive-clawback risk, and pays for no proof.

### Why this is newly practical on Stellar

CAP-59 gives Soroban a native `hash_to_g1` implementing RFC 9380. On the EVM,
the same construction requires try-and-increment hashing in a loop, with a
256-bit modular exponentiation per iteration via the `0x05` precompile, because
no EVM precompile does hash-to-curve. That loop is the dominant cost of the
EVM version of this scheme and its only unbounded one.

Stellar removes it entirely. A single host call replaces the loop, and the
resulting contract is **smaller and cheaper than its EVM counterpart** — not a
port that survived the transition, but one the platform makes better.

### Prior art on Stellar

This construction was proposed for Stellar in 2015. `stellar/stellar-protocol`
issue [#19, "Anonymous transactions with blind signatures"][issue-19], opened in
June 2015, sketched blind-signed transfers through a gateway in essentially the
form specified here. It was labelled `needs draft`, never received one, and was
closed in March 2019.

Nothing was wrong with the idea; the platform could not carry it. There was no
smart contract layer to hold the vault, and no host function to hash into a
pairing-friendly group. CAP-59 supplies both halves of what was missing, and
this document is the draft that issue never got.

[issue-19]: https://github.com/stellar/stellar-protocol/issues/19

## Abstract

A CPP vault holds a single asset at a single denomination. The protocol has four
operations and three parties: a client, an on-chain vault, and an off-chain mint.

```
  Client                            Vault                        Mint
    |                                 |                            |
    |  spend_sk ← random (Ed25519)    |                            |
    |  nullifier = spend_pk           |                            |
    |  Y = hash_to_g1(nullifier)      |                            |
    |  r ← random scalar              |                            |
    |  B = r · Y                      |                            |
    |                                 |                            |
    |── deposit(deposit_id, B) ──────►|                            |
    |     + one denomination          |─── deposit event ─────────►|
    |                                 |                    screen depositor
    |                                 |                    S' = sk · B
    |                                 |◄── announce(deposit_id, S')|
    |                                 |                            |
    |  S = S' · r⁻¹ = sk · Y          |                            |
    |                                 |                            |
    |    ... time passes ...          |                            |
    |                                 |                            |
    |── redeem(recipient, ───────────►|  ed25519_verify            |
    |     nullifier, sig, S)          |  nullifier unspent         |
    |                                 |  e(S, G2) == e(Y, PK)      |
    |                                 |── one denomination ──────► recipient
```

The mint signs `B`, which is `Y` masked by a secret scalar `r`. It never sees
`Y`, so when `S` and `nullifier` later appear on chain it cannot tell which of
its own signatures settled that redemption. The blinding is information-
theoretic: `B` is uniformly distributed over G1 regardless of `Y`.

## Specification

### Terminology

| Term | Meaning |
|---|---|
| Vault | The Soroban contract holding pooled funds |
| Mint | Off-chain service that screens depositors and issues blind signatures |
| Token | A client-held bearer credential worth one denomination |
| `nullifier` | Ed25519 public key; a token's public identity, revealed only at redemption |
| `deposit_id` | Public identifier of a deposit slot, unlinkable to `nullifier` |
| `B` | Blinded point `r · H(nullifier)` |
| `S'` | Blind signature `sk · B` |
| `S` | Unblinded signature `sk · H(nullifier)` |

### Cryptographic parameters

Implementations MUST use:

- **Curve**: BLS12-381, with signatures in G1 and public keys in G2.
- **Hash to curve**: RFC 9380 `BLS12381G1_XMD:SHA-256_SSWU_RO_` with the
  domain separation tag
  `CPP-V1-CS01-with-BLS12381G1_XMD:SHA-256_SSWU_RO_`.
- **Point encoding**: uncompressed big-endian, as the host requires — G1 is 96
  bytes (`X ‖ Y`), G2 is 192 bytes (`X_c1 ‖ X_c0 ‖ Y_c1 ‖ Y_c0`). The top three
  bits of the first byte are flags and MUST be zero.
- **Spend keys**: Ed25519 per RFC 8032.

A vault MUST expose its DST through a view so clients can verify agreement
rather than assume it.

### Contract interface

```rust
// Immutable. There is no admin and no upgrade path.
fn __constructor(
    env: Env,
    mint_authority: Address,   // may call `announce`
    mint_pk: BytesN<192>,      // G2 public key, subgroup-checked here
    token: Address,            // SEP-41 / SAC
    denomination: i128,        // fixed for the life of the vault
);

fn deposit(env: Env, depositor: Address, deposit_id: BytesN<32>, blinded_b: BytesN<96>);
fn announce(env: Env, deposit_id: BytesN<32>, s_prime: BytesN<96>);
fn refund(env: Env, deposit_id: BytesN<32>);
fn redeem(
    env: Env,
    recipient: Address,
    nullifier: BytesN<32>,
    spend_sig: BytesN<64>,
    unblinded_s: BytesN<96>,
);

// Views
fn redemption_message(env: Env, recipient: Address) -> Bytes;
fn config(env: Env) -> Config;
fn is_spent(env: Env, nullifier: BytesN<32>) -> bool;
fn deposit_status(env: Env, deposit_id: BytesN<32>) -> DepositStatus;
fn hash_to_g1_dst(env: Env) -> Bytes;
```

#### `deposit`

Requires `depositor.require_auth()`. Rejects a reused `deposit_id`. Transfers
exactly `denomination` from the depositor into the vault, records the deposit as
`Pending`, stores the depositor for refund purposes, and emits `deposit`.

The vault MUST NOT validate `blinded_b`. A malformed `B` wastes only the
depositor's own funds, is caught by the mint before signing, and is always
recoverable through `refund`. Validating it on chain would charge every honest
depositor for a check that protects no one.

#### `announce`

Requires the mint authority's authorisation. Transitions `Pending → Announced`,
**removes the stored depositor**, and emits `announce` carrying `S'`.

Restricting `announce` is not a privacy measure — `S'` is safe to publish — but
an anti-griefing one. An open `announce` would let anyone spray junk signatures
at deposit ids and force every wallet to sift through them during recovery.

#### `refund`

Requires the original depositor's authorisation and a `Pending` status. This is
what prevents the compliance gate from becoming a fund trap: a depositor the
mint declines to sign for, or whose mint has simply gone away, always gets their
money back. Implementations MUST set the status before transferring.

#### `redeem`

`redeem` MUST NOT require Soroban authorisation. The right to spend is carried
entirely by `spend_sig`, so any third party can submit the transaction and pay
the fee. This is load-bearing in two ways: a recipient can be paid without ever
holding a funded Stellar account, and the submitting account carries no
information about who owns the token.

The vault MUST perform these checks, in this order:

1. `spend_sig` is a valid Ed25519 signature by `nullifier` over
   `redemption_message(recipient)`.
2. `nullifier` has not been spent. The vault MUST record it as spent **before**
   verifying the pairing or transferring.
3. `unblinded_s` is on-curve and in the G1 prime-order subgroup.
4. `e(S, G2) == e(H(nullifier), PK)`, implemented as the single check
   `e(S, -G2) · e(H(nullifier), PK) == 1`.

The subgroup check on `S` is mandatory on every redemption. Without it a
small-order point can satisfy the pairing equation without the mint's key.
`mint_pk`, by contrast, is checked once in the constructor and need not be
rechecked, since it is immutable.

#### `redemption_message`

```
REDEEM_DOMAIN ‖ xdr(vault_address) ‖ xdr(recipient)
```

where `REDEEM_DOMAIN` is the ASCII string `CPP-V1-REDEEM`.

Binding the **recipient** is what prevents front-running: a watcher who lifts a
redemption from the mempool cannot repoint it at an address of their own.
Binding the **vault** prevents cross-vault replay when two vaults share a mint
key. Implementations MUST expose this as a view so clients can check their
construction against the contract's rather than reimplementing XDR encoding by
inspection.

### Client key derivation

Clients SHOULD derive all token material from one seed, so that the wallet file
is a disposable cache and the seed is the only backup:

```
base       = SHA-256(seed ‖ u32be(index))
spend_sk   = SHA-256("CPP-V1-spend"      ‖ base)
deposit_id = SHA-256("CPP-V1-deposit-id" ‖ base)
r          = SHA-256("CPP-V1-blind"      ‖ base)  reduced into Z_r*
nullifier  = Ed25519_public(spend_sk)
```

`deposit_id` and `nullifier` are both public, at different times. Deriving them
from a shared `base` under distinct domain separators means neither can be
computed from the other without the seed — which is precisely what makes the two
halves of a token's life unlinkable.

### Events

| Topic 0 | Topic 1 | Data |
|---|---|---|
| `deposit` | `deposit_id` | `blinded_b` (96 bytes) |
| `announce` | `deposit_id` | `s_prime` (96 bytes) |
| `redeem` | `nullifier` | `recipient` |
| `refund` | `deposit_id` | `to` |

These are the wallet's only recovery channel; no server-side index is involved.
Note that the `deposit` event deliberately does **not** carry the depositor's
address, so the funder ↔ deposit link is not written into the permanent event
log. The mint reads it from contract state instead, where it is deleted on
`announce`.

#### Consuming events correctly

Because events are the only recovery channel, implementations MUST get two
details of Soroban RPC's `getEvents` right. Both are easy to miss, because
getting them wrong produces silence rather than an error.

1. **Follow the cursor.** A single `getEvents` call scans a bounded window of
   ledgers and returns a cursor whether or not it found anything. An empty
   response does **not** mean there are no events in the requested range — only
   that none were in the window scanned. Implementations MUST paginate until
   they reach the ledger the server reports as latest.

2. **Never advance a stored cursor past what was scanned.** It is tempting to
   persist `latestLedger + 1` from the response, but that ledger has not
   necessarily been examined. Doing so skips events permanently: a wallet's
   token stays pending forever, and a mint silently never sees deposits it was
   obliged to screen. A persisted cursor MUST be derived from the highest ledger
   actually scanned.

Implementations SHOULD also clamp a requested start ledger to the server's
`oldestLedger`, since RPC rejects a request below its retention floor. Events
older than that window are unavailable from RPC and require an archive source;
a wallet SHOULD report this case explicitly rather than presenting it as "no
signature yet", because the two call for very different user action.

## Design Rationale

### Why blind signatures and not zero-knowledge proofs

| | ZK privacy pool | CPP |
|---|---|---|
| Trusted setup | Usually required | None |
| Circuit to audit | Yes | No |
| Anonymity set | All deposits in the tree | All deposits sharing a mint key and denomination |
| Client proving cost | Seconds, megabytes of keys | One scalar multiplication |
| On-chain verification | Groth16 verifier + Merkle root | One pairing check |
| Who can censor | No one | The mint, at ingress only, bounded by `refund` |
| Compliance timing | After commingling | Before commingling |

The honest trade is in the last two rows. CPP accepts a censoring party in
exchange for eliminating the trusted setup, the circuit, and the proving cost —
and it converts that censorship into the feature a regulated operator needs.
A ZK pool's operator cannot refuse a sanctioned deposit; CPP's can, and can
prove it did.

CPP does not attempt to hide *amounts* or make deposits themselves private.
Those are the properties a ZK system buys with its complexity. If an application
needs them, it needs a different design.

### Relationship to Confidential Tokens

Stellar's [Confidential Tokens][ct] developer preview — a contract suite from
OpenZeppelin with an UltraHonk verifier by Nethermind, announced July 2026 —
wraps any SEP-41 token so that balances and transfer amounts are hidden as
Pedersen commitments. It "hide[s] balances and transfer amounts while keeping
sender and recipient addresses visible", and is aimed at known-counterparty
settings: payroll, treasury, institutional settlement.

That is the exact inverse of this proposal, and the two compose rather than
compete:

| | Confidential Tokens | This proposal |
|---|---|---|
| Amount | hidden | **fixed and public** |
| Sender ↔ recipient link | **visible** | hidden |
| Counterparties | known to each other | unknown to each other |
| Mechanism | ZK proofs over commitments | blind signature, one pairing check |

An application that needs both is not served by either alone. Neither is
strictly more private than the other — they conceal different columns of the
same ledger row, and which one matters is a question about the application, not
about the cryptography.

A separate community draft proposes zero-knowledge group-membership state on
Soroban. That is the ZK-shaped route to the same unlinkability this document
obtains from a blind signature, and carries the trade-offs tabulated above:
richer policies expressible in a circuit, at the cost of a circuit to audit and
a proof for every honest user to produce.

[ct]: https://stellar.org/blog/developers/developer-preview-confidential-tokens-on-stellar

### Why BLS12-381 and not BN254

Soroban exposes both. BN254 has no `hash_to_g1` host function, and there is no
modexp host function to build one with, so a BN254 implementation would have to
run try-and-increment with 256-bit modular exponentiation inside WASM. BLS12-381
provides RFC 9380 hash-to-curve natively and offers a higher security level.
There is no case for BN254 here.

### Why fixed denomination

A variable-amount pool leaks the deposit ↔ redemption link through the amount.
Fixed denominations are what make the anonymity set real. Applications needing
other amounts should deploy several vaults and let clients combine tokens,
accepting that each vault has its own, smaller anonymity set.

### Why the vault is immutable

Rotating `mint_pk` would invalidate every outstanding token. Changing
`denomination` would split the anonymity set between old and new tokens. Both
are honest reasons to deploy a new vault rather than mutate a live one, so the
contract has no admin key at all — which also removes it as a target.

### Why Ed25519 nullifiers

The EVM original uses a secp256k1 address recovered with `ecrecover`. Stellar
has no `ecrecover`, but it does have `ed25519_verify`, and Ed25519 keys are the
native Stellar signature type. Using the spend public key *as* the nullifier
means the double-spend marker and the spend authority are the same 32 bytes,
with no extra hash or storage entry.

## Security Concerns

### What the mint can and cannot do

- **Cannot forge tokens.** Every redemption is checked against `mint_pk` by an
  on-chain pairing. A mint that signs garbage produces a token nobody can spend.
- **Cannot steal funds.** It never takes custody, and `redeem` pays only the
  recipient named in the holder's signature.
- **Cannot link deposits to redemptions.** It signs `B = r·Y` and never learns
  `Y`. This is not a policy commitment; it is an inability.
- **Can refuse to sign.** This is the compliance gate and simultaneously the
  liveness assumption. `refund` bounds the harm to a delay.
- **Can refuse selectively and unaccountably.** Nothing in this proposal forces
  the mint to apply its stated policy consistently. Operators SHOULD publish
  their policy and their decision logs; this proposal does not, and cannot,
  enforce that.

### Anonymity set

Privacy is bounded by the number of *unredeemed* tokens sharing a vault. A vault
with one outstanding token provides none. Clients SHOULD warn users when the
set is small, and SHOULD introduce delay between deposit and redemption:
depositing and immediately redeeming links the two by timing regardless of the
cryptography.

Correlating fee-paying accounts is the other practical deanonymiser. Clients
SHOULD submit redemptions from an account unrelated to the depositor, which
`redeem` is designed to permit.

### Transaction history

`announce` deletes the depositor ↔ `deposit_id` link from ledger *state*, but
the original `deposit` transaction remains in history, and its arguments include
the depositor. Deleting the state entry minimises what a state query returns; it
does not erase history, and this proposal does not claim otherwise. The property
that survives is the one that matters: nothing in state *or* history links a
`deposit_id` to a `nullifier`.

### Front-running

A redemption in flight is public before it lands. Because `spend_sig` commits to
the recipient and the vault, an observer can copy the transaction but cannot
redirect the payment — the worst they achieve is paying the fee on the holder's
behalf.

### Nullifier archival

Spent nullifiers live in persistent storage. Soroban archives persistent entries
but never deletes them, and an archived entry must be restored before a
transaction that reads it can execute — restoration brings back the spent
marker, so the double-spend guard survives archival. Implementations MUST NOT
use temporary storage for nullifiers.

### Denial of service on the mint

The mint pays the fee for every `announce`. A depositor who deposits and refunds
in a loop imposes cost on the mint without cost to themselves beyond their own
fees. Operators SHOULD rate-limit by depositor address, which is available to
them precisely because screening happens at ingress.

### Small-subgroup attacks

`S` MUST be subgroup-checked on every redemption; a small-order point can
otherwise satisfy `e(S, G2) == e(Y, PK)` without the mint's key. `B` need not be
checked on chain, but a mint MUST check it before signing, since signing an
attacker-chosen point outside G1 can leak information about `sk`.

## Implementation

A complete reference implementation accompanies this proposal:

- **Contract** — Soroban/Rust, ~12 KB of WASM, 10 exported functions.
- **Client library** — TypeScript, using `@noble/curves` for BLS12-381 and
  Ed25519.
- **Mint daemon** — pluggable screening (denylist, allowlist, external risk API),
  fails closed, writes an append-only JSONL audit log.
- **CLI wallet** — deposit, scan, redeem, refund, and seed-only recovery.

### Test strategy

The implementation includes a cross-language parity suite that is worth
describing, because it addresses the failure mode most likely to reach
production in a system like this: the client and the contract agreeing on the
protocol but disagreeing on a byte.

Test vectors are generated by the **TypeScript** client — points, scalars, blind
signatures, and Ed25519 spend authorisations — and then replayed through the
**Soroban host** in Rust unit tests. The contract redeems tokens whose crypto
Rust never computed. A divergence in domain separation, scalar reduction, point
encoding, or address XDR layout fails a test rather than stranding a token.

Both address kinds are covered, since Soroban encodes `ScAddress::Account` and
`ScAddress::Contract` differently and the redemption message commits to that
encoding.

### Deployment

The reference vault is deployed on Stellar testnet with the native XLM SAC at a
1 XLM denomination.

## Changelog

- **0.1.0** — Initial draft.
