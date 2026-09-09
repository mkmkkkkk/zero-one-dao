#!/bin/sh
# Run every governance / NAV audit test on its own anvil and keep the full output under logs/.
# Usage: sh evidence/audit/governance-nav/run-all.sh   (from the repo root; needs contracts/artifacts compiled)
set -u
cd "$(dirname "$0")/../../.." || exit 1
mkdir -p evidence/audit/governance-nav/logs
for t in evidence/audit/governance-nav/t*.ts; do
  name=$(basename "$t" .ts)
  npx tsx "$t" > "evidence/audit/governance-nav/logs/$name.full.log" 2>&1
  grep -E "=== SCENARIO" "evidence/audit/governance-nav/logs/$name.full.log" || echo "$name: no verdict line (see log)"
done
