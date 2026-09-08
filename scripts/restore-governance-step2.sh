#!/bin/zsh
# One-shot step 2: after the cold-start proposal #144 (6 h / 6 h) leaves grace, execute it and then the
# restore proposal #145 (Baal processes in sponsorship order: #145 stays "prev!processed" until #144 is done).
set -u
cd ~/srv/zero-one-dao
LOG=evidence/testnet/governance-restore-6h-2026-09-08.log
G=(npx tsx scripts/testnet-governance.ts)
target=1788913030  # 2026-09-09T00:17:10Z, #144 graceEnds 1788898604 + margin; #143 (spam, unvoted) is Defeated by then
while [ $(date +%s) -lt $target ]; do sleep 60; done
D144=$(curl -s --max-time 60 "https://zero-one-beacon.vercel.app/proposals.json?limit=1&before=145" | python3 -c 'import json,sys;d=json.load(sys.stdin);p=[x for x in d.get("proposals",d.get("items",[])) if x.get("id")==144][0];print(p["proposalData"])')
D145=$(grep -o 'executeCommand": "[^"]*' $LOG | tail -1 | sed 's/.*--data //')
echo "== $(date -u) execute #144 (cold start payment)" >> $LOG
for i in 1 2 3 4 5 6; do "${G[@]}" --execute 144 --data $D144 >> $LOG 2>&1 && break; sleep 60; done
echo "== $(date -u) execute #145 (restore 6h/6h)" >> $LOG
for i in 1 2 3 4 5 6; do "${G[@]}" --execute 145 --data $D145 >> $LOG 2>&1 && break; sleep 60; done
"${G[@]}" --status 145 >> $LOG 2>&1
echo "== $(date -u) done" >> $LOG
