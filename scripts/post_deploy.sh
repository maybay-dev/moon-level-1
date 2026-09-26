#!/usr/bin/env bash
# =============================================================================
# post_deploy.sh — finish a deployment: deploy (if needed) → evidence → README
#
# Once a receipt exists this captures the live deployment evidence and rewrites
# the README's deployment record from the receipts on disk. If no receipt exists
# yet it runs the headless deploy first, so a single command completes the
# whole sequence.
#
# Idempotent: re-running only refreshes the evidence + README from disk.
#
# Usage:
#   bash scripts/post_deploy.sh [--network preview|preprod] [receipt.json]
#
#   --network   network to deploy when no receipt exists (default: preview)
#   receipt.json  use this receipt instead of the newest in deploy/deployments/
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NETWORK="preview"
RECEIPT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --network)   NETWORK="${2:?--network needs a value}"; shift 2 ;;
    --network=*) NETWORK="${1#--network=}"; shift ;;
    -h|--help)   sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*)          echo "Unknown option: $1" >&2; exit 1 ;;
    *)           RECEIPT="$1"; shift ;;
  esac
done

case "$NETWORK" in
  preview|preprod) ;;
  *) echo "Unknown network: $NETWORK (expected preview or preprod)" >&2; exit 1 ;;
esac

newest_receipt() { ls -t deploy/deployments/*.json 2>/dev/null | head -1 || true; }

[ -n "$RECEIPT" ] || RECEIPT="$(newest_receipt)"
if [ -z "$RECEIPT" ]; then
  echo "No deployment receipt yet — running 'npm run deploy:$NETWORK'…"
  npm run "deploy:$NETWORK"
  RECEIPT="$(newest_receipt)"
fi
if [ -z "$RECEIPT" ] || [ ! -f "$RECEIPT" ]; then
  echo "ERROR: still no deployment receipt after deploy." >&2
  exit 1
fi
echo "Receipt:   $RECEIPT"

echo "[1/2] Capturing live deployment evidence…"
bash scripts/deploy_evidence.sh "$RECEIPT"

echo "[2/2] Updating README deployment record…"
python3 scripts/update_readme_deployment.py

echo
echo "Done. Review, then publish:"
echo "  git add README.md docs/evidence/deploy-proof.txt docs/screenshots/deploy-proof.svg \"$RECEIPT\""
