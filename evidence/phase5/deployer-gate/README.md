# Deployer funding gate — receipts

The ruling (decision.md, 2026-09-10, "phase 5 Base fork rehearsal review"): the fixed 0.005 ETH
`MIN_DEPLOYER_WEI` floor in `scripts/deploy-network.ts` is replaced by a requirement computed from
the chain the deployment is about to write to.

    required = max(measured deployment gas x live base fee x 5, 0.02 ETH)

Implemented in `src/deployerGate.ts`, called by `deployNetwork` before any write. The gas is read
from the committed fork measurement `evidence/phase5/base-fork/measurements.json` (24,778,573 gas
over 22 transactions) rather than written down a second time, and the refusal names the measurement
it came from, the live base fee it used and what the deployer actually holds.

| File | What it is |
| --- | --- |
| `requirement-table.json` | What the rule answers at 0.006 / 0.05 / 0.5 gwei, the measurement it read, and the four live cases that produced the same numbers on an owned Base fork. |
| `gate-cases.log` | The four cases and the exact message each produced: pass at a realistic fee, refuse at a high fee with the same balance, refuse one wei under the requirement, pass at exactly the requirement. |
| `base-fork-rehearsal.log` | The deployment section of `npm run e2e:base-fork`: the gate passing at Base's live base fee, then all 22 transactions and the 50 USDC genesis completing. |

Produced by `npm run test:deploy-refusals` and `npm run e2e:base-fork`; the full transcripts are
`evidence/phase5/base-fork/deploy-refusals.log` and `evidence/phase5/base-fork/e2e-base-fork.log`.

Known, unrelated: the fork rehearsal completes the deployment, genesis, the gas measurement and the
Baal-fork assertions, then fails later in its lifecycle section at `NavShareToken.lotCount`, which
the 2026-09-10 incremental-settlement redesign removed from the contract without updating
`scripts/e2e-base-fork.ts`. That harness drift predates this change and is a design question for the
retention review, not a funding-gate question.

Because the rehearsal died before writing its measurement, `measurements.json` still holds the
2026-09-10 figure (24,778,573 gas) while this run's deployment section measured 24,754,770 with the
post-redesign contracts. The gate therefore reads a number 0.1% above the current cost, which is the
conservative direction; it will follow the measurement down as soon as a completed rehearsal rewrites
the file, which is the whole reason the gas is read from that file instead of being written down.
