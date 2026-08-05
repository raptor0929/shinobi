#![no_std]
//! # Compliant Privacy Pool — Vault
//!
//! Fixed-denomination eCash for Stellar, built on BLS12-381 blind signatures
//! instead of zero-knowledge proofs.
//!
//! ## Flow
//!
//! ```text
//!   Client                        Vault (on chain)                Mint
//!     |                                 |                           |
//!     |  spend_sk, spend_pk  (Ed25519)  |                           |
//!     |  nullifier = spend_pk           |                           |
//!     |  Y = hash_to_g1(nullifier)      |                           |
//!     |  B = r * Y                      |                           |
//!     |                                 |                           |
//!     |-- deposit(id, B) + N tokens --->|                           |
//!     |                                 |--- deposit event -------->|
//!     |                                 |                  screen depositor
//!     |                                 |                  S' = sk * B
//!     |                                 |<-- announce(id, S') ------|
//!     |                                 |                           |
//!     |  S = S' * r^-1   (unblind)      |                           |
//!     |                                 |                           |
//!     |-- redeem(dst, nullifier, ------->|  ed25519_verify           |
//!     |          sig, S)                 |  nullifier not spent      |
//!     |                                 |  pairing check            |
//!     |                                 |--- N tokens ------------> dst
//! ```
//!
//! The mint signs `B` without ever seeing `Y`, so it cannot link the deposit it
//! signed to the redemption it later settles. Compliance is enforced at ingress
//! — the mint screens the *depositor*, whose identity is public on chain anyway
//! — while the *recipient* stays unlinkable. See `SEP-DRAFT.md`.
//!
//! ## What the vault trusts
//!
//! - The mint **cannot forge** tokens: every redemption is checked against the
//!   mint's G2 key by an on-chain pairing.
//! - The mint **cannot steal** funds: redemption pays the recipient named in
//!   the client's Ed25519 signature, and the vault never pays anyone else.
//! - The mint **can refuse** to sign. That is the compliance gate, and it is
//!   also the liveness assumption. `refund` bounds the damage: an unfulfilled
//!   deposit is always reclaimable by its depositor.

mod crypto;
mod error;
mod event;
mod storage;
mod types;

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_vectors;
#[cfg(test)]
mod vectors;

use soroban_sdk::{
    contract, contractimpl, panic_with_error, token, xdr::ToXdr, Address, Bytes, BytesN, Env,
};

pub use error::Error;
pub use types::{Config, DepositStatus};

#[contract]
pub struct Vault;

#[contractimpl]
impl Vault {
    /// Deploys an immutable vault.
    ///
    /// Nothing here can be changed afterwards — there is no admin and no
    /// upgrade path. Rotating the mint key or changing the denomination means
    /// deploying a new vault, which is the honest behaviour: mutating the mint
    /// key in place would invalidate every outstanding token, and mutating the
    /// denomination would split the anonymity set.
    pub fn __constructor(
        env: Env,
        mint_authority: Address,
        mint_pk: BytesN<192>,
        token: Address,
        denomination: i128,
    ) {
        if denomination <= 0 {
            panic_with_error!(&env, Error::InvalidDenomination);
        }
        if !crypto::is_valid_mint_pk(&env, &mint_pk) {
            panic_with_error!(&env, Error::InvalidMintKey);
        }

        storage::set_config(
            &env,
            &Config {
                mint_authority,
                mint_pk,
                token,
                denomination,
            },
        );
        storage::extend_instance(&env);
    }

    /// Locks exactly one denomination and registers a blind-signing request.
    ///
    /// `deposit_id` is derived from the client's seed and is unlinkable to the
    /// nullifier that will eventually spend this token. `blinded_b` is
    /// `r · H(nullifier)`; the vault does not validate it, because a malformed
    /// `B` only wastes the depositor's own funds — the mint rejects off-curve
    /// points before signing, and the depositor can always `refund`.
    pub fn deposit(env: Env, depositor: Address, deposit_id: BytesN<32>, blinded_b: BytesN<96>) {
        depositor.require_auth();

        if storage::deposit_status(&env, &deposit_id) != DepositStatus::None {
            panic_with_error!(&env, Error::DepositIdAlreadyUsed);
        }

        let config = storage::get_config(&env);
        token::Client::new(&env, &config.token).transfer(
            &depositor,
            &env.current_contract_address(),
            &config.denomination,
        );

        storage::set_deposit_status(&env, &deposit_id, DepositStatus::Pending);
        storage::set_depositor(&env, &deposit_id, &depositor);
        storage::extend_instance(&env);

        event::DepositLocked {
            deposit_id,
            blinded_b,
        }
        .publish(&env);
    }

    /// Publishes the mint's blind signature `S'` for a pending deposit.
    ///
    /// Restricted to the mint authority. An open `announce` would let anyone
    /// spray junk signatures at deposit ids and force every wallet to sift
    /// through them during recovery.
    pub fn announce(env: Env, deposit_id: BytesN<32>, s_prime: BytesN<96>) {
        let config = storage::get_config(&env);
        config.mint_authority.require_auth();

        match storage::deposit_status(&env, &deposit_id) {
            DepositStatus::Pending => {}
            DepositStatus::Announced => panic_with_error!(&env, Error::AlreadyAnnounced),
            _ => panic_with_error!(&env, Error::DepositNotFound),
        }

        storage::set_deposit_status(&env, &deposit_id, DepositStatus::Announced);
        // Drop the funder <-> deposit link now that the slot is live. Refund is
        // impossible after announce, so the address is no longer needed.
        storage::remove_depositor(&env, &deposit_id);
        storage::extend_instance(&env);

        event::MintFulfilled {
            deposit_id,
            s_prime,
        }
        .publish(&env);
    }

    /// Reclaims a deposit the mint never signed.
    ///
    /// This is what keeps the compliance gate from becoming a fund trap: if the
    /// mint declines to sign, or simply goes away, the depositor gets their
    /// money back. Only the original depositor can call it.
    pub fn refund(env: Env, deposit_id: BytesN<32>) {
        if storage::deposit_status(&env, &deposit_id) != DepositStatus::Pending {
            panic_with_error!(&env, Error::DepositNotFound);
        }

        let depositor = match storage::get_depositor(&env, &deposit_id) {
            Some(d) => d,
            None => panic_with_error!(&env, Error::DepositNotFound),
        };
        depositor.require_auth();

        // Status flips before the transfer so a re-entrant token contract
        // cannot drain the vault one denomination at a time.
        storage::set_deposit_status(&env, &deposit_id, DepositStatus::Refunded);
        storage::remove_depositor(&env, &deposit_id);

        let config = storage::get_config(&env);
        token::Client::new(&env, &config.token).transfer(
            &env.current_contract_address(),
            &depositor,
            &config.denomination,
        );
        storage::extend_instance(&env);

        event::Refunded {
            deposit_id,
            to: depositor,
        }
        .publish(&env);
    }

    /// Spends a token, paying one denomination to `recipient`.
    ///
    /// Deliberately takes **no** `require_auth`. The right to spend is carried
    /// entirely by `spend_sig`, so any third party can submit the transaction
    /// and pay the fee on the holder's behalf. That is what lets a recipient be
    /// paid without ever holding a funded Stellar account, and it means the
    /// submitting account is not evidence of who owns the token.
    ///
    /// Three checks gate the payout:
    /// 1. `spend_sig` is a valid Ed25519 signature by `nullifier` over a
    ///    message naming this vault and this recipient. Binding the recipient
    ///    into the signed message is what stops a watcher from lifting the
    ///    redemption out of the mempool and redirecting it.
    /// 2. `nullifier` has not been spent before.
    /// 3. `S` pairs against the mint key over `H(nullifier)`.
    pub fn redeem(
        env: Env,
        recipient: Address,
        nullifier: BytesN<32>,
        spend_sig: BytesN<64>,
        unblinded_s: BytesN<96>,
    ) {
        let message = Self::redemption_message(env.clone(), recipient.clone());
        // Traps on a bad signature; see `Error` docs.
        env.crypto().ed25519_verify(&nullifier, &message, &spend_sig);

        if storage::is_spent(&env, &nullifier) {
            panic_with_error!(&env, Error::AlreadySpent);
        }
        // Burn the nullifier before paying out.
        storage::mark_spent(&env, &nullifier);

        let config = storage::get_config(&env);
        if !crypto::verify_blind_signature(&env, &unblinded_s, &nullifier, &config.mint_pk) {
            panic_with_error!(&env, Error::InvalidBlindSignature);
        }

        token::Client::new(&env, &config.token).transfer(
            &env.current_contract_address(),
            &recipient,
            &config.denomination,
        );
        storage::extend_instance(&env);

        event::Redeemed {
            nullifier,
            recipient,
        }
        .publish(&env);
    }

    // -- Views ---------------------------------------------------------------

    /// The exact byte string a spend key must sign to authorise a payout to
    /// `recipient`.
    ///
    /// `REDEEM_DOMAIN || xdr(vault_address) || xdr(recipient)`. The vault
    /// address is included so a signature harvested from one vault cannot be
    /// replayed against another vault sharing the same mint key.
    ///
    /// Exposed as a view so off-chain clients can check their construction
    /// against the contract's rather than trusting a reimplementation.
    pub fn redemption_message(env: Env, recipient: Address) -> Bytes {
        let mut message = Bytes::from_slice(&env, crypto::REDEEM_DOMAIN);
        message.append(&env.current_contract_address().to_xdr(&env));
        message.append(&recipient.to_xdr(&env));
        message
    }

    pub fn config(env: Env) -> Config {
        storage::get_config(&env)
    }

    pub fn is_spent(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&storage::DataKey::Nullifier(nullifier))
    }

    pub fn deposit_status(env: Env, deposit_id: BytesN<32>) -> DepositStatus {
        storage::deposit_status(&env, &deposit_id)
    }

    /// The RFC 9380 domain separation tag clients must use for `hash_to_g1`.
    pub fn hash_to_g1_dst(env: Env) -> Bytes {
        Bytes::from_slice(&env, crypto::HASH_TO_G1_DST)
    }
}
