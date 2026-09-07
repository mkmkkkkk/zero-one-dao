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
stop:     [ instance.stop() ]                 -> everything back to the Safe   stopCalls()
migrate:  [ old.migrate(new), new.start() ]   -> everything to the new voted contract   migrateCalls()
```

Common surface (`IProposalContract`): `describe()` returns `(template, paramsHash, operator, budget,
deadline, status)`; status is `Pending | Running | Complete | Stopped | Migrated`. `budget` is the
settlement (USDC, 6 decimals) the treasury committed (funding + topUps). Immutables per instance: `safe`,
`settlement`, `operator` (= the proposer: the `member` argument of the factory deployment).

## 1. Payment (`PaymentProposal`)
- params: `address[] recipients`, `uint256[] amounts` (same length, non-zero); `budget = sum(amounts)`.
- `start()`: transfers each amount once, returns any leftover to the Safe, ends `Complete`.
- operator role: none. `amend` / `topUp` only while `Pending` (amend replaces the list and resets budget to its sum).
- Use for: grants, one-off payments, refunds.

## 2. Strategy (`StrategyProposal`)
- params: `address venue`, `address asset`, `uint256 budget`, `Rule rule` with
  `maxPerRun` (settlement units bought per run), `minInterval` (seconds between runs), `deadline` (unix, must
  be in the future), `takeProfitBps` (0 = off), `stopLossBps` (0 = off, < 10000). Mirror venue: `MockDex`
  (constant price, anyone may move it); mainnet venues are named here and must expose
  `price() / buy(settlementIn) / sell(assetIn)` (`IStrategyVenue`).
- `run()` — anyone, any time (no keeper can hold it hostage). Coded rule, in order:
  1. `now >= deadline` → sell all asset, return all settlement to the Safe, `Complete`.
  2. `now < lastRun + minInterval` → `TooSoon`.
  3. `value = settlement held + asset held × price`; `takeProfit` and `value >= budget × (1 + tp)` or
     `stopLoss` and `value <= budget × (1 - sl)` → unwind, return, `Complete`.
  4. otherwise buy the asset with `min(maxPerRun, settlement held)`.
- `stop()` / `migrate(new)` (Safe only): move the raw holdings (every settlement unit and every asset unit)
  to the Safe / to `new` without calling the venue, so a dead venue can never trap funds; unwinding on the
  venue is `run()`'s job before the deadline. `new.start()` requires `new` to hold at least its own `budget`
  in settlement unless it already holds the asset (a migrated position); an asset that lands in the Safe is
  sold or added to guild assets by a later proposal.
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
- `end()` — anyone after `deadline`: unreleased tranches return to the Safe, `Complete`. When the last
  tranche is released the project is `Complete` and anything left (unallocated money, proceeds sent to the
  contract) returns to the Safe.
- `topUp(amount)` (Safe only) records money without a schedule; `amend(abi.encode(Tranche[], deadline))`
  (Safe only) cancels every unreleased tranche, installs the new list (must fit what is held) and releases any
  Date tranche already due. To raise a budget, vote both in one multicall (scenario I).
- `stop()` (Safe only): everything held returns to the Safe, `Stopped`.
- Views: `trancheCount()`, `tranche(i)` → `(plan, state{released, cancelled, confirmations})`, `unreleased()`, `released()`.

## 4. Work (`WorkManager`, not a template instance)
- Unchanged: `WorkManager.submitTask(verifiers, threshold, rewardShares, expiration, details)` records the
  task and submits the Baal proposal that activates it; verifier ≠ proposer enforced there; reward in shares
  minted at the confirmation threshold (DESIGN.md §5, scenarios E and F). Through the relay (`work`, op 6)
  the member's intent account calls `submitTask` and then `Baal.sponsorProposal` in the same transaction
  (ruling 4), so the proposal enters voting at once; a member below sponsorThreshold gets `!sponsor`.

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
