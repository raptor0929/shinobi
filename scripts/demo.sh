#!/usr/bin/env bash
#
# End-to-end demo against a deployed vault.
#
# Run `./scripts/deploy.sh` first, then start the mint in another terminal:
#
#     npm --prefix ts run mint
#
# Then run this. It deposits from Alice, waits for the mint to screen and sign,
# and redeems to a freshly created account that has never interacted with Alice.
#
# What to watch for: nothing published on chain connects the deposit to the
# payout. The deposit carries `deposit_id` and `B`; the redemption carries
# `nullifier` and `S`. Linking them needs the blinding factor `r`, which never
# left Alice's wallet.

set -euo pipefail

cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo "no .env — run ./scripts/deploy.sh first" >&2; exit 1; }
set -a; source .env; set +a

CLIENT="npm --prefix ts run --silent client --"
NETWORK="${STELLAR_NETWORK:-testnet}"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    \033[2m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------

say "Vault"
$CLIENT status 2>/dev/null || true

say "Creating a fresh recipient"
# A brand-new account with no history. If the pool works, it ends up funded by
# a vault it never touched, from a depositor it has no on-chain relationship to.
RECIPIENT_NAME="cpp-recipient-$(date +%s)"
stellar keys generate "$RECIPIENT_NAME" --network "$NETWORK" --fund >/dev/null
RECIPIENT="$(stellar keys address "$RECIPIENT_NAME")"
note "$RECIPIENT"
BEFORE="$(stellar contract invoke --id "$(stellar contract id asset --asset native --network "$NETWORK")" \
  --source cpp-alice --network "$NETWORK" -- balance --id "$RECIPIENT" 2>/dev/null || echo '"0"')"
note "balance before: $BEFORE stroops"

say "Initialising Alice's wallet"
rm -f .cpp/wallet.json
$CLIENT init

say "Depositing"
$CLIENT deposit

say "Waiting for the mint to screen and sign"
note "the mint is reading the deposit event, looking up Alice's address,"
note "running it through the policy, and calling announce"
for attempt in $(seq 1 20); do
  sleep 5
  if $CLIENT scan 2>/dev/null | grep -q "ready"; then
    break
  fi
  printf '    …%d\n' $((attempt * 5))
done

say "Wallet state"
$CLIENT status

say "Redeeming to the fresh account"
note "submitted and paid for by cpp-relayer, which has never seen Alice"
$CLIENT redeem "$RECIPIENT"

say "Result"
AFTER="$(stellar contract invoke --id "$(stellar contract id asset --asset native --network "$NETWORK")" \
  --source cpp-alice --network "$NETWORK" -- balance --id "$RECIPIENT" 2>/dev/null || echo '"0"')"
note "balance after: $AFTER stroops"

cat <<EOF

The recipient was paid. On chain there are two unlinked facts:

  deposit   deposit_id + B   from $(stellar keys address cpp-alice)
  redeem    nullifier  + S   to   $RECIPIENT

The mint's audit log (.cpp/mint-audit.jsonl) records that Alice was screened
and admitted. It does not — and cannot — record where her token was spent.
EOF
