# Base Sepolia test plan (before any mainnet transaction)

Order: mirror A–J green → deploy to Base Sepolia → relay + beacon on Sepolia → run A–J on Sepolia with real receipts → cold-start agent experience (README only) → corner cases below → report to the user → mainnet.

## Cold-start experience (what a stranger agent does)
1. GET README (≤44 lines) → join (0 shares) → deposit test USDC at NAV → see its shares and NAV in /me.
2. Read open proposals in /proposals.json → vote → watch grace → execute.
3. Propose a Payment/Strategy/Project via template + params → see the deployed contract and code hash → others vote.
4. Claim a task → deliver → verifiers confirm → shares minted.
5. Ragequit → receive pro-rata → /me shows 0 shares.
Every step must work with fetch-only (T0) and self-signed (T1) agents, and every failure must return a readable reason, not a bare revert.

## Corner cases (each gets a receipt: expected vs observed)
Money and shares
- Deposit 0; deposit 1 wei of USDC (6-dec rounding → 0 shares? must revert clearly); deposit when supply==0 but treasury>0 (someone sent USDC directly to the Safe): documented terminal trap → the deploy/genesis order must prevent it; assert the relay refuses to quote.
- Ragequit with 0 shares; ragequit all shares of the last member (treasury fully paid out; DAO empty but alive); ragequit while a proposal is in voting and in grace (allowed); ragequit by a YES voter (verify Baal semantics).
- Treasury holding a second asset (MOCK from a strategy): ragequit pays both only if the asset is in guildTokens; a strategy must return proceeds in USDC or the DAO must add the asset by proposal; test both paths.
Proposals and votes
- Vote after voting ends; vote twice; vote in the block of the submission (the relay must wait one block, direct callers get `TimePointNotDetermined`); `work` with < 1 share (self-sponsor reverts `!sponsor`, no task recorded); propose with < 1 share through the relay (409, no sponsored deployment); the same (template, params, member, salt) proposed twice (second quote finds the existing instance; the proposal must be refused or re-salted); process before grace ends; process twice; proposal whose multicall reverts (actionFailed=true: funds untouched); proposal that funds a contract with a bug that traps funds (stop() must still work; if the template cannot return, that is a template bug → fix).
- Spam: 100 proposals by one member; cost = gas only (offering 0); UI/relay must page.
- minRetention edge: exactly 34% leaves → fails? (boundary), 33.9% → passes.
- Governance config change to absurd values (voting 1 s, grace 0) by vote: allowed by design; document the consequence.
Templates
- Strategy: deadline passed before first run; run() spam by a stranger (must be harmless); MockDex price moves past take-profit and stop; migrate to a contract that is not a template (must be a passed proposal anyway; document).
- Project: tranche with verifiers that never confirm (funds sit; stop() by vote returns them); topUp beyond treasury balance (multicall reverts, actionFailed); amend params mid-tranche.
- Payment: recipient is a contract that reverts on receive (USDC transfer fails → actionFailed, nothing moved).
Relay and adapter
- Replay of a signed intent; intent for another chain id; intent from an address with no code (T0 path); sponsor cap exhausted (clear error, agent can still self-pay); relay down (agents can use the contracts directly; README says how).
Beacon
- state.json includes proposals with states and deadlines; stale snapshot flag; README hash pinned.

## Exit criteria
All rows above have receipts in evidence/testnet/; a stranger agent (fresh key, no repo access) completes the cold-start path twice; PARAMETERS.md reviewed by the user line by line.

## Status on Base Sepolia (2026-09-08; deployment `deployments/base-sepolia.json`, evidence `evidence/testnet/`)
| Step | Result | Evidence |
| --- | --- | --- |
| Deploy + genesis (50 mock USDC -> 50e18 shares) | done from the mini; cost 0.00014 ETH; a first attempt died at `Baal.setUp` (`GS104`) because the public RPC answered from a node behind `Safe.setup` (fixed: settled simulations and reads) | `deploy-base-sepolia-2026-09-08.log`, record `deployments/base-sepolia.json` |
| Source verification (Etherscan V2, chainid 84532) | 12 local + 6 upstream (Baal/Safe singletons, Safe proxy) verified | `verify-base-sepolia-2026-09-08.log`, `deployments/verification-base-sepolia/evidence/` |
| Relay + tunnel + beacon | `https://relay-zero.mkyang.ai` (launchd on the mini), `https://zero-one-beacon.vercel.app` (README 43 lines, validate PASS) | `state/logs/` on the mini; `beacon:validate` output in the commit message |
| Governance 120 s / 120 s (testnet only) | proposal #1 (Config template) submitted and voted at 2026-09-07T23:31Z under 6 h / 6 h; executable 2026-09-08T11:31:34Z; restored to 21600 / 21600 by the final proposal | `governance-120s-proposal-2026-09-08.log`, `governance-*` logs |
| Scenarios A-J on Sepolia (a fresh DAO each, 120 s / 120 s) | batch: A, B, C, D, E, F, I, J PASS; G and H failed on a stale `describe()` read from a lagging RPC node (the receipts show `Unwound` + `Completed`); `describe()` pinned to the head and G, H re-run PASS | `scenarios-A-J-base-sepolia-2026-09-08.log`, `scenarios-G-rerun-*.log`, `scenarios-H-rerun-*.log`, DAO records `scenario-daos/*.json` (failed attempts under `scenario-daos/failed/`) |
| Corner cases on fresh DAOs (money, trap, votes, absurd governance, templates) | 34 rows, all as expected, every row with a receipt; the votes part was re-run after two harness fixes (stale head, lagging getBlock) | `corner-cases-daos-base-sepolia-2026-09-08.log` + `corner-cases-daos-2026-09-08-money-trap-absurd-templates.json`, `corner-cases-daos-votes-rerun-base-sepolia-2026-09-08.log` + `corner-cases-daos-2026-09-08-votes.json`, DAO records `scenario-daos/corner-*.json` |
| Corner cases through the relay (replay, other chain id, undelegated, work/propose below threshold, duplicate instance, spam 100, burst, sponsor cap, beacon) | 11 rows PASS; the 100-proposal run is `*-spam100` (100 accepted in 2,608 s, 0 rate-limit waits; its paging check ran before the beacon stopped shadowing `/proposals.json`), the final run re-checks paging with 5 proposals (total 136, `?limit=10` -> 10, `nextBefore`) | `corner-cases-relay-main-2026-09-08-spam100.log` + `.json`, `corner-cases-relay-main-2026-09-08.log` + `corner-cases-relay-2026-09-08.json` |
| Cold start (README + relay only), mini and main Mac | T1 + T0 paths | `cold-start-mini-*.log`, `cold-start-main-*.log` |

Findings (details in decision.md phase 2c and docs/PARAMETERS.md): a period of 0 is "unchanged" for Baal and the Config
template then reverts `NotApplied` (minimum 1 s; 1 s / 1 s is terminal: the first proposal under it was already Defeated
after one block); `ragequit(0, 0)` is a no-op; a second asset is paid only when named, in ascending address order; a
vote in the submission block reverts `TimePointNotDetermined` (reproduced twice: submit and vote landed in one block);
exactly 34% leaving keeps a proposal alive, 37.7% defeats it; a Payment above the treasury ends `actionFailed` with the
Safe untouched; a strategy whose deadline passed before its first run unwinds on that run; a stop-loss run returns the
proceeds; the zero-supply trap is terminal and the relay reports `ZeroShares` without a transaction; an ERC-20 Payment
cannot be reverted by its recipient. Relay: a second proposal for an instance is refused (409), `/proposals.json` pages,
a burst is bounded by the 8-deep queue (503) before the 6/min window (429) on a ~10 s-per-request public RPC, the
sponsor cap answers 503 "send the transaction yourself".

Public-RPC facts that changed code (all in decision.md phase 2c): `sepolia.base.org` caps `eth_getLogs` at 10,000 blocks
(`-32614`), rate-limits bursts (`over rate limit`), and answers from nodes that lag a receipt by seconds. The relay index
now scans logs incrementally in 9,000-block chunks, batches reads through Multicall3, falls back to publicnode / drpc /
tenderly, and every script pins reads to a block it has seen.
