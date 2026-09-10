# Governance / NAV audit tests (components 1 and 2 of goals/security-audit.md)

Run: `sh evidence/audit/governance-nav/run-all.sh` (each test boots its own anvil via scenarios/lib.ts; needs `npm run compile` first — the untracked contracts/artifacts on this Mac were stale vs the phase-3 source, 2026-09-08 07:12 vs 19:56, and scenario G failed until recompiled).
A test verdict "PASS" means the described behaviour was reproduced; findings are tests whose title says "finding demonstrated".
Logs: `logs/<test>.log` (key lines) and `logs/<test>.full.log` (complete output, receipts).
Helper: `contracts/AuditMulticall.sol` (audit-only contract member batching calls into one transaction; compiled by `compile-helper.ts` into `artifacts/`).

| row | test |
|---|---|
| GOV-01 | t01-lowgas-process-kills-proposal.ts |
| GOV-02 | t02-vote-weight-survives-exit.ts |
| GOV-03 | t03-retention-bypass-deposit-at-processing.ts |
| GOV-04 | t07-retention-veto-flash.ts |
| GOV-05 | t08-baalgas-20m-blocks-chain.ts (+ probe-gas.ts) |
| GOV-06 | t09-minretention-boundary.ts |
| GOV-07 | t10-one-second-periods-terminal.ts |
| GOV-08 | t12-sponsor-order-delays-execution.ts |
| NAV-01, NAV-05 | t04-hole1-instance-usdc-invisible.ts |
| NAV-02 | t05-empty-safe-repricing.ts |
| NAV-03 | t06-last-holder-inflation.ts |
| NAV-04 | t11-same-tx-roundtrip.ts |
| NAV-06 | t13-ready-proposal-vs-later-depositor.ts |
| NAV-07 | t14-nav07-safe-dust-does-not-pause-deposits.ts (phase 5) |

Phase 5 (branch phase4-ledger-twap): t01, t03, t04, t07, t08 and t14 are FLIPPED — they now assert the fixed behaviour and PASS means the invariant holds (decision.md phase 5 rulings; key lines under evidence/phase5/<row>.log).
