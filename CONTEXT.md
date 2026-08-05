# Shinobi Demo

Front-end demo for **Shinobi** — Compliant Privacy Pool for institutional payroll — on Stellar testnet. Shows how simple a **Shielded Transfer** can feel when the vault uses Chaum blind signatures instead of ZK circuits.

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
_Avoid_: shipping inside Sozu Wallet; forking Upstream Protocol as the FE home; putting Sozu Capital on the product surface

**Shinobi Brand**:
The only product brand on the Demo FE. Hero name: **Shinobi**. Supporting line: **Compliant Privacy Pool for institutional payroll**.
_Avoid_: Sozu / Sozu Capital / Sozu Wallet branding in UI, metadata, or demo copy

**Payroll Framing**:
v1 uses institutional payroll only as landing/story copy. The interactive product is still one **Shielded Transfer** at a time (fixed vault denomination).
_Avoid_: HR CSV upload; multi-employee batch send in v1; implying the vault natively batches payroll

**SDP Batch** *(later)*:
Future gap-fill: use the Stellar Disbursement Platform (SDP) for real multi-recipient payroll batches. Explicit technical debt relative to the payroll story — not built in this demo.
_Avoid_: pretending v1 already does batch payroll; inventing a custom batch layer before SDP

**Upstream Client**:
The `@cpp/client` TypeScript package from **Upstream Protocol** (`raptor0929/shinobi` / `ts`), consumed via a Git-pinned dependency. Browser-safe crypto and redemption-message helpers come from here — not reimplemented in the Demo FE.
_Avoid_: hand-rolled blinding/pairing; unpinned copy-paste that can drift; treating Demo FE as crypto source of truth

**Demo Stack**:
Next.js App Router + TypeScript + Tailwind in this repo — UI and **Demo Sponsor** / **Demo Relayer** API routes together. No separate backend service in v1.
_Avoid_: Vite SPA + separate API for v1; a second deployable “mint/relayer” microservice unless forced later

**Testnet Demo**:
v1 targets Stellar testnet only. No mainnet deploy path in this demo.
_Avoid_: Dual Network chrome; mainnet vault wiring in v1

**Demo Fixtures**:
Known testnet identities for the scripted demo — Vault `CB72…QCFA`, depositor origin `GBAI6…ZSKY`, Mint authority `GA3XN…7CZL`, **Demo Recipient Preset** `GB4ZY…V2JP`. Env defaults + UI presets; vault `config()` still read at runtime for denomination / `mint_pk`.
_Avoid_: undocumented “whatever is in someone’s .env”; hardcoding denomination instead of reading `config()`

**Pending Announce**:
Depositor Flow state after deposit while waiting for **Off-App Mint** to `announce` (or for the user to `refund`). Open-ended — no fake countdown that implies SLA.
_Avoid_: spinner with no explanation; treating silence as failure immediately

**Activity Pulse**:
Simple motion on **Pending Announce** (and similar waits) that makes it obvious the Demo FE is alive and still working — not a stuck page.
_Avoid_: decorative motion with no state meaning; skeuomorphic “mining” theatrics

**Verbose Demo Log**:
On-screen, human-readable event stream of background steps (Freighter prompt, deposit submitted, polling ledgers, announce seen, unblind/verify, relayer submit, errors). Built for live narration and debugging, not production minimalism.
_Avoid_: hiding chain/RPC detail behind a single “Processing…” label in v1

**First-Class Refund**:
`refund` is an always-visible escape on **Pending Announce** (mint decline or “stuck waiting”) — not an error-only afterthought. Depositor signs via **Freighter Deposit**.
_Avoid_: refund only after a generic failure toast; framing refusal as a bug

**Timing Caution**:
Before redeem, the UI states that redeeming soon after deposit weakens unlinkability by timing. Demo may redeem immediately; there is no forced wait timer in v1.
_Avoid_: silent instant redeem with no warning; a mandatory delay that blocks a live talk

**Vercel Deploy**:
Host the **Demo Stack** on Vercel (testnet env secrets for Sponsor/Relayer). **Off-App Mint** stays a separate operator process, not on Vercel.
_Avoid_: localhost-only stage demos as the primary plan; shipping mint authority keys in the Vercel project

**Unlinkability Proof**:
Post-redeem mic-drop: three claims with Stellar Expert (testnet) deep links — (1) recipient history has no depositor, (2) redeem fee payer is the **Demo Relayer**, (3) nullifier spent / deposit finished. Echoed in the **Verbose Demo Log**.
_Avoid_: success toast only; building a custom explorer instead of Expert link-outs

**Depositor Flow**:
v1 Demo FE shape: one user path — backup seed → deposit → wait for Mint announce → redeem to a recipient address. No in-app Mint console; no second logged-in recipient wallet.
_Avoid_: three-panel Alice|Mint|Bob stage UI in v1; Mint dashboard as the primary surface

**Off-App Mint**:
The Mint daemon runs outside the Demo FE (upstream CLI / operator process). The FE only observes on-chain `announce` (or offers `refund` if declined).
_Avoid_: calling a Mint HTTP API; embedding mint keys in the browser

**Recipient Address**:
Where redeemed funds land — typed or pasted by the depositor (demo preset allowed). Not a second authenticated session in v1.
_Avoid_: “Bob logs in”; depositor-created recipient accounts (breaks unlinkability per upstream)

**Freighter Deposit**:
v1 signing for `deposit` / `refund`: the depositor connects Freighter (Stellar Wallets Kit may wrap it later). Redeem is never signed or submitted by Freighter.
_Avoid_: paste-secret-key into the browser; Freighter submit of `redeem`

**Sozu Smart Account Deposit** *(later)*:
Possible post-v1 upgrade: depositor `require_auth` via a Sozu Smart Account / Passkey instead of Freighter. Not in v1 scope.
_Avoid_: blocking the demo on Smart Account signing; mixing Sozu Wallet product auth into v1

**Demo Sponsor**:
Server route in this repo that creates (or funds creation of) recipient accounts under one shared sponsor key — so the depositor is never the account creator. Testnet demo only; secrets stay in env.
_Avoid_: depositor `create_account` for the recipient; accepting `deposit_id` on the sponsor request

**Demo Relayer**:
Server route in this repo that submits `redeem` under a funded fee account. Accepts `{ recipient, nullifier, spendSig, unblindedS }` only — never the seed or blinding factor. Testnet demo only.
_Avoid_: Freighter (or depositor) submitting `redeem`; logging IP↔nullifier harder than necessary

**Token Seed**:
Browser-only 32-byte secret from which deposit ids, nullifiers, and blinding factors derive. The Demo FE never transmits it.
_Avoid_: server-held seed; “backup optional” after deposit is available

**Backup Gate**:
UI rule: deposit stays disabled until the user explicitly confirms they saved the **Token Seed**. After deposit, a lost seed means locked funds.
_Avoid_: skip-for-demo shortcut that bricks a live deposit

**Local Seed Cache**:
Optional encrypted persistence of the **Token Seed** (passphrase → IndexedDB/`localStorage`) so a refresh does not wipe the demo. Cache only — not a custody service.
_Avoid_: plaintext seed in storage; calling the cache a “cloud backup”

**Seed Recovery**:
Rebuild spendable state from a pasted **Token Seed** by re-deriving indices and querying vault views (`deposit_status`, `is_spent`).
_Avoid_: recovery that requires operator help or server seed storage

**Demo Recipient Preset**:
Default scripted **Recipient Address** for the live demo (testnet `GB4Z…`). Paste/edit still allowed.
_Avoid_: requiring a new account for every successful demo run

**Sponsored Recipient**:
Optional path: **Demo Sponsor** creates a fresh account under the shared sponsor so the depositor is not the creator. Secondary to the preset for v1.
_Avoid_: depositor-funded `create_account`; making sponsor the only redeem path

## Relationships

- A **Shielded Transfer** uses one **Vault** deposit, one **Mint** announce (or refund), and one redeem to a **Recipient Address**
- **Demo FE** implements the **Depositor Flow** only; **Off-App Mint** is operator infrastructure
- **Demo FE** talks to a deployed **Vault** and follows **Upstream Protocol** integration docs / TS client patterns
- **Freighter Deposit** covers attributable steps; **Sozu Smart Account Deposit** is deferred
- **Demo Sponsor** and **Demo Relayer** are in-repo API routes; crypto that preserves privacy stays in the browser
- **Token Seed** is gated by **Backup Gate**, optionally kept in **Local Seed Cache**, and restorable via **Seed Recovery**
- Redeem targets a **Demo Recipient Preset** by default, or a **Sponsored Recipient** when showing virgin-account unlinkability
- **Payroll Framing** explains why institutions care; **SDP Batch** is the later path for multi-recipient disbursement
- **Upstream Client** supplies the crypto the **Vault** verifies; Demo FE adapters wrap Freighter, seed UX, Sponsor, and Relayer
- **Demo Stack** hosts the Depositor Flow UI and demo API routes in one Next.js app
- **Testnet Demo** uses **Demo Fixtures**; economics come from vault `config()`
- After deposit, **Pending Announce** uses **Activity Pulse** + **Verbose Demo Log** until announce or **First-Class Refund**
- Redeem is preceded by **Timing Caution**; no forced delay timer in v1
- **Vercel Deploy** hosts the Demo FE; mint remains off-app
- A finished Shielded Transfer ends on **Unlinkability Proof**, not a bare success toast

## Example dialogue

> **Dev:** “Should we fork shinobi and put the UI in that repo?”
> **Domain expert:** “No. **Upstream Protocol** stays theirs. **Demo FE** is `shinobi-demo` under blessedux — consume the vault.”
>
> **Dev:** “Is this the same as Sozu Wallet?”
> **Domain expert:** “No — and **Shinobi Brand** does not mention Sozu. This is Shinobi: **Compliant Privacy Pool for institutional payroll**.”
>
> **Dev:** “Put Sozu Capital in the footer?”
> **Domain expert:** “No. **Shinobi Brand** only.”

> **Dev:** “Do we build Alice, Mint, and Bob screens?”
> **Domain expert:** “v1 is **Depositor Flow** only. **Off-App Mint**. Recipient is a **Recipient Address**, not a login.”
>
> **Dev:** “Passkey Smart Account for deposit in v1?”
> **Domain expert:** “No. **Freighter Deposit** first. **Sozu Smart Account Deposit** only if time later.”
>
> **Dev:** “Redeem from Freighter?”
> **Domain expert:** “Never. **Demo Relayer** submits. **Demo Sponsor** creates unlinkable recipients when needed.”
>
> **Dev:** “Can we skip seed backup to speed the demo?”
> **Domain expert:** “No. **Backup Gate** before deposit. **Token Seed** never leaves the browser.”
>
> **Dev:** “Must every redeem use the sponsor?”
> **Domain expert:** “No. **Demo Recipient Preset** is the default; **Sponsored Recipient** is optional.”
>
> **Dev:** “Does v1 upload a payroll CSV?”
> **Domain expert:** “No. **Payroll Framing** only. Batch is **SDP Batch** later.”
>
> **Dev:** “We’ll rewrite the blind-signature math in the FE, right?”
> **Domain expert:** “No. Pin **Upstream Client** (`@cpp/client`). Do not reimplement.”
>
> **Dev:** “Separate relayer microservice?”
> **Domain expert:** “Not in v1. **Demo Stack** — Next.js app with API routes.”
>
> **Dev:** “Mainnet toggle?”
> **Domain expert:** “No. **Testnet Demo** with **Demo Fixtures**.”
>
> **Dev:** “Embed the mint daemon in Next.js?”
> **Domain expert:** “No. Operator runs **Off-App Mint**. FE shows **Pending Announce** with **Activity Pulse** and a **Verbose Demo Log**.”
>
> **Dev:** “Hide refund until the mint errors?”
> **Domain expert:** “No. **First-Class Refund**. And show **Timing Caution** before redeem — no forced timer.”
>
> **Dev:** “Demo only on localhost?”
> **Domain expert:** “No. **Vercel Deploy** for the FE; operator still runs **Off-App Mint** locally.”
>
> **Dev:** “Green checkmark after redeem — done?”
> **Domain expert:** “No. **Unlinkability Proof** — three claims + Expert links. That’s the pitch.”

## Flagged ambiguities

- Brand: **Shinobi Brand** only — no Sozu on the product surface — resolved.
- Repo home: **Demo FE** = new `blessedux/shinobi-demo`, not a fork of shinobi, not inside sozu-wallet or sozu-explorer — resolved in ADR [`0001-fe-only-demo-repo`](./docs/adr/0001-fe-only-demo-repo.md).
- Actor coverage: **Depositor Flow** + **Off-App Mint** + **Recipient Address** — resolved.
- Deposit signing: **Freighter Deposit** for v1; **Sozu Smart Account Deposit** deferred — resolved.
- Operator HTTP: in-repo **Demo Sponsor** + **Demo Relayer** — resolved in ADR [`0002-demo-sponsor-relayer`](./docs/adr/0002-demo-sponsor-relayer.md).
- Seed: **Token Seed** + **Backup Gate** + **Local Seed Cache** + **Seed Recovery** — resolved.
- Recipient: **Demo Recipient Preset** primary, **Sponsored Recipient** optional — resolved.
- Payroll: **Payroll Framing** in v1; **SDP Batch** deferred debt — resolved.
- Crypto: Git-pinned **Upstream Client** (`@cpp/client`) — resolved in ADR [`0003-upstream-client-pin`](./docs/adr/0003-upstream-client-pin.md).
- Stack: **Demo Stack** = Next.js App Router + TS + Tailwind — resolved.
- Network: **Testnet Demo** + **Demo Fixtures** (vault / origin / mint / destination) — resolved.
- Mint wait UX: operator **Off-App Mint**; FE **Pending Announce** + **Activity Pulse** + **Verbose Demo Log** — resolved.
- Refund / redeem honesty: **First-Class Refund** + **Timing Caution** (no forced delay) — resolved.
- Hosting: **Vercel Deploy** for Demo FE; mint off-app — resolved.
- Done state: **Unlinkability Proof** (mic-drop + Expert links) — resolved.
- Tracking: Exponential product **Shinobi Compliant Privacy Pool** (`shinobi-compliant-privacy-pool`) in Sozu Capital workspace; Feature “Shinobi Demo FE — Shielded Transfer pitch” labeled `ready-for-agent`.
