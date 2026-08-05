# shinobi-demo

Demo front-end for **Shinobi** — Compliant Privacy Pool for institutional payroll — on Stellar testnet.

Shows a simple **Shielded Transfer**: deposit → Off-App Mint announce → redeem via Demo Relayer → **Unlinkability Proof**.

## Quick start

```bash
npm install
cp .env.example .env.local
# fill SPONSOR_SECRET + RELAYER_SECRET for redeem / sponsored recipient
npm run dev
```

Open http://localhost:3000 — Freighter on testnet; run upstream mint separately.

## Upstream

- Protocol: [`raptor0929/shinobi`](https://github.com/raptor0929/shinobi) (vendored pin in `vendor/cpp-client`)
- Testnet vault: `CB72LNFU3AWO34Q5PFV7NKINO5KVTQIXYE4PCH4TE32T7I6K2OL5QCFA`

## Docs

- [`CONTEXT.md`](./CONTEXT.md) — domain language
- [`docs/adr/0001-fe-only-demo-repo.md`](./docs/adr/0001-fe-only-demo-repo.md)
- [`docs/adr/0002-demo-sponsor-relayer.md`](./docs/adr/0002-demo-sponsor-relayer.md)
- [`docs/adr/0003-upstream-client-pin.md`](./docs/adr/0003-upstream-client-pin.md)
