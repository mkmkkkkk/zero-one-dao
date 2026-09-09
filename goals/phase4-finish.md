# Zero One DAO — phase 4, finish it: TreasuryLedger + TWAP price reference (continuation of goals/phase4-ledger-twap.md)

Red-line clarification: our own repo, local anvil and a local anvil fork of Base only; no public-network transaction.
"USDC", "payment", "treasury" are contract names. Never construct any rm command; never commit .env/keys/state; git email
yangzk01@gmail.com. Do not touch docs/CONSTITUTION.md or the CLAUDE.md principle. Rulings in decision.md "phase 4" are final.

Repo: this checkout (~/srv/zero-one-phase4) is a git worktree on branch phase4-ledger-twap; commit 77e2093 "WIP phase 4" holds
the partial work of the previous run (ledger wiring chosen: factory creates an immutable ledger in its constructor and instance
identity is verified against the factory record; no admin). Continue from it; do not start over. Another audit task runs in
~/srv/zero-one-dao on its own branch: do not touch that directory.

## GOAL
Everything in goals/phase4-ledger-twap.md, complete and green. Precisely:
1. TreasuryLedger + DepositShaman pricing on ledger.depositTreasury(), refusal `TreasuryNotSettled` while any open instance
   holds its asset or the Safe holds a registered asset; open() in start(), close() in end/stop/migrate; spam instances never
   in the active set.
2. UniswapV3Venue price reference = the pool's 30-minute time-weighted average (pool.observe); buy/sell revert when output
   < TWAP-implied output × (10_000 − slippageBps) / 10_000; constructor refuses pools that cannot serve the window.
   Robustness test on the Base fork (scenario K): a large same-block swap that moves the spot price by more than 20% leaves
   price() unchanged and makes run() revert on the bound; after the pool returns to its prior state run() succeeds.
3. Scenario L on anvil (deposit NAV with an open Strategy budget; refusal after stop() returns the asset; success after the
   Safe holds only USDC again; same-transaction deposit + ragequit nets zero while the Safe holds only USDC).
4. Docs + relay as listed in the original goal (DESIGN §6c ≤ 8 lines, PARAMETERS IMMUTABLE lines, TEMPLATES lifecycle,
   README ≤ 44 lines with the one settlement line, relay decodes TreasuryNotSettled and exposes settled/depositTreasury).

## ACCEPTANCE (reviewer runs these)
`npm run scenarios` green incl. L; `npm run e2e:relay` green; K green with FORK_RPC (evidence/phase4/uniswap-twap-fork.log);
evidence/phase4/ledger-mirror.log; beacon validate log with README line count; evidence/phase4/no-admin.log (grep receipts for
the new contracts); decision.md phase 4 designQuestions; clean-clone re-run pasted to evidence/phase4/acceptance-rerun.log;
branch phase4-ledger-twap committed (no push possible from your side; the orchestrator pushes).

## FAILURE IS NOT AN OUTCOME
The previous run stopped when one subtask was interrupted. This run does not stop: if a subagent is interrupted, do that part
yourself with plain engineering language; if the fork RPC fails, try https://mainnet.base.org, https://base-rpc.publicnode.com,
https://base.drpc.org in turn; if a test is red, fix the code or the test until it is green and say which. "Blocked" is
acceptable only with three different methods tried and each exact error pasted. Partial delivery is not delivery.

## NOT AN ANSWER
An oracle contract; valuing non-USDC assets for deposits; deposit cooldowns or caps; a ledger trusting msg.sender; a TWAP
window anyone can change; scenario L asserting constants; a K that skips the fork.
