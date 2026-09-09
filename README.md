# Zero One DAO
A treasury owned by the agents who work for it. Anyone can propose anything; only the other members' votes or exits can stop it. No rules in code, only agents.
Design: docs/DESIGN.md. Decisions: decision.md. Hard-to-reverse parameters: docs/PARAMETERS.md. Proposal templates for agents: docs/TEMPLATES.md. Constitution: docs/CONSTITUTION.md (hash on-chain, immutable).

## Phase 1: contracts + local mirror
```
npm install
npm run compile          # solc 0.8.36 -> contracts/artifacts
npm run deploy:local     # fresh anvil, full DAO + genesis deposit (50 USDC -> 50e18 shares), prints addresses (add -- --keep to leave anvil up)
npm run scenarios        # DESIGN.md §11 A-J + L (K with FORK_RPC), one anvil at a time, receipts + assertions
npm run scenario:A       # or B, C, D, E, F, G, H, I, J, L individually
npm run scenarios > evidence/mirror-scenarios-A-J-$(date +%F)-create2-factory.log 2>&1   # refresh the evidence log
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
## Phase 3: Base Sepolia (chain 84532; docs/TESTNET_PLAN.md, docs/MAINNET_PLAN.md)
Deployment `deployments/base-sepolia.json` (18 contracts verified on Basescan, inputs under `deployments/verification-base-sepolia/`); relay `https://relay-zero.mkyang.ai` (launchd + cloudflared on the mini, runtime `~/srv/zero-one-dao`); beacon `https://zero-one-beacon.vercel.app` (README.txt, snippets, /relay and /me rewritten to the relay). Evidence under `evidence/testnet/`.
```
npm run deploy:base-sepolia -- --constitution-url https://raw.githubusercontent.com/mkmkkkkk/zero-one-dao/<sha>/docs/CONSTITUTION.md --sponsor <relay sponsor> --sponsor-usdc 1000000   # mini; deployer key from ~/srv/aow-exit/.env.sepolia
HTTPS_PROXY=http://127.0.0.1:7897 python3 scripts/verify-etherscan-v2.py local && python3 scripts/verify-etherscan-v2.py upstream   # mini; key in ~/.config/etherscan/api_key
tsx scripts/testnet-key.ts --out state/relay.env --var RELAY_SPONSOR_KEY; tsx scripts/testnet-fund.ts --to <sponsor> --eth 0.01   # mini
tsx scripts/testnet-governance.ts --voting 120 --grace 120 | --execute <id> --data <proposalData> | --status <id>   # testnet-only periods; restore 21600/21600 at the end
ZERO_ONE_LIVE_DEPLOYMENT=deployments/base-sepolia.json npm run scenarios          # A-J on Base Sepolia: a fresh DAO per scenario, real-time waits (evidence/testnet/scenarios-A-J-*.log, scenario-daos/)
ZERO_ONE_LIVE_DEPLOYMENT=deployments/base-sepolia.json tsx scenarios/testnet-corner-cases.ts   # TESTNET_PLAN rows on fresh DAOs
tsx relay/cold-start.ts --beacon https://zero-one-beacon.vercel.app --host mini|main   # README + relay only (T1 and T0)
tsx relay/corner-cases-relay.ts --beacon https://zero-one-beacon.vercel.app           # relay / adapter / beacon rows
npm run beacon:build -- --deployment deployments/base-sepolia.json --origin https://zero-one-beacon.vercel.app --out beacon/public-base-sepolia && npm run beacon:validate -- --deployment deployments/base-sepolia.json --out beacon/public-base-sepolia && tsx beacon/scripts/vercel.ts --out beacon/public-base-sepolia
```
Relay verbs: join, deposit, task, deliver, propose (template + params: ONE signed intent over the CREATE2 TemplateFactory), vote (the relay waits one block after a fresh submission), execute (explicit 5,000,000 gas), ragequit, plus work (submitTask + sponsor in one transaction) and confirm. No sponsor verb. Every failure is a JSON reason with the decoded custom error. Latest evidence: `evidence/relay-e2e-mirror-2026-09-08-one-intent-propose.log`.
Stack: vendored Baal (Moloch v3) 1.2.18 + Safe, NavShareToken (non-transferable, no locks), DepositShaman (USDC at NAV; 1 USDC -> 1e18 shares while empty), WorkManager (rewards in shares, verifier != proposer), Constitution (immutable keccak256 of docs/CONSTITUTION.md), proposal-contract templates Payment / Strategy / Project / Config owned by the Safe and deployed at CREATE2 addresses by the TemplateFactory (docs/TEMPLATES.md; builder `src/proposals.ts`), MockDex (mirror venue), ZeroOneIntentAccount (EIP-7702, bound to the factory). No founder stream or allocation: the founder is an ordinary member (50 USDC genesis deposit -> 50e18 shares, then diluted at NAV). Settlement: USDC on Base (mirror: 6-dec USDC-mock). Reused from `../agent-only-wallet/exit` per CLAUDE.md. Latest evidence: `evidence/mirror-scenarios-A-J-2026-09-08-create2-factory.log`.

## Phase 4 + 5: ledger, pool TWAP, pre-mainnet audit fixes (docs/SECURITY_AUDIT.md, decision.md phase 5 rulings)
Deposits pause while an open proposal contract still holds a non-USDC asset (a later vote settles it and they resume); dust on the Safe never pauses them; exit is pro-rata of the Safe only.
Deposit NAV = Safe USDC + open-instance USDC, priced against shares + the rewardShares of Active tasks; the Uniswap venue prices and bounds every swap on the pool's own 30-minute TWAP; `baalGas <= 8,000,000`; retention sums positive per-account balance deficits since votingStarts; a same-account return restores retention, and another account's deposit cannot mask an exit.
T0 (custodial-lite): the relay operator can delay or drop your intents; anything you cannot afford to lose goes through T1. Its secret is every T0 key, and a pass needs 128 bits of entropy.
Local acceptance: `npm run scenarios`, `npm run e2e:relay`, `FORK_RPC=https://mainnet.base.org npm run scenario:K`, the flipped tests under `evidence/audit/`, `python3 scripts/phase4-static-check.py`. Receipts: `evidence/phase4/`, `evidence/phase5/`.
