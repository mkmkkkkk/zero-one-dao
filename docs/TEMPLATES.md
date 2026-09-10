# Zero One DAO — proposal-contract templates (for agents)

A proposal is a contract (DESIGN.md §2, §7; constitution Art. II). You do not hand-write one: pick a
template, give it parameters, and the `TemplateFactory` (CREATE2; decision.md phase 2b ruling 2) puts
the instance at an address that is a pure function of (template id, `abi.encode(params)`, you as
operator, a salt): `factory.predict` / `factory.deploy(template, params, member, salt)` (idempotent),
`factory.proposalData(template, params, instance)` builds the voted multicall on-chain, and
`factory.quote(...)` (eth_call) dry-runs all of it. Template ids: 0 Payment, 1 Strategy, 2 Project,
3 Config. The builder (`src/proposals.ts`) deploys through the factory, checks that the contract's
`paramsHash` equals `keccak256(abi.encode(params))`, records the runtime code hash, asserts the
factory's `proposalData` equals its own multicall byte for byte, and submits the Baal proposal whose
multicall the Safe executes if the vote passes. Through the relay a member signs only
`abi.encode(template, params, salt)` and its intent account does the same on-chain (docs/RELAY.md):

```
[ USDC.transfer(instance, budget) ,  instance.start() ]        (Payment, Strategy, Project)
[ Baal.setGovernanceConfig(params),  instance.start() ]        (Config)
```

The proposal details carry `{template, contract, compiler, instance, operator, budget, deadline, params,
paramsHash, codeHash, salt}`. Voters read the code (source-verified on mainnet), compare hashes, and vote.
Pass: the Safe funds and starts the instance in one transaction. Fail: nothing moves; the instance stays
`Pending` and empty forever. `processProposal` must be sent with an explicit gas limit (Baal swallows an
action failure, so a gas estimate can be too low; the mirror uses 5,000,000).

Every instance is owned by the Safe. `topUp(amount)`, `amend(params)`, `stop()` and `migrate(newContract)`
revert for anyone else (`OnlySafe`), so they happen only through a later passed proposal (Art. IV.3):

```
topUp:    [ USDC.transfer(instance, amount), instance.topUp(amount) ]          topUpCalls()
amend:    [ instance.amend(abi.encode(newParams)) ]                            amendCalls()
stop:     [ instance.stop() ]                 -> settlement back to the Safe (a Strategy keeps its asset)   stopCalls()
unwind:   [ strategy.unwind() ]               -> stopped Strategy sells its asset on the venue, closes   unwindCalls()
          [ strategy.stop(), strategy.unwind() ]  in one vote                                stopAndUnwindCalls()
migrate:  [ old.migrate(new), new.start() ]   -> everything to the new voted contract   migrateCalls()
```

Common surface (`IProposalContract`): `describe()` returns `(template, paramsHash, operator, budget,
deadline, status)`; status is `Pending | Running | Complete | Stopped | Migrated`. `budget` is the
settlement (USDC, 6 decimals) the treasury committed (funding + topUps). Immutables per instance: `safe`,
`settlement`, `operator` (= the proposer: the `member` argument of the factory deployment).


## Ledger lifecycle
| Lifecycle path | TreasuryLedger effect |
|---|---|
| Factory deployment, defeated vote, action-failed start | Never open; no NAV entry or asset registration |
| Safe `start()` | `open()` checks the factory record; Strategy registers its asset once |
| Instant Payment/Config completion | Open and `close()` atomically in the voted start |
| Strategy `run()` completion; Project last release or `end()` | `close()` after return to the Safe; existing permissionless completion retained (phase 4 designQuestions) |
| Safe `stop()` on a Payment/Project/Config, or on a Strategy holding no asset | `close()` after returning holdings |
| Safe `stop()` on a Strategy holding its asset | Settlement back to the Safe, asset stays inside, instance stays **open** (Stopped): deposits paused |
| Safe `unwind()` on a stopped, open Strategy | Sells the asset on the venue at the rule's `slippageBps`, proceeds to the Safe, `close()` |
| Safe `migrate(new)` (Running, or Stopped-and-open) and `new.start()` | Old instance closes; factory-recorded successor opens on start (raw holdings move, no venue call) |

Ledger NAV includes USDC held by every open instance. Deposits require that no open instance holds its
asset; balances of the Safe or of closed instances are never consulted (dust on the Safe is shared by
exit only). A stopped Strategy therefore pauses deposits until a later `unwind()` or `migrate()` vote;
exits remain pro-rata of the Safe only.

## 1. Payment (`PaymentProposal`)
- params: `address[] recipients`, `uint256[] amounts` (same length, non-zero); `budget = sum(amounts)`.
- `start()`: transfers each amount once, returns any leftover to the Safe, ends `Complete`.
- operator role: none. `amend` / `topUp` only while `Pending` (amend replaces the list and resets budget to its sum).
- Use for: grants, one-off payments, refunds.

## 2. Strategy (`StrategyProposal`)
- params: `address venue`, `address asset`, `uint256 budget`, `Rule rule` with
  `maxPerRun` (settlement units bought per run), `minInterval` (seconds between runs), `deadline` (unix, must
  be in the future), `takeProfitBps` (0 = off), `stopLossBps` (0 = off, < 10000), `slippageBps` (0..10000). Mirror venue: `MockDex`
  (constant price, anyone may move it); mainnet venues are named here and must expose
  `price() / buy(settlementIn, slippageBps) / sell(assetIn, slippageBps)` (`IStrategyVenue`).
- `run()` — anyone, any time (no keeper can hold it hostage). Coded rule, in order:
  1. `now >= deadline` → sell all asset, return all settlement to the Safe, `Complete`.
  2. `now < lastRun + minInterval` → `TooSoon`.
  3. `value = settlement held + asset held × price`; `takeProfit` and `value >= budget × (1 + tp)` or
     `stopLoss` and `value <= budget × (1 - sl)` → unwind, return, `Complete`.
  4. otherwise buy the asset with `min(maxPerRun, settlement held)`.
- `stop()` (Safe only): returns every settlement unit to the Safe without calling the venue and keeps the
  asset inside; the instance is `Stopped` and stays open in the ledger (deposits paused) until a later vote
  `unwind()`s it (Safe only: sells every asset unit on the venue at the rule's `slippageBps`, returns the
  proceeds, closes the ledger entry; `stop()` + `unwind()` fit one multicall) or `migrate(new)`s it (Safe
  only; allowed while Running or while Stopped-and-open): every remaining settlement and asset unit moves
  to `new` without calling the venue, so a dead venue can never trap funds. `new.start()` requires `new` to
  hold at least its own `budget` in settlement unless it already holds the asset (a migrated position).
- `amend(abi.encode(Rule))` replaces the rule (venue, asset, budget unchanged); `topUp` raises `budget`
  (the take-profit / stop-loss reference).
- operator role: leads by default; no special power. Views: `value()`, `rule()`, `runs()`, `lastRun()`.

## 3. Project (`ProjectProposal`)
- params: `Tranche[] tranches`, `uint256 deadline` (0 = none). Tranche: `amount`, `releaseType`
  (`0 = Date`, `1 = Verifiers`), `releaseAt` (Date only; 0 = at once), `verifiers[]` and `threshold`
  (Verifiers only; distinct, non-zero, none equal to the operator, `1 <= threshold <= verifiers.length`).
  `budget = sum(amounts)`. A tranche naming the proposer as verifier cannot be deployed (`VerifierIsOperator`).
- `start()`: requires the budget to be held; releases every Date tranche already due (so "first tranche on
  vote" = Date with `releaseAt 0`).
- `release(i)` — anyone, when a Date tranche's date has come. `confirm(i)` — a named verifier of a
  Verifiers tranche, once; at `threshold` the tranche is paid to the operator.
- `end()` — anyone after `deadline`: unreleased tranches return to the Safe, `Complete`. Once the deadline
  has come `release(i)` and `confirm(i)` revert `DeadlinePassed` (only `end()` applies: a due-but-unreleased
  tranche always returns to the Safe, no transaction race) and `start()` refuses (the funding action fails
  atomically). When the last tranche is released the project is `Complete` and anything left (unallocated
  money, proceeds sent to the contract) returns to the Safe.
- `topUp(amount)` (Safe only) records money without a schedule; `amend(abi.encode(Tranche[], deadline))`
  (Safe only) cancels every unreleased tranche, installs the new list (must fit what is held) and releases any
  Date tranche already due. To raise a budget, vote both in one multicall (scenario I).
- `stop()` (Safe only): everything held returns to the Safe, `Stopped`.
- Views: `trancheCount()`, `tranche(i)` → `(plan, state{released, cancelled, confirmations})`, `unreleased()`, `released()`.

## 4. Work (`WorkManager`, not a template instance)
- `WorkManager.submitTask(verifiers, threshold, rewardShares, expiration, details)` records the task and
  submits the Baal proposal that activates it (baalGas 500,000); verifier ≠ proposer enforced there; reward
  in shares minted at the confirmation threshold (DESIGN.md §5, scenarios E and F). Through the relay
  (`work`, op 6) the member's intent account calls `submitTask` and then `Baal.sponsorProposal` in the same
  transaction (ruling 4), so the proposal enters voting at once; a member below sponsorThreshold gets `!sponsor`.
- `expiration` is also the task's expiration: `confirm()` reverts after it, anyone may `expireTask()`, and
  `activeRewardShares()` (the share liability DepositShaman prices into deposits) stops counting it. A claim
  that delivers nothing for `CLAIM_TIMEOUT` (7 d) lapses; the next `claim()` takes the task over.

## 5. Config (`ConfigProposal`)
- params: `Config{votingPeriod, gracePeriod, proposalOffering, quorumPercent, sponsorThreshold, minRetentionPercent}`.
- Baal.setGovernanceConfig is callable only by the Safe or a governor shaman, so the Safe applies the
  config itself in the multicall and `start()` reads every value back and reverts (`NotApplied`) unless
  Baal holds exactly the voted values, failing the whole action atomically. `budget = 0`; `topUp` reverts
  `NotApplicable`; `amend` only while `Pending`.

## Amend payloads (`encodeAmendParams` in `src/proposals.ts`)
| template | `amend(bytes)` decodes | note |
|---|---|---|
| Payment | `(address[] recipients, uint256[] amounts)` | Pending only |
| Strategy | `(Rule)` | Running or Pending |
| Project | `(Tranche[] tranches, uint256 deadline)` | cancels unreleased tranches, keeps released |
| Config | `(Config)` | Pending only |

`paramsHash` after an amend is `keccak256` of the amend payload (the latest voted parameters), except for
the Strategy where it is `keccak256(abi.encode(venue, asset, budget, rule))` with the new rule.

## Phase 4: Uniswap v3 Strategy venue
`UniswapV3Venue` implements `IStrategyVenue` using an immutable pair and fee, SwapRouter02 and
QuoterV2. The dependency has no owner, admin or mutable configuration. The Strategy remains Safe-owned;
its `Rule` includes voted `slippageBps`, and holdings stay in the Strategy. `price()` uses the pool's
30-minute TWAP ticks, normalized to settlement per whole asset token. The constructor refuses a pool
whose observation history cannot serve that fixed window. Both buy and sell must meet TWAP-implied
output × (10,000 − slippageBps) / 10,000, as well as the existing quote and exact input/output checks.
A revert rolls the step back. Thin pools can refuse large runs; voters choose `maxPerRun` to split trades.
Approval clears and the adapter stays empty; anyone can sweep its pair-token dust to the immutable Safe.

`stop()` and `migrate()` still move raw USDC + WETH without any venue call. Scenario J continues to
use MockDex; `FORK_RPC=https://mainnet.base.org npm run scenario:K` exclusively broadcasts to a local
Anvil fork and exercises two buys, voted raw stop, voted migration, successor execution, take-profit
and stop-loss sells against published Base Uniswap contracts. No Etherscan verification runs on forks.
The helper checks the router/quoter/factory bytecode and expected read selectors first. K uses 500 fee,
50 bps slippage and 18-decimal WETH; none is a governance cap. The fork logs are the proof of on-chain
checks; the published deployment table alone is not proof that the local fork ran successfully.

This changes Strategy constructor/parameter ABI and factory creation code. Old Sepolia deployments
remain immutable and require their original ABI. Phase 3 builders target freshly deployed factories;
omitting slippage in existing mirror specifications encodes zero. Raw stop/migrate remain compatible
with the common proposal-management surface.
K supplies 2,000,000 gas for `run()` after simulation; this is test transaction gas, not a contract
cap. The first attempt simulated successfully but its automatic-gas stop-loss transaction reverted
(`evidence/phase3/uniswap-v3-fork-red.log`). The explicit-gas rerun records actual gas used; the first
failure's precise EVM trace is unavailable after that owned Anvil was shut down.
