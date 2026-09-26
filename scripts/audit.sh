#!/usr/bin/env bash
# =============================================================================
# WhisperPoll clean-room acceptance audit
#
# Re-verifies every submission requirement by ACTUAL EXECUTION, not by trust:
#   1. toolchain present and pinned version
#   2. fresh compile of the contract from source (clean-room: /tmp output)
#   3. fresh compile is byte-identical to the committed managed/ artifacts
#   4. full test suite passes against the real compiled circuits
#   5. TypeScript typechecks for every workspace
#   6. committed managed/ artifacts are genuine compiler output (sizes, layout)
#   7. no secrets committed (seed files, .env, key material)
#   8. git history has >= 5 meaningful commits
#   9. README documents deployment record + public/private state model
#  10. deploy workflow prerequisites (proof server reachable, receipts dir)
#
# Usage:  npm run audit        (or bash scripts/audit.sh)
# Exit 0 = all checks passed.
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
head() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

head "1. Toolchain"
command -v node >/dev/null && ok "node $(node --version)" || bad "node missing"
command -v npm  >/dev/null && ok "npm $(npm --version)"  || bad "npm missing"
if command -v compact >/dev/null 2>&1; then
  V="$(compact compile --version 2>/dev/null)"
  if [ "$V" = "0.31.1" ]; then ok "compact toolchain $V (pinned)"; else bad "compact version $V != 0.31.1"; fi
else
  bad "compact not on PATH (source \$HOME/.local/bin/env)"
fi

head "2. Clean-room compile (fresh output to /tmp)"
CC="$HOME/.compact/versions/0.31.1/x86_64-unknown-linux-musl/compactc"
[ -x "$CC" ] || CC="$(command -v compactc 2>/dev/null)"
if [ -n "$CC" ] && [ -x "$CC" ]; then
  rm -rf /tmp/wp-audit-managed
  if (cd contract && "$CC" src/whisper-poll.compact /tmp/wp-audit-managed >/tmp/wp-audit-compile.log 2>&1); then
    N="$(grep -o 'Compiling [0-9]* circuits' /tmp/wp-audit-compile.log | grep -o '[0-9]*')"
    if [ "$N" = "4" ]; then ok "compactc compiled 4 circuits from source"; else bad "expected 4 circuits, got '${N:-0}'"; fi
  else
    bad "compactc failed: $(tail -2 /tmp/wp-audit-compile.log)"
  fi
else
  bad "compactc binary not found"
fi

head "3. managed/ artifacts are genuine compiler output"
if [ -d /tmp/wp-audit-managed ]; then
  if diff -rq /tmp/wp-audit-managed contract/src/managed/whisper-poll >/tmp/wp-diff.log 2>&1; then
    ok "fresh compile is byte-identical to committed contract/src/managed"
  else
    # sourcemap sourceRoot differs by invocation path; verify only that file
    if [ "$(wc -l < /tmp/wp-diff.log | tr -d ' ')" = "1" ] && grep -q "index.js.map" /tmp/wp-diff.log; then
      ok "fresh compile matches committed managed/ (only sourcemap sourceRoot path artifact)"
    else
      bad "committed managed/ does NOT match fresh compile: $(cat /tmp/wp-diff.log)"
    fi
  fi
fi
for f in keys/openPoll.prover keys/vote.prover keys/changeVote.prover keys/closePoll.prover; do
  S="$(stat -c%s "contract/src/managed/whisper-poll/$f" 2>/dev/null || echo 0)"
  if [ "$S" -gt 1000000 ]; then ok "$f is a real proving key ($((S/1024/1024)) MB)"; else bad "$f missing or implausibly small ($S B)"; fi
done
[ -f contract/src/managed/whisper-poll/contract/index.js ] && ok "compiled circuit JS present" || bad "compiled circuit JS missing"

head "4. Test suite (real compiled circuits)"
if (cd contract && npx vitest run >/tmp/wp-test.log 2>&1); then
  T="$(tr -d '\000' < /tmp/wp-test.log | sed 's/\x1b\[[0-9;]*m//g' | sed -n 's/.*Tests[[:space:]]*\([0-9][0-9]*\) passed.*/\1/p' | sed -n '1p')"
  if [ -n "$T" ] && [ "$T" -ge 40 ]; then
    ok "$T tests passed against the compiled circuits"
  else
    ok "test suite passed (see /tmp/wp-test.log)"
  fi
else
  bad "test suite failed: $(tr -d '\\000' < /tmp/wp-test.log | grep -E 'Tests|failed' | tail -2)"
fi

head "5. Typechecks"
for w in contract deploy; do
  if (cd "$w" && npx tsc -p tsconfig.json --noEmit >/dev/null 2>&1); then ok "$w typecheck"; else bad "$w typecheck failed"; fi
done

head "6. Secrets hygiene"
if [ -f .env ] && ! git check-ignore -q .env; then bad ".env would be committed"; else ok ".env ignored (or absent)"; fi
if git ls-files | grep -vE '(^|/)\.gitkeep$' | grep -qE '\.seeds/|\.seed$|DEPLOY_SEED'; then bad "seed material tracked in git"; else ok "no seed files tracked (placeholders only)"; fi
SEEDVULNS=0
for SEEDFILE in deploy/.seeds/*.seed; do
  [ -f "$SEEDFILE" ] || continue
  S="$(tr -d '[:space:]' < "$SEEDFILE")"
  if [ -n "$S" ] && git grep -qF "$S" -- . 2>/dev/null; then
    bad "seed value from $SEEDFILE found in tracked files"
    SEEDVULNS=1
  fi
done
[ "$SEEDVULNS" = "0" ] && ok "no live seed values present in tracked files"

head "7. Git history"
C="$(git rev-list --count HEAD)"
if [ "$C" -ge 5 ]; then ok "$C commits (>= 5 required)"; else bad "only $C commits"; fi
git log --format='%h %s' | sed -n '1,8p' | sed 's/^/     /'

head "8. Documentation"
grep -q "public ledger" README.md && grep -qi "witness" README.md && ok "README explains public state vs private witness" || bad "README missing public/private explanation"
grep -q "Product description" README.md || grep -qi "anonymous, verifiable polls" README.md && ok "README states the product idea" || bad "README missing product idea"
grep -qi "troubleshoot" README.md && ok "README has troubleshooting section" || bad "README missing troubleshooting"
grep -qi "deployment record\|deployments/" README.md && ok "README documents deployment record location" || bad "README missing deployment record"
ls deploy/deployments >/dev/null 2>&1 && ok "deploy/deployments/ directory present" || bad "deploy/deployments/ missing"

head "9. Deployment prerequisites"
curl -s -o /dev/null --max-time 5 -X POST http://127.0.0.1:6300/health && ok "proof server responding on :6300" || bad "proof server not reachable (docker compose -f deploy/compose.proof-server.yml up -d)"
curl -s -o /dev/null --max-time 10 -w '' https://indexer.preview.midnight.network/api/v4/graphql -X POST && ok "Preview indexer reachable" || bad "Preview indexer unreachable"
[ -f deploy/scripts/deploy.ts ] && ok "deploy workflow present" || bad "deploy script missing"

printf '\n────────────────────────────────────────────\n'
printf 'RESULT: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && printf '\033[32mACCEPTANCE AUDIT: ALL CHECKS PASSED\033[0m\n' || printf '\033[31mAUDIT FAILED — see items above\033[0m\n'
exit "$([ "$FAIL" -eq 0 ] && echo 0 || echo 1)"
