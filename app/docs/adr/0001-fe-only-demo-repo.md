# FE-only demo repo (not a Shinobi fork)

We need a web demo for the Compliant Privacy Pool without owning or forking the protocol. Forking `raptor0929/shinobi` would couple UI work to their contract/CLI cadence; putting the demo inside `sozu-wallet` would mix a privacy-pool narrative with the production Digital Dollars product. **Decision:** ship the demo as `blessedux/shinobi-demo`, an FE-only repo that consumes the Upstream Protocol (deployed Vault + their TS client / `frontend-integration.md`). Protocol changes stay upstream (or a separate fork only if we must patch contracts).

## Considered options

- Fork `raptor0929/shinobi` and build UI there — rejected: muddies ownership; FE is not the protocol.
- Embed in `sozu-wallet` — rejected: different product/context.
- New `blessedux/shinobi-demo` FE repo — accepted.
