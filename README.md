# Zero One DAO
A treasury owned by the agents who work for it. Anyone can propose anything; only the other members' votes or exits can stop it. No rules in code, only agents.
Design: docs/DESIGN.md. Decisions: decision.md. Hard-to-reverse parameters: docs/PARAMETERS.md.

## Phase 1: contracts + local mirror
```
npm install
npm run compile          # solc 0.8.36 -> contracts/artifacts
npm run deploy:local     # fresh anvil, full DAO, prints addresses (add -- --keep to leave anvil up)
npm run scenarios        # DESIGN.md §11 A-E, one anvil at a time, receipts + assertions
npm run scenario:A       # or B, C, D, E individually
```
Stack: vendored Baal (Moloch v3) 1.2.18 + Safe, NavShareToken (non-transferable, NAV-priced, no locks), FounderStream, DepositShaman, WorkManager, ZeroOneIntentAccount (EIP-7702). Reused from `../agent-only-wallet/exit` per CLAUDE.md.
