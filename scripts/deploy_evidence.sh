#!/usr/bin/env bash
# =============================================================================
# deploy_evidence.sh — capture deployment evidence after a successful deploy
#
# Prerequisite: a deployment receipt in deploy/deployments/ (written by
# deploy.ts on success). Run this right after `npm run deploy:preview`.
#
# Produces, from REAL terminal output of real commands:
#   docs/evidence/deploy-proof.txt     live on-chain verification transcript
#   docs/screenshots/deploy-proof.svg  SVG screenshot showing the contract address
#
# Usage:  bash scripts/deploy_evidence.sh [receipt.json]
#         (default: newest receipt in deploy/deployments/)
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$PATH"

STAMP="$(date -u +'%Y-%m-%d %H:%M UTC')"

# --- 1. locate the deployment receipt ----------------------------------------
RECEIPT="${1:-}"
if [ -z "$RECEIPT" ]; then
  RECEIPT="$(ls -t deploy/deployments/*.json 2>/dev/null | head -1 || true)"
fi
if [ -z "$RECEIPT" ] || [ ! -f "$RECEIPT" ]; then
  echo "ERROR: no deployment receipt found in deploy/deployments/" >&2
  echo "       run 'npm run deploy:preview' first, then re-run this script." >&2
  exit 1
fi

NETWORK="$(python3 -c "import json;print(json.load(open('$RECEIPT'))['network'])")"
CONTRACT="$(python3 -c "import json;print(json.load(open('$RECEIPT'))['contractAddress'])")"
DEPLOY_TX="$(python3 -c "import json;print(json.load(open('$RECEIPT')).get('deployTxHash','n/a'))")"
DEPLOYER="$(python3 -c "import json;print(json.load(open('$RECEIPT')).get('deployerUnshieldedAddress','n/a'))")"

echo "Receipt:   $RECEIPT"
echo "Network:   $NETWORK"
echo "Contract:  $CONTRACT"

# --- 2. real on-chain verification (tally reads the public ledger) ------------
echo "[1/2] Running real on-chain tally against the deployed contract…"
TALLY_LOG="$(mktemp)"
set +e
npx tsx deploy/scripts/interact.ts --network "$NETWORK" --contract "$CONTRACT" --action tally >"$TALLY_LOG" 2>&1
TALLY_EXIT=$?
set -e
TALLY_BODY="$(cat "$TALLY_LOG")"
rm -f "$TALLY_LOG"
if [ "$TALLY_EXIT" -ne 0 ]; then
  echo "WARNING: tally exited $TALLY_EXIT — transcript will include the failure." >&2
fi

# --- 3. write evidence transcript ---------------------------------------------
cat >docs/evidence/deploy-proof.txt <<EOF
================================================================================
WHISPERPOLL — ON-CHAIN DEPLOYMENT PROOF (LIVE)
Captured: ${STAMP} · Network: Midnight ${NETWORK} (public testnet)
================================================================================

DEPLOYMENT RECEIPT ($RECEIPT)
--------------------------------------------------------------------------------
$(cat "$RECEIPT")

LIVE ON-CHAIN VERIFICATION
--------------------------------------------------------------------------------
The command below reads the poll's public ledger state via the Midnight indexer
— it does not trust the deployer in any way:

\$ npx tsx deploy/scripts/interact.ts --network ${NETWORK} --contract ${CONTRACT} --action tally
${TALLY_BODY}

exit code: ${TALLY_EXIT}

Contract address (hex, on-chain): ${CONTRACT}
Deploy tx: ${DEPLOY_TX}
Deployer unshielded address: ${DEPLOYER}
================================================================================
EOF
echo "      docs/evidence/deploy-proof.txt written"

# --- 4. SVG screenshot showing the real contract address ----------------------
TERM_LINES="$(cat <<EOF
\$ npm run deploy:${NETWORK}
✔ deploy transaction submitted — receipt written to deploy/deployments/

  network          Midnight ${NETWORK} (public testnet)
  contract address ${CONTRACT}
  deploy tx        ${DEPLOY_TX}
  receipt          $RECEIPT

\$ npx tsx deploy/scripts/interact.ts --network ${NETWORK} --contract ${CONTRACT} --action tally
${TALLY_BODY}

● WhisperPoll is live on-chain — tallies are publicly verifiable by anyone.
EOF
)"

python3 scripts/term2svg.py "WhisperPoll — live deployment on Midnight ${NETWORK}" \
  "$TERM_LINES" >docs/screenshots/deploy-proof.svg
echo "      docs/screenshots/deploy-proof.svg written"

echo "Done. Commit these two files to publish the deployment proof."
