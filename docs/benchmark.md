# Benchmark: blind signatures vs. Groth16 on Soroban

How much does the Chaum blind-signature design actually save over a ZK privacy
pool on the same host? This compares `cpp` against
[**NethermindEth/stellar-private-payments**](https://github.com/NethermindEth/stellar-private-payments),
the closest thing to a production-shaped private-payments system on Stellar.

Every number below was measured, not modelled. Nethermind's figures come from
running *their* test suite with a budget probe patched in — same host, same
metering, same SDK major version. The probe code for both sides is at the bottom
so anyone can rerun it.

## Result

| | CPU instructions | % of 100M tx budget | memory bytes |
|---|---|---|---|
| **Nethermind — Groth16/BN254 verify** (11 public inputs) | **37,246,988** | 37.2% | 203,868 |
| **Nethermind — Merkle `insert_two_leaves`** (depth 8) | **6,871,989** | 6.9% | 391,009 |
| **CPP — `redeem`, entire contract call** | **28,178,586** | 28.2% | 272,722 |
| CPP — blind-signature verify alone | 27,438,995 | 27.4% | 155,500 |
| CPP — `hash_to_g1` alone | 2,643,740 | 2.6% | 6,232 |
| **CPP — `deposit`** | **360,987** | 0.36% | 134,345 |
| CPP — `announce` | 126,673 | 0.13% | 51,066 |

**Verification head to head: 37.2M vs 27.4M — `cpp` is 1.36× cheaper.** Measured
against our *entire* `redeem` call, including the token transfer and every
storage write, still 1.32× cheaper.

Per user journey it is not close. Nethermind's `transact`
(`contracts/pool/src/pool.rs:513`) is the only entrypoint that moves value, so
deposits and withdrawals both pay a full proof verification plus a two-leaf tree
insert:

```
Nethermind, deposit + withdraw:  2 × (37.2M + ~8.6M)    ≈  91.6M
CPP,        deposit + redeem:    0.36M + 0.13M + 28.2M  ≈  28.7M    ~3.2× cheaper
```

The deposit path is where the designs genuinely diverge. Our `deposit` is 361k
instructions and performs **no curve arithmetic at all** — it is storage writes
and a token transfer. Theirs cannot be, because a commitment has to enter the
Merkle tree and the tree has to be proved consistent.

## Why the verification gap is only 1.36×

Both designs bottom out in the same host primitive: a multi-pairing, which costs
N Miller loops plus exactly one final exponentiation. Cost tracks the Miller-loop
count.

| | pairs | per public input | hash |
|---|---|---|---|
| CPP | 2 — `e(S, −G₂) · e(Y, PK) == 1` | — | one `hash_to_g1` (2.6M) |
| Groth16 | 4 — `e(−A,B) · e(α,β) · e(vk_x,γ) · e(C,δ) == 1` | one `g1_mul` + one `g1_add` | — |

Two pairs against four, on a more expensive curve (BLS12-381 vs BN254), plus our
RFC 9380 hash-to-curve against their 11 scalar multiplications. Those largely
cancel; the pairing dominates both sides. **Anyone claiming an order of magnitude
from the pairing alone is wrong** — the separation lives on the deposit path and
off-chain, not in the verifier.

Three deliberate choices in `contracts/vault/src/crypto.rs` keep our side at two
pairs rather than more:

- `NEG_G2_GENERATOR` is a hardcoded constant, so `−G₂` costs nothing at runtime.
- One multi-pairing rather than two separate pairings — one final exponentiation
  instead of two.
- `PK` is subgroup-checked once in `is_valid_mint_pk` at construction, so
  `redeem` never re-runs a G2 subgroup check.

## Off-chain, where the gap is largest

Not metered by the budget, but it is what a user feels:

| | `cpp` | Nethermind |
|---|---|---|
| Client work per spend | one G1 scalar multiplication | Groth16 proving |
| Key material shipped to browser | none | proving key, MBs |
| Trusted setup | none | per-circuit ceremony |

## Methodology

Soroban's budget meter is a **deterministic cost model** — it has to be, since it
feeds consensus. These are abstract instruction counts, not wall-clock, so they
are byte-identical on any machine and reproduce exactly.

- Both sides measured with `env.cost_estimate().budget()`, calling
  `reset_unlimited()` immediately before each measured call.
- `cpp` at `soroban-sdk 27.0.5`; `stellar-private-payments` at `soroban-sdk 27`
  (`features = ["hazmat"]`). Same major version, same host semantics.
- Nethermind pinned at commit `ec78513f` (2026-08-05).
- Toolchain `rustc 1.95.0`.
- The 100M-instruction transaction budget used for the percentage column is the
  network cap; the Stellar Foundation's privacy-pool prototype write-up
  corroborates it ("40M ≈ 40% of the max instruction budget on testnet").

### Caveats, stated plainly

These all matter for reading the table honestly.

- **Their benchmarked proof is not their production circuit.** The test builds an
  11-public-input Groth16 proof with arkworks rather than compiling
  `policy_tx_2_2_AB`. This does **not** bias the result: Groth16 verification cost
  depends only on the public-input count, never on circuit size — and 11 is
  exactly what their deployed `_AB` policy uses (root, public_amount,
  ext_data_hash, 2 input nullifiers, 2 output commitments, + 2 membership + 2
  non-membership).
- **A placeholder verification key was needed to build.** Their `build.rs` requires
  a `verification_key.json` that is not in the repo. The measured path is
  `verify_with_vk`, which takes the test's own arkworks-generated key as an
  argument, so the placeholder never enters the measurement.
- **The depth-10 Merkle figure (~8.6M) is extrapolated from a measured depth-8
  run.** The extrapolation is exact rather than assumed:
  `insert_two_leaves` compresses `(leaf_1, leaf_2)` once and then loops
  `for lvl in 1..levels`, so it performs exactly `levels` Poseidon2 compressions.
  6,871,989 / 8 = **858,999 per compression**; × 10 = 8,589,986. Their deployed
  circuits are `PolicyTransactionBoth(2, 2, 1, 1, 10, 10)` — depth 10.
- **Their Poseidon2 is a host function, not slow Wasm.** It runs through
  `env.crypto_hazmat().poseidon2_permutation`. The Merkle cost is not an
  implementation deficiency to be optimised away.
- **The comparison is generous to Nethermind.** 37.2M is their verification alone,
  measured in-process. 28.2M is our *complete* `redeem`. In production their
  `transact` additionally pays cross-contract dispatch into the verifier,
  nullifier storage, and the token transfer.
- Both sides measured as direct in-process calls, so neither includes transaction
  overhead or footprint fees.

## What the extra cost buys them

Worth being fair about, because the cheaper system is also the less general one.
`stellar-private-payments` gets:

- **Arbitrary amounts** via the UTXO model. `cpp` is fixed-denomination by
  construction.
- **One anonymity set across all users and amounts.** Ours is per-vault, and a
  new denomination means a new vault with its own separate set.
- **In-circuit compliance.** The user *proves* ASP membership against a published
  root rather than asking a signer for permission. Their gate cannot stall one
  individual transaction at submission time; our mint can refuse to sign.

`cpp` trades those away for a design with no trusted setup, no circuit, no
proving key, a near-free deposit, and a spend that a relayer can pay for. Which
side of that trade is right depends on the application — the benchmark only
settles the cost question.

---

## Reproducing

### `cpp`

Append to `contracts/vault/src/test.rs`, then
`cargo test bench_probe -- --nocapture`:

```rust
#[test]
fn bench_probe() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    let mut b = s.env.cost_estimate().budget();

    b.reset_unlimited();
    s.vault
        .deposit(&depositor, &token.deposit_id, &token.blinded_b(&s.env));
    std::println!(
        "PROBE cpp_deposit cpu={} mem={}",
        b.cpu_instruction_cost(),
        b.memory_bytes_cost()
    );

    let s_prime = s.mint.blind_sign(&s.env, &token.blinded_b(&s.env));
    b.reset_unlimited();
    s.vault.announce(&token.deposit_id, &s_prime);
    std::println!(
        "PROBE cpp_announce cpu={} mem={}",
        b.cpu_instruction_cost(),
        b.memory_bytes_cost()
    );

    let unblinded_s = token.unblind(&s.env, &s_prime);
    let recipient = Address::generate(&s.env);
    let message = s.vault.redemption_message(&recipient);
    let sig = token.sign_redemption(&message);

    b.reset_unlimited();
    s.vault
        .redeem(&recipient, &token.nullifier, &sig, &unblinded_s);
    std::println!(
        "PROBE cpp_redeem_full cpu={} mem={}",
        b.cpu_instruction_cost(),
        b.memory_bytes_cost()
    );

    // Isolate the two crypto pieces inside redeem.
    s.env.as_contract(&s.vault.address, || {
        b.reset_unlimited();
        let ok = crypto::verify_blind_signature(&s.env, &unblinded_s, &token.nullifier, &s.mint.pk);
        std::println!(
            "PROBE cpp_bls_verify cpu={} mem={}",
            b.cpu_instruction_cost(),
            b.memory_bytes_cost()
        );
        assert!(ok);

        b.reset_unlimited();
        let _ = crypto::hash_nullifier_to_g1(&s.env, &token.nullifier);
        std::println!(
            "PROBE cpp_hash_to_g1 cpu={} mem={}",
            b.cpu_instruction_cost(),
            b.memory_bytes_cost()
        );
    });
}
```

### Nethermind

```bash
git clone https://github.com/NethermindEth/stellar-private-payments
cd stellar-private-payments && git checkout ec78513f
```

`contracts/circom-groth16-verifier/build.rs` requires `VERIFIER_VK_JSON` to point
at a snarkjs verification key. Any syntactically valid key unblocks the build —
`nPublic: 11`, `IC` of length 12, all points set to the BN254 generator is enough.
The measured call takes its key as an argument and never reads the embedded one.

Add `extern crate std;` at the top of each test file, then:

```rust
// contracts/circom-groth16-verifier/src/test.rs, in verifies_valid_proof()
env.cost_estimate().budget().reset_unlimited();
let result = CircomGroth16Verifier::verify_with_vk(&env, &vk, proof, public_inputs);
let b = env.cost_estimate().budget();
std::println!(
    "PROBE groth16_bn254_verify_11pub cpu={} mem={}",
    b.cpu_instruction_cost(),
    b.memory_bytes_cost()
);
```

```rust
// contracts/pool/src/test.rs, in merkle_insert_updates_root_and_index()
env.cost_estimate().budget().reset_unlimited();
let (idx_0, idx_1) = MerkleTreeWithHistory::insert_two_leaves(&env, leaf1, leaf2)
    .unwrap_or_else(|err| panic!("expected leaf insertion to succeed: {err:?}"));
let b = env.cost_estimate().budget();
std::println!(
    "PROBE merkle_insert_two_leaves_depth{} cpu={} mem={}",
    levels, b.cpu_instruction_cost(), b.memory_bytes_cost()
);
```

```bash
cargo test -p circom-groth16-verifier verifies_valid_proof -- --nocapture
cargo test -p pool merkle_insert_updates_root_and_index -- --nocapture
```
