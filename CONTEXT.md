# Shinobi Demo

Demo front-end for the **Compliant Privacy Pool** (Shinobi / cpp) on Stellar testnet — shows how simple a **Shielded Transfer** can feel when the vault uses Chaum blind signatures instead of ZK circuits.

## Language

**Compliant Privacy Pool**:
The Shinobi product: a Soroban vault that breaks the on-chain link between deposit and withdrawal while screening the depositor at the entrance.
_Avoid_: mixer (without “compliant”); ZK privacy pool (this design is not ZK)

**Shielded Transfer**:
User-facing name for the full deposit → mint announce → redeem flow that lands funds at an unrelated address with no on-chain link.
_Avoid_: private tx (ambiguous); anonymous payment (overclaims what compliance allows)

**Vault**:
The deployed Soroban contract that locks a fixed deposit amount, accepts mint announces, and pays redemptions / refunds.
_Avoid_: pool contract (ambiguous with AMM); mixer contract

**Mint**:
The compliance authority that screens depositors and blind-signs admission (`announce`) — or declines so the depositor can `refund`.
_Avoid_: issuer (ambiguous with asset issuer); operator alone when meaning the signing daemon

**Upstream Protocol**:
The `raptor0929/shinobi` repository (contracts + TypeScript CLI/mint/crypto). This demo **consumes** it; it does not fork or re-host the protocol.
_Avoid_: calling this repo “shinobi”; treating the FE as the source of truth for crypto

**Demo FE**:
This repository (`blessedux/shinobi-demo`) — a web UI for demonstrating **Shielded Transfers** against a deployed testnet **Vault**.
_Avoid_: shipping inside Sozu Wallet; forking Upstream Protocol as the FE home

## Relationships

- A **Shielded Transfer** uses one **Vault** deposit, one **Mint** announce (or refund), and one redeem to a recipient
- **Demo FE** talks to a deployed **Vault** and follows **Upstream Protocol** integration docs / TS client patterns
- **Mint** is a separate role from the demo user UI (may be operated off-app for the demo)

## Example dialogue

> **Dev:** “Should we fork shinobi and put the UI in that repo?”
> **Domain expert:** “No. **Upstream Protocol** stays theirs. **Demo FE** is `shinobi-demo` under blessedux — consume the vault.”
>
> **Dev:** “Is this the same as Sozu Wallet?”
> **Domain expert:** “No. Sozu Wallet is Digital Dollars / Passkeys. This is a **Compliant Privacy Pool** demo.”

## Flagged ambiguities

- Repo home: **Demo FE** = new `blessedux/shinobi-demo`, not a fork of shinobi, not inside sozu-wallet or sozu-explorer — resolved in ADR [`0001-fe-only-demo-repo`](./docs/adr/0001-fe-only-demo-repo.md).
- “Wallet FE” in early brief meant a demo wallet surface for Shielded Transfers, not the production Sozu Wallet product — still sharpening in grill.
