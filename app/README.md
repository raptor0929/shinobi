# shinobi-demo

Demo front-end for **Shinobi** — Compliant Privacy Pool for institutional payroll — on Stellar testnet.

Shows a simple **Shielded Transfer**: deposit → Off-App Mint announce → redeem via Demo Relayer → **Unlinkability Proof**.

## Quick start

```bash
npm install
cp .env.example .env.local
# fill SPONSOR_SECRET + RELAYER_SECRET (or: node scripts/bootstrap-operator-keys.mjs)
# fill MINT_AUTHORITY_SECRET + MINT_SEED matching the deployed vault (demo compliance tick)
npm run dev
```

Open http://localhost:3000 — Freighter on testnet.

**Payroll Path:** Save recovery key → Connect & deposit → **Run compliance** → Pay employee → Show proof.

No long-lived `npm run mint` required when mint env is set: **Run compliance** calls `POST /api/mint/tick` once.

## Deploy (Vercel / testnet)

Set the same secrets server-side: `SPONSOR_SECRET`, `RELAYER_SECRET`, `MINT_AUTHORITY_SECRET`, `MINT_SEED`, plus the `NEXT_PUBLIC_*` fixtures from `.env.example`. Do not put mint/relayer/sponsor secrets in `NEXT_PUBLIC_*`.

## Upstream

- Protocol: [`raptor0929/shinobi`](https://github.com/raptor0929/shinobi) (vendored pin in `vendor/cpp-client`)
- Testnet vault: `CB72LNFU3AWO34Q5PFV7NKINO5KVTQIXYE4PCH4TE32T7I6K2OL5QCFA`

## Docs

- [`CONTEXT.md`](./CONTEXT.md) — domain language
- [`docs/adr/0001-fe-only-demo-repo.md`](./docs/adr/0001-fe-only-demo-repo.md)
- [`docs/adr/0002-demo-sponsor-relayer.md`](./docs/adr/0002-demo-sponsor-relayer.md)
- [`docs/adr/0003-upstream-client-pin.md`](./docs/adr/0003-upstream-client-pin.md)
- [`docs/adr/0004-demo-compliance-tick.md`](./docs/adr/0004-demo-compliance-tick.md)
