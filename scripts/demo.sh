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
#
# Created under `cpp-sponsor`, not friendbot and emphatically not Alice. The
# account that puts up a new account's base reserve is written onto that account
# permanently, so letting the depositor create their own recipient would publish
# the depositor -> recipient edge that the blind signature exists to remove. One
# shared sponsor on every recipient distinguishes none of them.
RECIPIENT="$(npm --prefix ts run --silent sponsor -- --quiet)"
note "$RECIPIENT"
note "sponsored by $(stellar keys address cpp-sponsor), starting balance 0"
# Read-only simulation, but sourced from the sponsor rather than Alice: the
# sponsor is already tied to this account by construction, so naming it here
# cannot leak anything that is not already on chain.
BEFORE="$(stellar contract invoke --id "$(stellar contract id asset --asset native --network "$NETWORK")" \
  --source cpp-sponsor --network "$NETWORK" -- balance --id "$RECIPIENT" 2>/dev/null || echo '"0"')"
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
  --source cpp-sponsor --network "$NETWORK" -- balance --id "$RECIPIENT" 2>/dev/null || echo '"0"')"
note "balance after: $AFTER stroops"

cat <<EOF

The recipient was paid. On chain there are three unlinked facts:

  create    base reserve     by   $(stellar keys address cpp-sponsor)
  deposit   deposit_id + B   from $(stellar keys address cpp-alice)
  redeem    nullifier  + S   to   $RECIPIENT

Alice appears on the deposit and nowhere else. The redemption was submitted and
paid for by cpp-relayer; the recipient account was created by cpp-sponsor. Both
are constants across every cycle, so neither says which deposit this payout came
from — that is what makes them safe to reuse, and what would make Alice unsafe
in either role.

The mint's audit log (.cpp/mint-audit.jsonl) records that Alice was screened
and admitted. It does not — and cannot — record where her token was spent.

Caveat worth reading: this pool's anonymity set is the number of deposits
outstanding when you redeem. Two deposits and two redemptions minutes apart pair
up by timing no matter how good the cryptography is.
EOF
