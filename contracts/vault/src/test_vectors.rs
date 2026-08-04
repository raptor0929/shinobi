#![cfg(test)]
//! Cross-language parity: the Soroban host replays crypto produced by the
//! TypeScript client.
//!
//! Nothing in `vectors.rs` was computed by Rust. Every point, scalar, and
//! signature came out of `@noble/curves` in `ts/src/vectors.ts`. These tests
//! feed them to the same host functions a testnet ledger runs, so a divergence
//! in domain separation, scalar reduction, point encoding, or XDR layout shows
//! up here rather than as an unspendable token on chain.
//!
//! Regenerate with `npm run vectors -- --rust --out ../contracts/vault/src/vectors.rs`.

extern crate std;

use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env, String,
};

use crate::{crypto, vectors, DepositStatus, Vault, VaultClient};

const DENOMINATION: i128 = 10_000_000;

fn addr(env: &Env, strkey: &str) -> Address {
    Address::from_string(&String::from_str(env, strkey))
}

/// Deploys the vault **at the exact contract id the vectors were generated
/// for**. The redemption message commits to the vault address, so a vector
/// signature only verifies against this one id.
fn setup(env: &Env) -> (VaultClient<'static>, TokenClient<'static>, StellarAssetClient<'static>) {
    let mint_authority = Address::generate(env);
    let issuer = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token_id = sac.address();

    let vault_id = addr(env, vectors::VAULT_ID);
    env.register_at(
        &vault_id,
        Vault,
        (
            mint_authority,
            BytesN::from_array(env, &vectors::MINT_PK),
            token_id.clone(),
            DENOMINATION,
        ),
    );

    (
        VaultClient::new(env, &vault_id),
        TokenClient::new(env, &token_id),
        StellarAssetClient::new(env, &token_id),
    )
}

// ---------------------------------------------------------------------------
// Primitive parity
// ---------------------------------------------------------------------------

/// The single most load-bearing agreement in the system: both sides must map a
/// nullifier to the same curve point. They use different libraries, different
/// languages, and different SSWU implementations — only the RFC 9380 suite and
/// the DST string are shared.
#[test]
fn hash_to_g1_matches_the_typescript_client() {
    let env = Env::default();
    for vector in vectors::TOKENS.iter() {
        let nullifier = BytesN::from_array(&env, &vector.nullifier);
        let y = crypto::hash_nullifier_to_g1(&env, &nullifier).to_bytes();
        assert_eq!(
            y,
            BytesN::from_array(&env, &vector.y),
            "hash_to_g1 diverged at index {}",
            vector.index
        );
    }
}

/// The DST the contract advertises is the one the client actually used.
#[test]
fn dst_matches_the_typescript_client() {
    let env = Env::default();
    let (vault, _, _) = setup(&env);
    assert_eq!(
        vault.hash_to_g1_dst(),
        Bytes::from_slice(&env, crypto::HASH_TO_G1_DST)
    );
}

/// Signatures blinded, signed, and unblinded entirely in TypeScript verify
/// under the host's `pairing_check`.
#[test]
fn unblinded_typescript_signatures_verify_on_the_host() {
    let env = Env::default();
    let pk = BytesN::from_array(&env, &vectors::MINT_PK);

    for vector in vectors::TOKENS.iter() {
        let nullifier = BytesN::from_array(&env, &vector.nullifier);
        let s = BytesN::from_array(&env, &vector.s);
        assert!(
            crypto::verify_blind_signature(&env, &s, &nullifier, &pk),
            "index {} did not verify",
            vector.index
        );
    }
}

/// `S'` is what the mint published; it is not spendable. If this ever passed,
/// the blinding factor would be doing no work and anyone watching `announce`
/// could redeem the token.
#[test]
fn still_blinded_typescript_signatures_do_not_verify() {
    let env = Env::default();
    let pk = BytesN::from_array(&env, &vectors::MINT_PK);

    for vector in vectors::TOKENS.iter() {
        let nullifier = BytesN::from_array(&env, &vector.nullifier);
        let s_prime = BytesN::from_array(&env, &vector.s_prime);
        assert!(
            !crypto::verify_blind_signature(&env, &s_prime, &nullifier, &pk),
            "index {} verified while still blinded",
            vector.index
        );
    }
}

/// `B` must be a legitimate G1 point in the prime-order subgroup — the client
/// produced it by scalar multiplication, so it should be, but a mismatch in
/// encoding would show up as a subgroup failure rather than a wrong answer.
#[test]
fn blinded_points_are_valid_subgroup_elements() {
    let env = Env::default();
    let bls = env.crypto().bls12_381();

    for vector in vectors::TOKENS.iter() {
        let b = soroban_sdk::crypto::bls12_381::Bls12381G1Affine::from_bytes(BytesN::from_array(
            &env,
            &vector.blinded_b,
        ));
        assert!(bls.g1_is_on_curve(&b), "index {} is off-curve", vector.index);
        assert!(
            bls.g1_is_in_subgroup(&b),
            "index {} is outside G1",
            vector.index
        );
    }
}

/// The client's mint public key is a well-formed G2 element — the constructor
/// rejects anything else, so this is what makes the vectors deployable.
#[test]
fn typescript_mint_key_is_a_valid_g2_point() {
    let env = Env::default();
    assert!(crypto::is_valid_mint_pk(
        &env,
        &BytesN::from_array(&env, &vectors::MINT_PK)
    ));
}

// ---------------------------------------------------------------------------
// Message construction parity
// ---------------------------------------------------------------------------

/// `buildRedemptionMessage` in TypeScript reproduces `redemption_message` in
/// Rust, including Soroban's XDR encoding of the recipient.
///
/// This is the one place the client cannot afford to guess: a message that is
/// even one byte different produces a signature `ed25519_verify` rejects, and
/// the redemption traps. Both address kinds are covered because Soroban encodes
/// `ScAddress::Account` and `ScAddress::Contract` differently — a client that
/// handled only one would silently fail on the other.
#[test]
fn redemption_message_matches_the_typescript_client() {
    let env = Env::default();
    let (vault, _, _) = setup(&env);

    assert_eq!(
        vault.redemption_message(&addr(&env, vectors::ACCOUNT_RECIPIENT)),
        Bytes::from_slice(&env, vectors::MESSAGE_ACCOUNT),
        "account-address message diverged"
    );
    assert_eq!(
        vault.redemption_message(&addr(&env, vectors::CONTRACT_RECIPIENT)),
        Bytes::from_slice(&env, vectors::MESSAGE_CONTRACT),
        "contract-address message diverged"
    );
}

/// The Ed25519 signatures the client produced verify against the nullifier as
/// a public key, over the message the contract builds.
#[test]
fn typescript_spend_signatures_verify_on_the_host() {
    let env = Env::default();
    let (vault, _, _) = setup(&env);

    let account_msg = vault.redemption_message(&addr(&env, vectors::ACCOUNT_RECIPIENT));
    let contract_msg = vault.redemption_message(&addr(&env, vectors::CONTRACT_RECIPIENT));

    for vector in vectors::TOKENS.iter() {
        // `ed25519_verify` traps rather than returning false, so reaching the
        // next line is the assertion.
        env.crypto().ed25519_verify(
            &BytesN::from_array(&env, &vector.nullifier),
            &account_msg,
            &BytesN::from_array(&env, &vector.spend_sig_account),
        );
        env.crypto().ed25519_verify(
            &BytesN::from_array(&env, &vector.nullifier),
            &contract_msg,
            &BytesN::from_array(&env, &vector.spend_sig_contract),
        );
    }
}

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

/// The whole protocol, with Rust contributing nothing but verification.
///
/// The blinded point, the blind signature, the unblinding, and the spend
/// authorisation were all computed by the TypeScript client. The contract
/// accepts them and pays out. This is the test that says the CLI will work
/// against a deployed vault.
///
/// Pays the contract recipient because a Stellar Asset Contract will not credit
/// a classic account without a trustline, and the vectors' account recipient is
/// a bare strkey with no ledger entry behind it. That constraint is about the
/// SAC, not about CPP — `redemption_message_matches_the_typescript_client`
/// already pins the account-address encoding.
#[test]
fn typescript_tokens_redeem_against_the_contract() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault, token, token_admin) = setup(&env);
    let depositor = Address::generate(&env);
    let recipient = addr(&env, vectors::CONTRACT_RECIPIENT);

    let count = vectors::TOKENS.len() as i128;
    token_admin.mint(&depositor, &(DENOMINATION * count));

    for vector in vectors::TOKENS.iter() {
        let deposit_id = BytesN::from_array(&env, &vector.deposit_id);
        vault.deposit(
            &depositor,
            &deposit_id,
            &BytesN::from_array(&env, &vector.blinded_b),
        );
        assert_eq!(vault.deposit_status(&deposit_id), DepositStatus::Pending);

        vault.announce(&deposit_id, &BytesN::from_array(&env, &vector.s_prime));
        assert_eq!(vault.deposit_status(&deposit_id), DepositStatus::Announced);
    }

    assert_eq!(token.balance(&depositor), 0);
    assert_eq!(token.balance(&vault.address), DENOMINATION * count);

    for vector in vectors::TOKENS.iter() {
        let nullifier = BytesN::from_array(&env, &vector.nullifier);
        assert!(!vault.is_spent(&nullifier));

        vault.redeem(
            &recipient,
            &nullifier,
            &BytesN::from_array(&env, &vector.spend_sig_contract),
            &BytesN::from_array(&env, &vector.s),
        );

        assert!(vault.is_spent(&nullifier));
    }

    assert_eq!(token.balance(&recipient), DENOMINATION * count);
    assert_eq!(token.balance(&vault.address), 0);
}

/// A signature authorising payment to the account recipient must not redirect
/// funds to the contract recipient.
///
/// This is the anti-front-running property, proven against signatures the
/// TypeScript client produced: a watcher who sees a redemption in flight cannot
/// lift the signature and repoint it at an address of their own.
#[test]
#[should_panic]
fn typescript_signature_for_one_recipient_cannot_pay_another() {
    let env = Env::default();
    env.mock_all_auths();

    let (vault, _, token_admin) = setup(&env);
    let depositor = Address::generate(&env);
    let vector = &vectors::TOKENS[0];

    token_admin.mint(&depositor, &DENOMINATION);
    let deposit_id = BytesN::from_array(&env, &vector.deposit_id);
    vault.deposit(
        &depositor,
        &deposit_id,
        &BytesN::from_array(&env, &vector.blinded_b),
    );
    vault.announce(&deposit_id, &BytesN::from_array(&env, &vector.s_prime));

    vault.redeem(
        &addr(&env, vectors::CONTRACT_RECIPIENT),
        &BytesN::from_array(&env, &vector.nullifier),
        // Signed for the *account* recipient.
        &BytesN::from_array(&env, &vector.spend_sig_account),
        &BytesN::from_array(&env, &vector.s),
    );
}

/// A TypeScript-produced token is bound to its own nullifier. Swapping the
/// signature from one vector onto another's nullifier must fail, or the mint's
/// signature would be a bearer token for the whole pool.
#[test]
fn typescript_signatures_are_not_interchangeable() {
    let env = Env::default();
    let pk = BytesN::from_array(&env, &vectors::MINT_PK);

    let first = &vectors::TOKENS[0];
    let second = &vectors::TOKENS[1];

    assert!(!crypto::verify_blind_signature(
        &env,
        &BytesN::from_array(&env, &first.s),
        &BytesN::from_array(&env, &second.nullifier),
        &pk,
    ));
}
