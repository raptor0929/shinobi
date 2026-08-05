# Demo compliance tick on Vercel / local

A live `npm run mint` daemon cannot run inside Vercel serverless. For demos we expose a one-shot **Run compliance** action (`POST /api/mint/tick`) that screens (demo: allow-all), blind-signs, and `announce`s a pending deposit using `MINT_AUTHORITY_SECRET` + `MINT_SEED` in env. This revises the earlier “mint keys never on Vercel” stance **for testnet demo only** — production mint stays a separate long-lived operator process with real screening.
