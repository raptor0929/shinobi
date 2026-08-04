use soroban_sdk::{contracttype, Address, BytesN};

/// Immutable vault configuration, fixed at deployment.
///
/// `denomination` is fixed for the lifetime of the vault: a variable-amount
/// pool would leak the link between a deposit and a redemption through the
/// amount itself. One vault, one denomination.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// Account authorised to announce blind signatures — the compliance mint.
    pub mint_authority: Address,
    /// The mint's BLS12-381 G2 public key, uncompressed (192 bytes).
    pub mint_pk: BytesN<192>,
    /// SEP-41 token contract (typically a Stellar Asset Contract) the vault
    /// denominates in.
    pub token: Address,
    /// The single denomination this vault accepts and pays out, in the token's
    /// smallest unit.
    pub denomination: i128,
}

/// Lifecycle of one deposit slot.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DepositStatus {
    /// Never seen.
    None = 0,
    /// Funded and awaiting a blind signature from the mint.
    Pending = 1,
    /// The mint published `S'`. Funds are now claimable only via `redeem`.
    Announced = 2,
    /// The depositor reclaimed the funds before the mint announced.
    Refunded = 3,
}
