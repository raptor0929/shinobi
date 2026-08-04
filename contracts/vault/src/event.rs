//! Contract events.
//!
//! These are the wallet's only recovery channel. A client that has lost its
//! local state re-derives each `deposit_id` from its seed and looks for the
//! matching `announce` event to recover `S'` — no server-side index and no
//! per-user account is involved. `deposit_id` and `nullifier` are topics so
//! that recovery is a targeted RPC query rather than a full log scan.

use soroban_sdk::{contractevent, Address, BytesN};

/// Deposit funded and awaiting the mint.
///
/// `blinded_b` is safe to publish: it is `r · H(nullifier)` for a secret `r`,
/// so it reveals nothing about the nullifier it will eventually redeem to.
#[contractevent(topics = ["deposit"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DepositLocked {
    #[topic]
    pub deposit_id: BytesN<32>,
    pub blinded_b: BytesN<96>,
}

/// The mint published the blind signature `S'`.
///
/// Also safe to publish: without `r`, `S'` cannot be unblinded into a usable
/// `S`, and it cannot be linked to the nullifier that will spend it.
#[contractevent(topics = ["announce"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MintFulfilled {
    #[topic]
    pub deposit_id: BytesN<32>,
    pub s_prime: BytesN<96>,
}

/// A token was spent. This is the first and only time the nullifier appears on
/// chain, and nothing in it links back to the deposit that funded it.
#[contractevent(topics = ["redeem"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Redeemed {
    #[topic]
    pub nullifier: BytesN<32>,
    pub recipient: Address,
}

/// A pending deposit was reclaimed by its depositor.
#[contractevent(topics = ["refund"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Refunded {
    #[topic]
    pub deposit_id: BytesN<32>,
    pub to: Address,
}
