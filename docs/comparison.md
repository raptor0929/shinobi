# CPP vs. a ZK privacy pool

A side-by-side against [NethermindEth/stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments),
the closest comparable system on Stellar. Both hide who paid whom. They reach it
by opposite routes, and the trade-offs are sharper than "one is cheaper".

Cost figures come from [`benchmark.md`](./benchmark.md), which has the probe code
and methodology. Everything else is read off the two implementations.

## The two systems

**CPP** — one vault holds one asset at one fixed amount. You deposit, an off-chain
mint screens your (already public) address and blind-signs your token, and later
anyone can redeem that token to any address. The primitive is a Chaum blind
signature over BLS12-381: no circuit, no trusted setup, no Merkle tree.

**stellar-private-payments** — a shielded UTXO pool. Notes are commitments in a
Poseidon2 Merkle tree; spending proves in zero knowledge that you own an unspent
note, and separately that you are in an ASP allowlist and out of a blocklist.
Groth16 over BN254, circuits in Circom.

## At a glance

| | CPP | stellar-private-payments |
|---|---|---|
| **Denomination** | Fixed per vault; extensible to many | Arbitrary, capped per-tx |
| **Partial withdrawal** | Not today; reachable by splitting | Yes, with shielded change |
| **On-chain cost, spend** | 28.2M CPU (whole call) | 37.2M verify + ~8.6M tree |
| **On-chain cost, deposit** | 0.36M | Same as a spend |
| **Client-side work** | ~14 ms, measured | Groth16 proving (not measured) |
| **Time to spendable** | Waits on the mint | Immediate |
| **Trusted setup** | None | Per-circuit ceremony |
| **Curve security** | BLS12-381, ~126-bit | BN254, ~100-bit |
| **Who can block you** | Mint, at deposit only | ASP, via set membership |
| **Audited** | No | No (stated in their README) |

## Denomination

**CPP is fixed-denomination and that is load-bearing, not a limitation to fix.**
`denomination` is a constructor argument and there is no admin to change it. Every
token in a vault is worth exactly the same, so the amount reveals nothing — which
is the entire reason the anonymity set works.

The cost is fragmentation. Supporting 1, 10, and 100 XLM means three vaults with
three separate, smaller anonymity sets, and a user moving 111 XLM touches all
three in a pattern that is itself distinguishing.

**This is extensible, and cheaply.** A vault does not have to be single-
denomination — the construction supports several within one contract by binding
the denomination into the token itself, either with a separate mint key per
denomination or by domain-separating the hash-to-curve, so that
`Y = H(nullifier ‖ denomination)` and a token is only ever redeemable for the
amount it was signed for. One deployment, one mint, several denominations, and no
change to the verification path.

What that does *not* do is merge the anonymity sets. Tokens still partition by
denomination, because the amount is public at redemption and always will be in
this design. Multi-denomination support is an ergonomics and deployment win, not
a privacy one — worth building, but it does not close the gap with a single
shielded tree.

**They support arbitrary amounts.** Value lives in note commitments, so any amount
works, bounded per transaction by `maximum_deposit_amount`. One tree serves every
user and every amount, so their anonymity set is strictly larger — but amounts are
hidden by ZK rather than by uniformity, which is what the circuit is buying.

## Partial withdrawals

**As implemented, CPP cannot do them.** A token is a bearer credential for exactly
one denomination; `redeem` transfers `denomination` to the recipient and burns the
nullifier. There is no way to spend half.

**A useful form of it is reachable, though.** With multi-denomination vaults (see
above), two extensions get most of the way:

- **Combining.** Redeem several tokens in one transaction to pay a larger amount.
  This needs no new cryptography — just a batch entrypoint verifying one pairing
  per token — and it makes arbitrary sums payable at the granularity of the
  smallest denomination.
- **Splitting, or change.** Redeem one token and have the mint blind-sign
  replacements totalling less the amount paid out. The mint still only ever sees
  blinded points, so it still cannot link; the cost is that it returns to the
  spend path, so spending inherits the deposit path's liveness dependency, and
  the timing of the re-issue wants the same delay discipline as a deposit.

**What blind signatures cannot reach is their version of it.** A signature
certifies "this token is worth D" — it carries no hidden value that can be
arithmetically split. To spend a partial amount with the remainder staying
*shielded and of a hidden size*, you need value in commitments and a proof that
inputs balance outputs, which is a ZK circuit by definition. Their 2-in/2-out
design does exactly this: `ext_amount` negative withdraws to a public recipient
and the change returns as a fresh commitment, in one transaction.

So: partial withdrawal in the practical sense is an extension CPP can make.
Partial withdrawal with change of a concealed amount is not, and that remains the
sharpest functional line between the two designs.

## Cost

| | CPU instructions | % of 100M tx budget |
|---|---|---|
| CPP `deposit` | 360,987 | 0.36% |
| CPP `announce` | 126,673 | 0.13% |
| CPP `redeem` (entire call) | 28,178,586 | 28.2% |
| Their Groth16 verify (11 public inputs) | 37,246,988 | 37.2% |
| Their Merkle insert (depth 10, extrapolated) | ~8,590,000 | ~8.6% |

Verification against verification: **1.36× cheaper**. That is a real edge but not
a dramatic one, and the reason is structural — both end in a multi-pairing, ours
with two pairs and theirs with four. Anyone claiming an order of magnitude from
the pairing alone is wrong.

The gap widens on the whole journey, because `transact` is their only entrypoint
that moves value, so a deposit costs the same as a withdrawal:

```
Their deposit + withdraw:  2 × (37.2M + ~8.6M)    ≈  91.6M
CPP deposit + redeem:      0.36M + 0.13M + 28.2M  ≈  28.7M
```

**CPP's deposit is the outlier: 361k instructions and no curve arithmetic at
all**, because the client does the blinding and the vault just records bytes. A
shielded pool cannot have a cheap deposit — a commitment has to enter the tree
and the tree has to stay consistent.

## Speed

Two different things get called speed here, and they point in opposite directions.

**Client-side work, per spend.** Measured on this machine with `@noble/curves`:

| | ms |
|---|---|
| `hashNullifierToG1` | 3.80 |
| `blindToken` (hash + one G1 mul) | 8.56 |
| `unblindSignature` (one G1 mul) | 5.02 |

The whole client-side spend path is **~14 ms** and needs no key material beyond
the seed. Their side is a Groth16 proof over a 2-in/2-out circuit with a depth-10
note tree plus two depth-10 sparse-Merkle policy proofs, which requires a proving
key download and is structurally orders of magnitude more work. **I did not
measure it** — `circom` and `snarkjs` were not available — so treat the direction
as solid and the magnitude as unquantified here.

**Time until funds are spendable — and here CPP is worse.** A CPP deposit is not
spendable when it confirms. The mint has to see the `deposit` event, screen the
depositor, and call `announce` before the token can be unblinded. If the mint is
down or slow, the depositor waits, and their only recourse is `refund`. Their
design has no such wait: a deposit is self-contained and the note is usable as
soon as it is in the tree.

That is the honest shape of it. CPP is faster per operation and slower to become
usable, because it moved a synchronous proof into an asynchronous third party.

## Security

### What you have to trust

| | CPP | stellar-private-payments |
|---|---|---|
| Trusted setup | None | Per-circuit ceremony; toxic waste forges proofs |
| Circuit correctness | No circuit | A soundness bug mints value |
| Gatekeeper | Mint refuses to sign | ASP controls set membership |
| Can the gatekeeper steal? | No — never takes custody | No |
| Can the gatekeeper link? | **No — mathematically unable** | No |
| Recourse if refused | `refund`, always available | Excluded from the set |

CPP's attack surface is one pairing check and one Ed25519 verification. Theirs is
a Groth16 verifier plus every constraint in the circuit — a much larger surface,
and one where bugs are silent rather than loud.

### Where CPP is genuinely stronger

- **No trusted setup.** Nothing to ceremony, nothing to leak. Compromised toxic
  waste in a Groth16 setup means forged proofs and unlimited withdrawal, and it
  is undetectable from on-chain data.
- **Curve security level.** BLS12-381 targets ~126 bits. BN254 was long quoted at
  128 but sits near ~100 bits after the exTNFS improvements to the tower number
  field sieve. This is a real margin difference, not a preference.
- **Auditability.** The whole verification is four steps in one function. There
  is no circuit to review and no proving key to trust.
- **Front-running is already closed.** `spend_sig` commits to both the recipient
  and the vault address, so a watcher can copy a redemption out of the mempool
  but cannot repoint it. The worst they achieve is paying the fee.
- **Re-entrancy ordering.** `redeem` and `refund` burn the nullifier and flip
  status *before* transferring, so a hostile token contract cannot re-enter and
  drain.

### Where CPP is genuinely weaker

- **The mint is a censor, and an unaccountable one.** Nothing forces it to apply
  its stated policy consistently, and nothing on chain proves it did. `refund`
  bounds the damage to a delay and the loss of the deposit's timing privacy —
  but the mint is a party their design does not need at spend time.
- **Liveness depends on the mint.** If it disappears, outstanding deposits are
  refundable but no new tokens can be created. The vault is immutable, so a
  compromised or rotated mint key means deploying a new vault and abandoning the
  old anonymity set.
- **Smaller, fragmented anonymity sets.** Privacy is bounded by *unredeemed*
  tokens in one vault. A vault with one outstanding token provides none.
- **Timing correlation.** Deposit and immediately redeem and the two are linked
  regardless of the cryptography. This is a client-discipline problem, not a
  protocol one, and CPP does not enforce a delay.
- **Deposit history is permanent.** `announce` deletes the depositor↔slot link
  from ledger *state*, but the original `deposit` transaction and its arguments
  stay in history. What survives is the property that matters — nothing links a
  `deposit_id` to a `nullifier` — but the deposit itself is not private and is
  not claimed to be.

### Status of both

**Neither system is audited.** Theirs says so plainly in its README ("has not yet
been audited and should not be used in production environments with real assets")
and ships a configuration warning about disabling admin-only ASP leaf insertion.
CPP is a hackathon implementation with 50 Rust tests, 66 TypeScript tests, and a
cross-language parity suite — good hygiene, not a substitute for review. Two
claims in `SEP-DRAFT.md` (blinding described as information-theoretic, and the
small-order-point framing) are known to need tightening.

Treat both as reference implementations.

## Which one fits

Choose **CPP** when the amount is naturally uniform and can be public — a fixed
ticket price, a fixed-size payout, a voucher — and you want no trusted setup, a
near-free deposit, a verifier a reviewer can read in one sitting, and a
compliance decision made *before* funds commingle rather than after.

Choose a **shielded UTXO pool** when amounts are genuinely arbitrary rather than
expressible in denominations, when change must stay hidden, when you want one
large anonymity set instead of several small ones, or when you cannot accept a
party that can refuse to sign.

Note that the first three rows of the comparison move if CPP is extended.
Multi-denomination vaults and a combine/split flow are ordinary engineering on
top of the existing verification path — neither needs a new primitive. What does
not move is the last one: hiding the amount requires a circuit, and CPP's whole
cost advantage comes from not having one.

They are not competing designs so much as different answers to "what is allowed
to be public". CPP makes the amount public to make everything else cheap; a ZK
pool hides the amount and pays for it in setup, proving, and audit surface.
