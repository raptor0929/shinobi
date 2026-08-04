//! Storage layout and TTL policy.
//!
//! Nullifiers are the security-critical entries: if a spent nullifier were
//! ever forgotten, the corresponding token could be redeemed twice. They live
//! in persistent storage and are extended on every touch. Persistent entries
//! can be archived but never deleted — an archived nullifier must be restored
//! before the ledger will accept a transaction that reads it, and restoration
//! brings back the `spent` marker, so the double-spend guard survives
//! archival.

use soroban_sdk::{contracttype, Address, BytesN, Env};

use crate::types::{Config, DepositStatus};

pub const DAY_IN_LEDGERS: u32 = 17_280;

/// Extend when fewer than 30 days remain, out to 120 days.
pub const BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
pub const BUMP_AMOUNT: u32 = 120 * DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Instance: immutable vault configuration.
    Config,
    /// Persistent: `deposit_id -> DepositStatus`.
    Deposit(BytesN<32>),
    /// Persistent: `deposit_id -> depositor`, retained only while the deposit
    /// is `Pending`. Removed on announce so the vault stops carrying a link
    /// between a funder and a deposit slot once the slot is live.
    Depositor(BytesN<32>),
    /// Persistent: presence means the nullifier has been redeemed.
    Nullifier(BytesN<32>),
}

pub fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
}

pub fn set_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
}

pub fn get_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .expect("vault is not initialised")
}

pub fn deposit_status(env: &Env, deposit_id: &BytesN<32>) -> DepositStatus {
    env.storage()
        .persistent()
        .get(&DataKey::Deposit(deposit_id.clone()))
        .unwrap_or(DepositStatus::None)
}

pub fn set_deposit_status(env: &Env, deposit_id: &BytesN<32>, status: DepositStatus) {
    let key = DataKey::Deposit(deposit_id.clone());
    env.storage().persistent().set(&key, &status);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_AMOUNT);
}

pub fn set_depositor(env: &Env, deposit_id: &BytesN<32>, depositor: &Address) {
    let key = DataKey::Depositor(deposit_id.clone());
    env.storage().persistent().set(&key, depositor);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_AMOUNT);
}

pub fn get_depositor(env: &Env, deposit_id: &BytesN<32>) -> Option<Address> {
    env.storage()
        .persistent()
        .get(&DataKey::Depositor(deposit_id.clone()))
}

pub fn remove_depositor(env: &Env, deposit_id: &BytesN<32>) {
    env.storage()
        .persistent()
        .remove(&DataKey::Depositor(deposit_id.clone()));
}

pub fn is_spent(env: &Env, nullifier: &BytesN<32>) -> bool {
    let key = DataKey::Nullifier(nullifier.clone());
    if env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_AMOUNT);
        true
    } else {
        false
    }
}

pub fn mark_spent(env: &Env, nullifier: &BytesN<32>) {
    let key = DataKey::Nullifier(nullifier.clone());
    env.storage().persistent().set(&key, &true);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_AMOUNT);
}
