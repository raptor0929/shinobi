#![cfg(test)]
extern crate std;

use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    crypto::bls12_381::{Bls12381Fr, Bls12381G1Affine, Bls12381G2Affine},
    testutils::{Address as _, Events},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env, IntoVal, U256,
};

use crate::{crypto, storage, Config, DepositStatus, Vault, VaultClient};

const DENOMINATION: i128 = 10_000_000; // 1 XLM in stroops

// ---------------------------------------------------------------------------
// Test harness: an in-test mint and client that use the host's own BLS
// primitives, so the arithmetic under test is byte-for-byte the arithmetic the
// contract runs on chain.
// ---------------------------------------------------------------------------

struct Mint {
    sk: Bls12381Fr,
    pk: BytesN<192>,
}

impl Mint {
    fn new(env: &Env, seed: u64) -> Self {
        let sk = Bls12381Fr::from_u256(U256::from_u32(env, 0xC0FFEE).mul(&U256::from_u128(
            env,
            u128::from(seed) + 0x9E37_79B9_7F4A_7C15,
        )));
        let g2 = Bls12381G2Affine::from_bytes(BytesN::from_array(env, &crypto::G2_GENERATOR));
        let pk = (g2 * sk.clone()).to_bytes();
        Self { sk, pk }
    }

    /// `S' = sk · B` — the mint never learns what it signed.
    fn blind_sign(&self, env: &Env, blinded_b: &BytesN<96>) -> BytesN<96> {
        let b = Bls12381G1Affine::from_bytes(blinded_b.clone());
        env.crypto()
            .bls12_381()
            .g1_mul(&b, &self.sk)
            .to_bytes()
    }
}

/// One token's client-side secrets.
struct Token {
    spend: SigningKey,
    nullifier: BytesN<32>,
    deposit_id: BytesN<32>,
    r: Bls12381Fr,
}

impl Token {
    fn new(env: &Env, index: u8) -> Self {
        let spend = SigningKey::from_bytes(&[index.wrapping_add(1); 32]);
        let nullifier = BytesN::from_array(env, &spend.verifying_key().to_bytes());
        let deposit_id = BytesN::from_array(env, &[index.wrapping_add(100); 32]);
        // Any non-zero scalar works as a blinding factor.
        let r = Bls12381Fr::from_u256(U256::from_u128(
            env,
            0x5EED_0000_0000_0000 + u128::from(index) + 1,
        ));
        Self {
            spend,
            nullifier,
            deposit_id,
            r,
        }
    }

    /// `Y = hash_to_g1(nullifier)`, exactly as the contract derives it.
    fn y(&self, env: &Env) -> Bls12381G1Affine {
        crypto::hash_nullifier_to_g1(env, &self.nullifier)
    }

    /// `B = r · Y` — what the mint sees.
    fn blinded_b(&self, env: &Env) -> BytesN<96> {
        env.crypto()
            .bls12_381()
            .g1_mul(&self.y(env), &self.r)
            .to_bytes()
    }

    /// `S = S' · r⁻¹` — removes the blinding.
    fn unblind(&self, env: &Env, s_prime: &BytesN<96>) -> BytesN<96> {
        let sp = Bls12381G1Affine::from_bytes(s_prime.clone());
        env.crypto()
            .bls12_381()
            .g1_mul(&sp, &self.r.inv())
            .to_bytes()
    }

    fn sign_redemption(&self, message: &Bytes) -> BytesN<64> {
        let mut buf = std::vec![0u8; message.len() as usize];
        message.copy_into_slice(&mut buf);
        BytesN::from_array(message.env(), &self.spend.sign(&buf).to_bytes())
    }
}

struct Setup {
    env: Env,
    vault: VaultClient<'static>,
    token: TokenClient<'static>,
    token_admin: StellarAssetClient<'static>,
    mint_authority: Address,
    mint: Mint,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token = TokenClient::new(&env, &sac.address());
    let token_admin = StellarAssetClient::new(&env, &sac.address());

    let mint_authority = Address::generate(&env);
    let mint = Mint::new(&env, 1);

    let vault_id = env.register(
        Vault,
        (
            mint_authority.clone(),
            mint.pk.clone(),
            sac.address(),
            DENOMINATION,
        ),
    );

    let vault = VaultClient::new(&env, &vault_id);
    Setup {
        env,
        vault,
        token,
        token_admin,
        mint_authority,
        mint,
    }
}

impl Setup {
    fn funded_user(&self, amount: i128) -> Address {
        let user = Address::generate(&self.env);
        self.token_admin.mint(&user, &amount);
        user
    }

    /// Drives deposit -> announce -> unblind and returns the spendable `S`.
    fn mint_token(&self, token: &Token, depositor: &Address) -> BytesN<96> {
        self.vault.deposit(
            depositor,
            &token.deposit_id,
            &token.blinded_b(&self.env),
        );
        let s_prime = self.mint.blind_sign(&self.env, &token.blinded_b(&self.env));
        self.vault.announce(&token.deposit_id, &s_prime);
        token.unblind(&self.env, &s_prime)
    }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

#[test]
fn neg_g2_generator_constant_is_correct() {
    let env = Env::default();
    let g2 = Bls12381G2Affine::from_bytes(BytesN::from_array(&env, &crypto::G2_GENERATOR));
    let expected = BytesN::from_array(&env, &crypto::NEG_G2_GENERATOR);
    assert_eq!((-g2).to_bytes(), expected);
}

#[test]
fn g2_generator_is_in_subgroup() {
    let env = Env::default();
    let g2 = Bls12381G2Affine::from_bytes(BytesN::from_array(&env, &crypto::G2_GENERATOR));
    let bls = env.crypto().bls12_381();
    assert!(bls.g2_is_on_curve(&g2));
    assert!(bls.g2_is_in_subgroup(&g2));
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

#[test]
fn constructor_stores_config() {
    let s = setup();
    assert_eq!(
        s.vault.config(),
        Config {
            mint_authority: s.mint_authority.clone(),
            mint_pk: s.mint.pk.clone(),
            token: s.token.address.clone(),
            denomination: DENOMINATION,
        }
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn constructor_rejects_zero_denomination() {
    let env = Env::default();
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let mint = Mint::new(&env, 1);
    env.register(
        Vault,
        (Address::generate(&env), mint.pk, sac.address(), 0i128),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn constructor_rejects_off_curve_mint_key() {
    let env = Env::default();
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    // A G2 point that is on the curve but not in the prime-order subgroup would
    // be the subtle case; an all-0x11 blob is simply not on the curve at all.
    let bogus: BytesN<192> = BytesN::from_array(&env, &[0x11u8; 192]);
    env.register(
        Vault,
        (Address::generate(&env), bogus, sac.address(), DENOMINATION),
    );
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

#[test]
fn full_lifecycle_pays_recipient() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);

    let unblinded_s = s.mint_token(&token, &depositor);
    assert_eq!(s.token.balance(&depositor), 0);
    assert_eq!(s.token.balance(&s.vault.address), DENOMINATION);
    assert_eq!(
        s.vault.deposit_status(&token.deposit_id),
        DepositStatus::Announced
    );

    // The recipient is a fresh account with no connection to the depositor.
    let recipient = Address::generate(&s.env);
    let message = s.vault.redemption_message(&recipient);
    let sig = token.sign_redemption(&message);

    s.vault
        .redeem(&recipient, &token.nullifier, &sig, &unblinded_s);

    assert_eq!(s.token.balance(&recipient), DENOMINATION);
    assert_eq!(s.token.balance(&s.vault.address), 0);
    assert!(s.vault.is_spent(&token.nullifier));
}

#[test]
fn redeem_needs_no_contract_auth() {
    // The whole point of the design: the spend signature carries the right to
    // spend, so a third party can submit and pay the fee. `mock_all_auths` is
    // off here, proving `redeem` requires no Soroban authorisation at all.
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    let unblinded_s = s.mint_token(&token, &depositor);

    let recipient = Address::generate(&s.env);
    let message = s.vault.redemption_message(&recipient);
    let sig = token.sign_redemption(&message);

    s.env.set_auths(&[]);
    s.vault
        .redeem(&recipient, &token.nullifier, &sig, &unblinded_s);

    assert_eq!(s.token.balance(&recipient), DENOMINATION);
}

#[test]
fn multiple_tokens_share_one_vault() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION * 3);
    let recipient = Address::generate(&s.env);

    for i in 0..3u8 {
        let token = Token::new(&s.env, i);
        let unblinded_s = s.mint_token(&token, &depositor);
        let message = s.vault.redemption_message(&recipient);
        let sig = token.sign_redemption(&message);
        s.vault
            .redeem(&recipient, &token.nullifier, &sig, &unblinded_s);
    }

    assert_eq!(s.token.balance(&recipient), DENOMINATION * 3);
    assert_eq!(s.token.balance(&s.vault.address), 0);
}

// ---------------------------------------------------------------------------
// Deposit
// ---------------------------------------------------------------------------

#[test]
fn deposit_moves_exactly_one_denomination() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION * 5);
    let token = Token::new(&s.env, 0);

    s.vault.deposit(
        &depositor,
        &token.deposit_id,
        &token.blinded_b(&s.env),
    );

    assert_eq!(s.token.balance(&depositor), DENOMINATION * 4);
    assert_eq!(s.token.balance(&s.vault.address), DENOMINATION);
    assert_eq!(
        s.vault.deposit_status(&token.deposit_id),
        DepositStatus::Pending
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn deposit_id_cannot_be_reused() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION * 2);
    let token = Token::new(&s.env, 0);
    let b = token.blinded_b(&s.env);

    s.vault.deposit(&depositor, &token.deposit_id, &b);
    s.vault.deposit(&depositor, &token.deposit_id, &b);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn deposit_id_cannot_be_reused_after_announce() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION * 2);
    let token = Token::new(&s.env, 0);
    s.mint_token(&token, &depositor);

    s.vault.deposit(
        &depositor,
        &token.deposit_id,
        &token.blinded_b(&s.env),
    );
}

#[test]
fn deposit_requires_depositor_auth() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);

    s.env.set_auths(&[]);
    let result = s.vault.try_deposit(
        &depositor,
        &token.deposit_id,
        &token.blinded_b(&s.env),
    );
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// Announce
// ---------------------------------------------------------------------------

#[test]
fn announce_requires_mint_authority() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    let b = token.blinded_b(&s.env);
    s.vault.deposit(&depositor, &token.deposit_id, &b);
    let s_prime = s.mint.blind_sign(&s.env, &b);

    s.env.set_auths(&[]);
    assert!(s.vault.try_announce(&token.deposit_id, &s_prime).is_err());
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn announce_rejects_unknown_deposit() {
    let s = setup();
    let token = Token::new(&s.env, 0);
    let s_prime = s.mint.blind_sign(&s.env, &token.blinded_b(&s.env));
    s.vault.announce(&token.deposit_id, &s_prime);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn announce_is_not_repeatable() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    let b = token.blinded_b(&s.env);
    s.vault.deposit(&depositor, &token.deposit_id, &b);
    let s_prime = s.mint.blind_sign(&s.env, &b);

    s.vault.announce(&token.deposit_id, &s_prime);
    s.vault.announce(&token.deposit_id, &s_prime);
}

#[test]
fn announce_drops_the_depositor_link() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    let b = token.blinded_b(&s.env);
    s.vault.deposit(&depositor, &token.deposit_id, &b);

    let key = storage::DataKey::Depositor(token.deposit_id.clone());
    s.env.as_contract(&s.vault.address, || {
        assert!(s.env.storage().persistent().has(&key));
    });

    s.vault
        .announce(&token.deposit_id, &s.mint.blind_sign(&s.env, &b));

    s.env.as_contract(&s.vault.address, || {
        assert!(
            !s.env.storage().persistent().has(&key),
            "the vault must not keep a funder <-> deposit link once the slot is live"
        );
    });
}

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------

#[test]
fn refund_returns_an_unsigned_deposit() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    s.vault.deposit(
        &depositor,
        &token.deposit_id,
        &token.blinded_b(&s.env),
    );

    s.vault.refund(&token.deposit_id);

    assert_eq!(s.token.balance(&depositor), DENOMINATION);
    assert_eq!(s.token.balance(&s.vault.address), 0);
    assert_eq!(
        s.vault.deposit_status(&token.deposit_id),
        DepositStatus::Refunded
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn refund_is_not_repeatable() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    s.vault.deposit(
        &depositor,
        &token.deposit_id,
        &token.blinded_b(&s.env),
    );

    s.vault.refund(&token.deposit_id);
    s.vault.refund(&token.deposit_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn refund_is_impossible_after_announce() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    s.mint_token(&token, &depositor);

    s.vault.refund(&token.deposit_id);
}

#[test]
fn refund_requires_the_depositor() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    s.vault.deposit(
        &depositor,
        &token.deposit_id,
        &token.blinded_b(&s.env),
    );

    // With no auths mocked, an arbitrary submitter cannot satisfy the
    // depositor's `require_auth`.
    s.env.set_auths(&[]);
    assert!(s.vault.try_refund(&token.deposit_id).is_err());
    assert_eq!(s.token.balance(&s.vault.address), DENOMINATION);
}

// ---------------------------------------------------------------------------
// Redeem — negative paths
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn nullifier_cannot_be_spent_twice() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION * 2);
    let token = Token::new(&s.env, 0);
    let unblinded_s = s.mint_token(&token, &depositor);

    // Fund the vault a second time so the double spend fails on the nullifier
    // check rather than on an empty balance.
    let other = Token::new(&s.env, 9);
    s.mint_token(&other, &depositor);

    let recipient = Address::generate(&s.env);
    let message = s.vault.redemption_message(&recipient);
    let sig = token.sign_redemption(&message);

    s.vault
        .redeem(&recipient, &token.nullifier, &sig, &unblinded_s);
    s.vault
        .redeem(&recipient, &token.nullifier, &sig, &unblinded_s);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn forged_blind_signature_is_rejected() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    s.mint_token(&token, &depositor);

    // A signature from a different mint key: valid BLS, wrong signer.
    let rogue = Mint::new(&s.env, 42);
    let forged = token.unblind(
        &s.env,
        &rogue.blind_sign(&s.env, &token.blinded_b(&s.env)),
    );

    let recipient = Address::generate(&s.env);
    let message = s.vault.redemption_message(&recipient);
    let sig = token.sign_redemption(&message);

    s.vault.redeem(&recipient, &token.nullifier, &sig, &forged);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn still_blinded_signature_is_rejected() {
    // Forgetting to unblind must fail: S' = sk·r·Y only pairs correctly once
    // the r is divided out.
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    let b = token.blinded_b(&s.env);
    s.vault.deposit(&depositor, &token.deposit_id, &b);
    let s_prime = s.mint.blind_sign(&s.env, &b);
    s.vault.announce(&token.deposit_id, &s_prime);

    let recipient = Address::generate(&s.env);
    let message = s.vault.redemption_message(&recipient);
    let sig = token.sign_redemption(&message);

    s.vault.redeem(&recipient, &token.nullifier, &sig, &s_prime);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn signature_bound_to_another_nullifier_is_rejected() {
    // A valid mint signature over token A's nullifier cannot be used to spend
    // a redemption that claims nullifier B, because the contract recomputes
    // `Y = H(nullifier)` itself.
    let s = setup();
    let depositor = s.funded_user(DENOMINATION * 2);
    let token_a = Token::new(&s.env, 0);
    let token_b = Token::new(&s.env, 1);
    let s_a = s.mint_token(&token_a, &depositor);
    s.mint_token(&token_b, &depositor);

    let recipient = Address::generate(&s.env);
    let message = s.vault.redemption_message(&recipient);
    let sig_b = token_b.sign_redemption(&message);

    s.vault
        .redeem(&recipient, &token_b.nullifier, &sig_b, &s_a);
}

#[test]
#[should_panic]
fn spend_signature_for_another_recipient_is_rejected() {
    // The anti-front-running property: a watcher who copies a valid redemption
    // out of the mempool cannot swap in their own address, because the
    // recipient is inside the signed message.
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    let unblinded_s = s.mint_token(&token, &depositor);

    let intended = Address::generate(&s.env);
    let attacker = Address::generate(&s.env);
    let sig = token.sign_redemption(&s.vault.redemption_message(&intended));

    s.vault
        .redeem(&attacker, &token.nullifier, &sig, &unblinded_s);
}

#[test]
#[should_panic]
fn spend_signature_from_another_key_is_rejected() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    let unblinded_s = s.mint_token(&token, &depositor);

    let impostor = Token::new(&s.env, 7);
    let recipient = Address::generate(&s.env);
    let sig = impostor.sign_redemption(&s.vault.redemption_message(&recipient));

    // Signature is well formed but was not produced by `token.nullifier`.
    s.vault
        .redeem(&recipient, &token.nullifier, &sig, &unblinded_s);
}

#[test]
fn failed_redemption_does_not_burn_the_nullifier() {
    // A redemption that fails the pairing check must roll back completely,
    // including the `spent` marker — otherwise anyone could grief a token into
    // permanent unspendability by submitting garbage against its nullifier.
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    let unblinded_s = s.mint_token(&token, &depositor);

    let recipient = Address::generate(&s.env);
    let message = s.vault.redemption_message(&recipient);
    let sig = token.sign_redemption(&message);

    let garbage: BytesN<96> = BytesN::from_array(&s.env, &[0u8; 96]);
    assert!(s
        .vault
        .try_redeem(&recipient, &token.nullifier, &sig, &garbage)
        .is_err());
    assert!(!s.vault.is_spent(&token.nullifier));

    // The real signature still works.
    s.vault
        .redeem(&recipient, &token.nullifier, &sig, &unblinded_s);
    assert_eq!(s.token.balance(&recipient), DENOMINATION);
}

// ---------------------------------------------------------------------------
// Views and events
// ---------------------------------------------------------------------------

#[test]
fn redemption_message_binds_vault_and_recipient() {
    let s = setup();
    let a = Address::generate(&s.env);
    let b = Address::generate(&s.env);

    let msg_a = s.vault.redemption_message(&a);
    assert_ne!(msg_a, s.vault.redemption_message(&b));

    // Prefix is the versioned domain tag.
    let mut prefix = std::vec![0u8; crypto::REDEEM_DOMAIN.len()];
    msg_a
        .slice(0..crypto::REDEEM_DOMAIN.len() as u32)
        .copy_into_slice(&mut prefix);
    assert_eq!(prefix.as_slice(), crypto::REDEEM_DOMAIN);

    // A second vault with the same mint key produces a different message, so
    // signatures cannot be replayed across vaults.
    let other_id = s.env.register(
        Vault,
        (
            s.mint_authority.clone(),
            s.mint.pk.clone(),
            s.token.address.clone(),
            DENOMINATION,
        ),
    );
    let other = VaultClient::new(&s.env, &other_id);
    assert_ne!(msg_a, other.redemption_message(&a));
}

#[test]
fn dst_view_matches_the_contract_constant() {
    let s = setup();
    let dst = s.vault.hash_to_g1_dst();
    let mut buf = std::vec![0u8; dst.len() as usize];
    dst.copy_into_slice(&mut buf);
    assert_eq!(buf.as_slice(), crypto::HASH_TO_G1_DST);
}

#[test]
fn unspent_nullifier_reads_false() {
    let s = setup();
    let token = Token::new(&s.env, 0);
    assert!(!s.vault.is_spent(&token.nullifier));
    assert_eq!(
        s.vault.deposit_status(&token.deposit_id),
        DepositStatus::None
    );
}

/// Asserts that the vault's most recent invocation emitted exactly one event
/// with the given name, keyed topic and data payload.
///
/// `Env::events().all()` reports the events of the latest invocation only, so
/// each step has to be checked as it happens rather than at the end.
fn assert_only_event<T: IntoVal<Env, soroban_sdk::Val>>(
    s: &Setup,
    name: soroban_sdk::Symbol,
    key: &BytesN<32>,
    data: T,
) {
    let expected: soroban_sdk::Vec<(Address, soroban_sdk::Vec<soroban_sdk::Val>, soroban_sdk::Val)> = soroban_sdk::vec![
        &s.env,
        (
            s.vault.address.clone(),
            soroban_sdk::vec![&s.env, name.into_val(&s.env), key.to_val()],
            data.into_val(&s.env),
        ),
    ];
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.vault.address),
        expected
    );
}

#[test]
fn lifecycle_emits_the_events_a_wallet_needs_to_recover() {
    // Topic layout is part of the wire contract: wallets recover by filtering
    // on (event name, deposit_id), so a change here breaks every client.
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    let b = token.blinded_b(&s.env);
    let recipient = Address::generate(&s.env);

    s.vault.deposit(&depositor, &token.deposit_id, &b);
    assert_only_event(
        &s,
        soroban_sdk::symbol_short!("deposit"),
        &token.deposit_id,
        b.clone(),
    );

    let s_prime = s.mint.blind_sign(&s.env, &b);
    s.vault.announce(&token.deposit_id, &s_prime);
    assert_only_event(
        &s,
        soroban_sdk::symbol_short!("announce"),
        &token.deposit_id,
        s_prime.clone(),
    );

    let unblinded_s = token.unblind(&s.env, &s_prime);
    let sig = token.sign_redemption(&s.vault.redemption_message(&recipient));
    s.vault
        .redeem(&recipient, &token.nullifier, &sig, &unblinded_s);
    assert_only_event(
        &s,
        soroban_sdk::symbol_short!("redeem"),
        &token.nullifier,
        recipient,
    );
}

#[test]
fn refund_emits_its_own_event() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    s.vault
        .deposit(&depositor, &token.deposit_id, &token.blinded_b(&s.env));

    s.vault.refund(&token.deposit_id);
    assert_only_event(
        &s,
        soroban_sdk::symbol_short!("refund"),
        &token.deposit_id,
        depositor,
    );
}

// ---------------------------------------------------------------------------
// Unlinkability
// ---------------------------------------------------------------------------

#[test]
fn blinded_point_hides_the_nullifier() {
    // What the mint sees (`B`) must not equal what the chain later verifies
    // against (`Y`). If these matched, the mint could link deposit to spend by
    // simply recomputing the hash.
    let env = Env::default();
    let token = Token::new(&env, 0);
    assert_ne!(token.blinded_b(&env), token.y(&env).to_bytes());
}

#[test]
fn unblinding_recovers_a_signature_over_the_raw_nullifier() {
    // The algebraic identity the whole scheme rests on:
    //   S = S'·r⁻¹ = sk·(r·Y)·r⁻¹ = sk·Y
    // The mint produced `S'` while seeing only `B`, yet `S` verifies against
    // `Y = H(nullifier)`, which the mint never saw.
    let env = Env::default();
    let mint = Mint::new(&env, 1);
    let token = Token::new(&env, 0);

    let s_prime = mint.blind_sign(&env, &token.blinded_b(&env));
    let unblinded = token.unblind(&env, &s_prime);

    let direct = env
        .crypto()
        .bls12_381()
        .g1_mul(&token.y(&env), &mint.sk)
        .to_bytes();
    assert_eq!(unblinded, direct);
    assert!(crypto::verify_blind_signature(
        &env,
        &unblinded,
        &token.nullifier,
        &mint.pk
    ));
}

#[test]
fn different_blinding_factors_produce_different_deposits() {
    // Two wallets depositing for the same nullifier would still show the mint
    // unrelated points. (In practice each token has its own nullifier; this
    // isolates the blinding factor's contribution.)
    let env = Env::default();
    let mut a = Token::new(&env, 0);
    let b = Token::new(&env, 0);
    a.r = Bls12381Fr::from_u256(U256::from_u32(&env, 12345));
    assert_ne!(a.blinded_b(&env), b.blinded_b(&env));
}

// ---------------------------------------------------------------------------
// Guard against the vault paying out more than it holds
// ---------------------------------------------------------------------------

#[test]
fn redeem_fails_when_the_vault_is_empty() {
    let s = setup();
    let depositor = s.funded_user(DENOMINATION);
    let token = Token::new(&s.env, 0);
    let unblinded_s = s.mint_token(&token, &depositor);

    let first = Address::generate(&s.env);
    s.vault.redeem(
        &first,
        &token.nullifier,
        &token.sign_redemption(&s.vault.redemption_message(&first)),
        &unblinded_s,
    );

    // A second, independently valid token whose deposit never happened: the
    // mint signed it, but no funds back it. The token contract refuses.
    let orphan = Token::new(&s.env, 3);
    let orphan_s = orphan.unblind(
        &s.env,
        &s.mint.blind_sign(&s.env, &orphan.blinded_b(&s.env)),
    );
    let second = Address::generate(&s.env);
    assert!(s
        .vault
        .try_redeem(
            &second,
            &orphan.nullifier,
            &orphan.sign_redemption(&s.vault.redemption_message(&second)),
            &orphan_s,
        )
        .is_err());
}
