# Pin Upstream Client for crypto

The vault verifies Chaum blind-signature values produced off-chain; reimplementing that math in the Demo FE is how clients and contract quietly diverge. Vendor-copying files without a pin also drifts. Publishing `@cpp/client` to npm is not available yet (package is private in `raptor0929/shinobi/ts`). **Decision:** depend on Upstream Protocol’s `@cpp/client` via a Git-pinned commit (subdirectory `ts`), and keep Demo FE-specific code as adapters (Freighter deposit, seed cache, Sponsor/Relayer). Do not rewrite `crypto.ts` / redemption message encoding.
