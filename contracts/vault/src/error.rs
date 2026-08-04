use soroban_sdk::contracterror;

/// Errors the vault raises itself.
///
/// Note that a bad Ed25519 spend signature does **not** appear here: the
/// `ed25519_verify` host function traps on failure rather than returning, so a
/// forged redemption aborts with a host crypto error before any contract-level
/// error can be produced. Simulation still reports it clearly.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Denomination must be strictly positive.
    InvalidDenomination = 1,
    /// The mint public key is not a valid point in the G2 prime-order subgroup.
    InvalidMintKey = 2,
    /// This deposit id has already been used. Deposit ids are derived from the
    /// wallet seed, so this normally means a replayed token index.
    DepositIdAlreadyUsed = 3,
    /// No pending deposit under this id.
    DepositNotFound = 4,
    /// The mint has already announced a signature for this deposit.
    AlreadyAnnounced = 5,
    /// Only the account that funded the deposit may reclaim it.
    NotDepositor = 6,
    /// The nullifier has already been redeemed (double-spend attempt).
    AlreadySpent = 7,
    /// The BLS pairing check failed — `S` is not a mint signature over
    /// `H(nullifier)`.
    InvalidBlindSignature = 8,
}
