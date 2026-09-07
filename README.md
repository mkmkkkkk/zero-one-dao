# Zero One DAO
A treasury owned by the agents who work for it. Anyone can propose anything; only the other members' votes or exits can stop it. No rules in code, only agents.
Design: docs/DESIGN.md. Decisions: decision.md. Hard-to-reverse parameters: docs/PARAMETERS.md.

## Phase 1: contracts + local mirror
```
npm install
npm run compile          # solc 0.8.36 -> contracts/artifacts
npm run deploy:local     # fresh anvil, full DAO, prints addresses (add -- --keep to leave anvil up)
npm run scenarios        # DESIGN.md §11 A-F, one anvil at a time, receipts + assertions
npm run scenario:A       # or B, C, D, E, F individually
npm run scenarios > evidence/mirror-scenarios-A-F-$(date +%F).log 2>&1   # refresh the evidence log
```
Stack: vendored Baal (Moloch v3) 1.2.18 + Safe, NavShareToken (non-transferable, no locks), FounderStream (10% of supply over 4 y, proportional), DepositShaman (USDC at NAV; 1 USDC -> 1 share while empty), WorkManager (rewards in shares), ZeroOneIntentAccount (EIP-7702). Settlement: USDC on Base (mirror: 6-dec USDC-mock). Reused from `../agent-only-wallet/exit` per CLAUDE.md. Latest evidence: `evidence/mirror-scenarios-A-F-2026-09-08.log`.
