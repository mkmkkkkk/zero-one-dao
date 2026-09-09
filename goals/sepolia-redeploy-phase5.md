# Zero One DAO — redeploy on Base Sepolia with the phase 5 code and re-earn the acceptance (queued; dispatch after the merge)

Red-line clarification: Base Sepolia is a testnet; its USDC is our own mock and its ETH is free. No Base mainnet
transaction, no mainnet key, no marketing. Never construct any rm command; never commit .env, keys or state; never print a
key; git email yangzk01@gmail.com.

Why: the live Sepolia deployment predates phase 4 and phase 5. Its contracts are the old ones (no TreasuryLedger, upstream
Baal and MultiSend, DepositShaman with three constructor arguments, the spot venue, the zero-supply trap, no retention
fix). Every receipt under evidence/testnet/ therefore describes code we are not shipping. Mainnet must be rehearsed on the
code that ships, so Sepolia is deployed again from the merged branch and the acceptance is earned again, not inherited.

Run from the mini checkout the relay uses (`~/srv/zero-one-dao`, branch main after the merge), deployer key in
`~/srv/aow-exit/.env.sepolia`, RPC https://sepolia.base.org with the lag helpers this repo already has.

## GOAL
1. Deploy the phase 5 stack fresh on Base Sepolia with `scripts/deploy-base-sepolia.ts`: mock USDC, singletons, the vendored
   Baal fork, MultiSendCallOnly, Safe, tokens, DepositShaman with the WorkManager, WorkManager, TreasuryLedger through the
   factory, the four template deployers, TemplateFactory, the intent account, Constitution pinned to the pushed merge
   commit, and the genesis deposit in the same run. Write `deployments/base-sepolia.json` (move the old record aside to
   `deployments/base-sepolia-phase3.json`, do not delete it) and the verification inputs. Verify every contract on Basescan
   with the recursive standard input, which now includes the Baal fork and MultiSendCallOnly: report the count verified.
2. Point the live services at the new deployment: the launchd relay's deployment file and state directory (a NEW state
   directory, never one that held the old DAO's requests or T0 passes), a canonical beacon build in the relay's beacon
   directory, and the Vercel mirror rebuilt. Prove `https://relay-zero.mkyang.ai/README.txt` answers 200 with the new
   addresses and that `beacon/scripts/validate.ts` passes against that origin with its live fetches.
3. Earn the acceptance again on the real chain: scenarios A through L against Sepolia (each scenario deploying its own DAO
   as before), the corner-case rows of docs/TESTNET_PLAN.md that involve contracts changed by phase 4 or 5, and the phase 5
   additions specifically — ledger pricing with a budget out, the settled gate, the retention deficit including the
   exit-and-return counterexample, the task share liability, the baalGas cap, and a delegatecall proposal being refused by
   MultiSendCallOnly. Then two cold starts from the served README only, one T1 and one T0, from two different machines.
4. Update docs/TESTNET_PLAN.md (status, addresses, what each receipt proves) and docs/PARAMETERS.md where an address changes.
   Keep the old logs; new ones go under evidence/testnet/phase5/.

## ACCEPTANCE
The new deployment record is committed with every address; Basescan shows every contract verified; the canonical README
answers 200 with the new addresses and the validator passes against it; scenarios A–L green on Sepolia with receipts; the
phase 5 corner cases green with receipts; two cold starts green from two machines; TESTNET_PLAN updated.

## NOT AN ANSWER
Reusing the old deployment or its relay state; skipping verification; a cold start that reads anything but the served README
and snippet; "the old receipts still apply".
