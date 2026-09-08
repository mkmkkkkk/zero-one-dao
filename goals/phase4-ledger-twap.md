# Zero One DAO — phase 4: TreasuryLedger + TWAP venue (decision.md "phase 4 rulings", 2026-09-09)

Red-line clarification: contracts and mirror/testnet only; no Base mainnet transaction; "USDC", "payment", "treasury" are
contract names. Never construct any rm command; never commit .env/keys/state; git email yangzk01@gmail.com; do not touch
docs/CONSTITUTION.md or the principle in CLAUDE.md. Design authority is Fable: the rulings below are final; anything not
covered goes into decision.md "phase 4 designQuestions" as provisional, not silently into code.

Repo: ~/srv/zero-one-dao on this Mac mini. `git fetch origin && git checkout -b phase4-ledger-twap origin/main` first.
Read decision.md (phase 3 + phase 4 sections), docs/DESIGN.md, docs/PARAMETERS.md, docs/TEMPLATES.md, contracts/*.sol.
A push from your side is not possible; leave the branch committed locally with `git log` clean; the orchestrator pushes.

## GOAL
1. `contracts/TreasuryLedger.sol`: Safe-owned, no admin, immutable safe + settlement. `open()` / `close()` callable only by
   contracts deployed by the TemplateFactory (verify via the factory's record, not msg.sender trust) and only from their
   onlySafe paths: ProposalBase.start() calls open(), end()/stop()/migrate() call close(). Append-only `assets` set:
   a Strategy instance registers its `asset` on open(). Views: `openInstances()`, `depositTreasury()` = Safe settlement +
   Σ settlement of open instances, `settled()` = no open instance holds its asset and the Safe holds 0 of every registered
   asset. Bound the loop by the active set only; a spam instance that never passed a vote must not appear.
2. `DepositShaman`: shares = amount × totalShares / ledger.depositTreasury(); revert `TreasuryNotSettled` when
   !ledger.settled(). Empty-treasury rule unchanged (1 USDC → 1e18 shares when totalShares == 0). Genesis path unchanged.
3. `UniswapV3Venue`: price() = 30-minute TWAP from pool.observe() (tick → price, settlement per assetUnit); buy/sell require
   output ≥ TWAP-implied output × (10_000 − slippageBps) / 10_000 in addition to the existing exact-balance checks; the
   constructor reverts if observe() over the window fails (cardinality). MockDex gains nothing new (mirror keeps a settable
   price), but scenario K on the fork must prove: a flash-swap that moves slot0 by >20% within the same block does not change
   price() and makes run() revert on the bound, and after the manipulation is undone run() succeeds.
4. Mirror scenarios: new scenario L on anvil proving hole 1 is closed: (a) Strategy with 100k budget passes → NAV for deposits
   stays at pre-budget value (instance USDC counted); (b) after stop() returns WETH-mock to the Safe, a deposit reverts
   `TreasuryNotSettled`; (c) after a Payment-style vote sells/returns settlement so the Safe holds only USDC, the same deposit
   succeeds at the new NAV; (d) deposit + ragequit in one transaction (a contract doing both) nets exactly zero USDC while the
   Safe holds only USDC. Existing A–J, K stay green; update scenario expectations only where the ruling changes them.
5. Docs: DESIGN.md §6b (three lines on capital) + a §6c "settlement rule" of at most eight lines; PARAMETERS.md new
   IMMUTABLE lines (ledger, TWAP window 30 min, refusal); TEMPLATES.md (open/close on the lifecycle table); beacon README
   stays ≤ 44 lines: one line "Deposits pause while the treasury holds anything but USDC; exit is pro-rata of the Safe."
   RELAY.md/relay: decode `TreasuryNotSettled` and expose `settled` + `depositTreasury` on /state.json and /me.

## ACCEPTANCE (the reviewer runs these)
- `npm run scenarios` green including L; `npm run e2e:relay` green; scenario K green with FORK_RPC set, with the flash-swap
  assertions in evidence/phase4/uniswap-twap-fork.log; scenario L receipts in evidence/phase4/ledger-mirror.log.
- `beacon/scripts/validate.ts` passes; README line count printed in evidence/phase4/beacon-validate.log.
- No new owner/admin/pause anywhere (grep receipts in evidence/phase4/no-admin.log: `onlyOwner`, `Ownable`, `pause` absent).
- decision.md "phase 4" section lists every design question; docs updated as in 5.

## NOT AN ANSWER
An oracle contract; valuing non-USDC assets for deposits; deposit cooldowns or caps; a ledger that trusts msg.sender; a
TWAP window configurable by anyone; scenario L that only asserts constants; "fork unavailable" without the three RPCs tried.

## EDGE CASES
Instance that never reaches start() (defeated / actionFailed) is never open. stop() on an instance with zero holdings still
closes it. Two Strategy instances with the same asset register it once. Safe dust of a registered asset (1 wei) blocks
deposits: intended; a Payment/sweep vote clears it. Ledger reads must be pinned reads in scripts (public RPC lag helpers).

## NO PRESCRIBED METHOD / INDEPENDENT REVIEW
Layout yours. Use up to 3 parallel subagents (contracts+L, TWAP+K, relay/docs), integrate, then re-run every acceptance line
from a clean clone of your local branch into a temp dir under ~/srv and paste outputs to evidence/phase4/acceptance-rerun.log.

## GOAL (restated)
Close the two holes with one ledger contract and a TWAP bound, prove both on anvil and on the Base fork, keep everything
else untouched, commit on branch phase4-ledger-twap.
