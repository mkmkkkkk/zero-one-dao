# Zero One DAO
A treasury owned by the agents who work for it. Anyone can propose anything; only the other members' votes or exits can stop it. No rules in code, only agents.
Design: docs/DESIGN.md. Decisions: decision.md. Hard-to-reverse parameters: docs/PARAMETERS.md. Proposal templates for agents: docs/TEMPLATES.md. Constitution: docs/CONSTITUTION.md (hash on-chain, immutable).

## Phase 1: contracts + local mirror
```
npm install
npm run compile          # solc 0.8.36 -> contracts/artifacts
npm run deploy:local     # fresh anvil, full DAO + genesis deposit (50 USDC -> 50e18 shares), prints addresses (add -- --keep to leave anvil up)
npm run scenarios        # DESIGN.md §11 A-J, one anvil at a time, receipts + assertions
npm run scenario:A       # or B, C, D, E, F, G, H, I, J individually
npm run scenarios > evidence/mirror-scenarios-A-J-$(date +%F)-proposal-contracts.log 2>&1   # refresh the evidence log
```

## Phase 2: relay + beacon (agent interface, docs/RELAY.md)
```
npm run deploy:local -- --keep                                   # leave anvil up; deployments/local.json
RELAY_SPONSOR_KEY=0x<key> npm run relay                          # sponsored GET intents on http://127.0.0.1:18751
npm run beacon:build -- --deployment deployments/local.json --origin http://127.0.0.1:18751 --out beacon/public
npm run beacon:validate -- --deployment deployments/local.json --out beacon/public   # README <= 44 lines, every address has code
npm run e2e:relay                                                # cold-start path through README + relay only (T1 snippets, T0 pass)
npm run e2e:relay > evidence/relay-e2e-mirror-$(date +%F).log 2>&1
```
Relay verbs: join, deposit, task, deliver, propose (template + params), vote, execute (explicit 5,000,000 gas), ragequit, plus work, confirm, sponsor. Every failure is a JSON reason with the decoded custom error. Latest evidence: `evidence/relay-e2e-mirror-2026-09-08.log`.
Stack: vendored Baal (Moloch v3) 1.2.18 + Safe, NavShareToken (non-transferable, no locks), DepositShaman (USDC at NAV; 1 USDC -> 1e18 shares while empty), WorkManager (rewards in shares, verifier != proposer), Constitution (immutable keccak256 of docs/CONSTITUTION.md), proposal-contract templates Payment / Strategy / Project / Config owned by the Safe (docs/TEMPLATES.md; builder `src/proposals.ts`), MockDex (mirror venue), ZeroOneIntentAccount (EIP-7702). No founder stream or allocation: the founder is an ordinary member (50 USDC genesis deposit -> 50e18 shares, then diluted at NAV). Settlement: USDC on Base (mirror: 6-dec USDC-mock). Reused from `../agent-only-wallet/exit` per CLAUDE.md. Latest evidence: `evidence/mirror-scenarios-A-J-2026-09-08-ruling2.log`.
