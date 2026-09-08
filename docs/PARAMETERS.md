# Zero One DAO — hard-to-reverse parameters (confirm each line before mainnet)

Every line is one parameter, its current value in `src/zeroOne.ts` / the contracts, and why. Lines
marked **IMMUTABLE** cannot be changed after deployment by anyone, including a unanimous vote; the
only remedy is a new deployment. Lines marked **BY PROPOSAL** are the initial state and can be
changed later by an ordinary proposal (DESIGN.md §3/§0). Lines marked **DECIDE** have no value yet.

## Chain and identities
- chain = Base (8453). **DECIDE** — Baal, Safe, MultiSend singletons are re-deployed by us (vendored 1.2.18), so no dependency on DAOhaus' canonical addresses.
- founder = the deployer EOA. **NOT A CONTRACT PARAMETER** — no contract stores or privileges a founder address; the founder is an ordinary member whose only shares come from the 50 USDC genesis deposit and from work paid by vote (DESIGN.md §6). The key matters only as the holder of those shares.
- settlement asset (`NavShareToken.settlementToken`) = USDC on Base, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals; `BASE_USDC` in `src/zeroOne.ts`, documented only, nothing deployed). **IMMUTABLE** — defines NAV forever: deposits and exits are priced in it (task rewards are not, see Work). Mirror uses `TestToken` "USDC-mock" (6 decimals, fixed supply, no admin). USDC is upgradeable and has a blacklist (Circle); a blacklisted Safe could not pay exits — accepted as the user's choice (DESIGN.md §6). Must not be fee-on-transfer or rebasing (DepositShaman reverts on inexact transfers; ragequit assumes balanceOf accounting).
- salt = 1 (Safe/Baal proxy create2 nonces 2 and 3). **IMMUTABLE** — only affects addresses.

## Constitution (Constitution contract, DESIGN.md §10)
- `Constitution.textHash` = keccak256 of the exact bytes of `docs/CONSTITUTION.md` = `0xebc7c39cf14fdc0ac2c028cdba5960ecc4560a314e613b93b4585b62826f2d9a` (computed by `constitutionHash()` in `src/zeroOne.ts` at deploy time and asserted equal on-chain; every scenario boot re-asserts it). **IMMUTABLE** — no setter, no owner, no amendment path (constitution Art. VII). Changing one byte of the text changes the hash; the text file is therefore frozen with the deployment. A new constitution means a new deployment.
- `Constitution.textUrl` = `"docs/CONSTITUTION.md"` (`CONSTITUTION_TEXT_URL` in `src/zeroOne.ts`; mirror value, a repo-relative pointer). **DECIDE** — the mainnet value should be a stable public URL of the exact bytes (the hash, not the URL, is the authority). Written once in the constructor; Solidity strings cannot be `immutable`, and no function writes storage afterwards.

## Treasury and governance module
- Safe owners = [Baal], threshold 1, enabled modules = [Baal] only. **IMMUTABLE in practice** — no EOA can sign for the Safe; Baal executes passed proposals through the module path. A proposal could in theory add owners/modules (it is "anything"); by design that is a vote, not a code rule.
- Baal implementation = vendored @daohaus/baal-contracts 1.2.18, minimal proxy via ModuleProxyFactory. **IMMUTABLE** — no upgrade path.
- adminLock = true. **IMMUTABLE** — no admin shaman can ever be added; share/loot pause does not exist anyway (tokens revert on pause), so this closes nothing the design wants open.
- managerLock = false. **BY PROPOSAL (one-way)** — a passed proposal can add another minting shaman or lock managers forever. Left open on purpose: a new WorkManager/DepositShaman version must be installable by vote; members stop a bad one by NO or exit (DESIGN.md §0). Locking it would be a rule in code.
- governorLock = false. **BY PROPOSAL (one-way)** — same reasoning; no governor shaman is installed at genesis, so governance config changes only through proposals.
- trustedForwarder = 0x0. **BY PROPOSAL** — sponsored gas uses the EIP-7702 adapter, not EIP-2771.
- manager shamans at genesis = [DepositShaman, WorkManager], permission 2 each. **BY PROPOSAL** — the only two mint paths (DESIGN.md §2 a/b); Baal.mintShares is also callable by the Safe, i.e. by a passed proposal. Every scenario boot enumerates ShamanSet logs and asserts exactly this set; scenario F additionally enumerates every mint ever made.

## Initial governance config (all BY PROPOSAL via Baal.setGovernanceConfig; scenario D proves it)
- votingPeriod = 21600 s (6 h) — agents poll at least hourly, ≥ 6 chances to see a proposal.
- gracePeriod = 21600 s (6 h) — exit window after the vote closes, before execution.
- proposalOffering = 0 — no ETH tribute to submit.
- quorumPercent = 0 — silence is consent; abuse is stopped by exit, not turnout.
- sponsorThreshold = 1 share (1e18 wei-shares) — anti-spam only. Baal will not accept a threshold above totalShares, and at genesis totalShares = 0: the founder can sponsor as soon as the genesis deposit (50 USDC → 50e18 shares) is made.
- minRetentionPercent = 66 — a proposal fails automatically if > 34% of shares exit during vote + grace (Base Sepolia corner case: exactly 34% leaving keeps the proposal alive, 37.7% defeats it).
- Baal treats a votingPeriod or gracePeriod of 0 in `setGovernanceConfig` as "unchanged"; the Config template's `start()` then reverts `NotApplied` and the whole action fails (`actionFailed`, nothing applied). The minimum settable period is therefore 1 s, and a 1 s / 1 s DAO is terminal on a 2 s-block chain: no block can carry a vote and `0 yes > 0 no` is false, so nothing passes again, a repair included. Allowed by design; documented consequence (Base Sepolia corner cases `absurd-*`).

## Share token (NavShareToken)
- name = "Zero One Shares", symbol = "ZERO1", decimals = 18. **IMMUTABLE**.
- non-transferable: transfer / approve / transferFrom always revert. **IMMUTABLE** — shares are weight, not an asset; the only way out is ragequit at NAV. Baal accepts `ragequit(0, 0)` as a no-op (nothing burned, nothing paid) and requires the token list in ascending address order (`!order`); an asset other than the settlement is paid only when the member names it (no guildTokens registry in Baal v3).
- votes = balance, self-delegated, timestamp checkpoints; no delegation. **IMMUTABLE**.
- mint / burn callable only by Baal. **IMMUTABLE**.
- no pause, no lock, no cliff, no unvested gate: every share is exitable the moment it exists. **IMMUTABLE** (the design's "owned means exitable").
- deposit pricing (`navSharesFor`): shares = amount × totalSupply / treasury while treasury > 0; while treasury = 0, 1 USDC (1e6) → 1e18 shares. No other fallback. **IMMUTABLE** (DESIGN.md §6). Consequences: (1) the first depositor (the founder's genesis deposit) holds 100% of what exists; (2) trap: if settlement lands in the Safe while totalSupply = 0 (a donation before genesis, or dust left after everyone ragequit), every deposit quotes 0 shares and reverts `ZeroShares`; with no shares nobody can sponsor a proposal, so that state is terminal. Mitigation is procedural: `deployZeroOne` + `genesisDeposit` run in one script (`scripts/deploy-local.ts`; genesisDeposit refuses to run unless supply and treasury are both 0), never pre-fund the Safe.
- LootToken exists with zero supply, mint/burn only by Baal, transferable. **IMMUTABLE** — Baal requires a loot token; nothing mints it unless a proposal installs a shaman that does.

## Deposits (DepositShaman)
- open to any address, no membership check. **IMMUTABLE** — "phase 1 agents only" is a constitution clause enforced by votes (DESIGN.md §2). Scenario C's depositor D is a non-member at deposit time.
- shares = amount × totalShares / treasury at the moment of deposit (treasury = 0: 1 USDC → 1e18 shares, see Share token); exact-amount transfer required. **IMMUTABLE**.
- deposits go straight to the Safe; no minimum, no maximum, no cap. **IMMUTABLE** by design (§0).

## Work (WorkManager)
- verifier ≠ proposer, proposer = msg.sender of submitTask, enforced at the only entry point. **IMMUTABLE** (DESIGN.md §5, constitution clause 5).
- verifiers cannot claim their own task. **IMMUTABLE**.
- reward is a number of shares (`rewardShares`, 18 dec) fixed at `submitTask`, voted as part of the task proposal, and minted exactly on the final confirmation; no NAV or settlement conversion, so tasks work at zero treasury. **IMMUTABLE** (DESIGN.md §5).
- single delivery per round, re-delivery resets confirmations; activate / cancel only by the Safe (i.e. by a passed proposal). **IMMUTABLE**.
- no referral grants in phase 1 (AowReferralRewards is not in the reuse list); adding them later means a new shaman by proposal.

## Proposal-contract templates (DESIGN.md §7; docs/TEMPLATES.md; scenarios D, G-J)
- Per instance, set in the constructor and never changed: `safe` (owner of every instance), `settlement` (USDC), `operator` (= the proposer, the `member` argument of the factory deployment). **IMMUTABLE per instance** — a proposal contract belongs to the Safe from birth; the proposer can never reclaim it.
- TemplateFactory + four deployers (Payment, Strategy, Project, Config): `safe`, `settlement`, `baal` and the four deployer addresses are immutable; instance address = CREATE2(deployer, salt, keccak256(creationCode ‖ abi.encode(safe, settlement, member, params))). `deploy` is permissionless and idempotent (an existing instance is returned); who pays gas changes nothing about the code or the operator. **IMMUTABLE** — the intent account's op 0 is bound to this factory; a new template set means a new factory and a new adapter (both by proposal-free redeploy + members re-joining; decision.md phase 2b ruling 2).
- `start / topUp / amend / stop / migrate` are `onlySafe` in `ProposalBase`. **IMMUTABLE** — the only caller is a passed proposal executed by Baal through the Safe module path (constitution Art. IV.3). Scenarios G, H, I, J assert the proposer's direct calls revert `OnlySafe`.
- Strategy: `venue` and `asset` immutable per instance; the rule (`maxPerRun`, `minInterval`, `deadline`, `takeProfitBps`, `stopLossBps`) and `budget` change only by `amend` / `topUp` (Safe). `run()` is permissionless. `stop()` / `migrate()` move the raw holdings (settlement + asset) without calling the venue (decision.md phase 2a ruling 2; scenario J drains the venue before migrating). **IMMUTABLE per instance**.
- Project: verifiers ≠ operator, distinct, non-zero, `1 <= threshold <= n` enforced in the constructor and in `amend` (the only two entries). **IMMUTABLE**. Tranches are released to the operator only; `end()` after the deadline and the last release return everything else to the Safe.
- Config: applies nothing itself; the Safe calls `Baal.setGovernanceConfig` in the same multicall and `start()` verifies the six values (`NotApplied` reverts the whole action). No governor shaman is installed (governorLock false, see above).
- MockDex: mirror only, constant price settable by anyone; never deployed to mainnet. Strategy venues on mainnet are named in the proposal parameters and must implement `IStrategyVenue`.
- Execution gas: `Baal.processProposal` marks `actionFailed` instead of reverting when the voted multicall runs out of gas, and `eth_estimateGas` can therefore return a limit that is too small for the action. The mirror sends `processProposal` with an explicit 5,000,000 gas limit (`PROCESS_GAS` in `scenarios/lib.ts`); the relay's `execute` verb must do the same. **PROCEDURAL**.
- Testnet settlement: `MockUSDC` (6 decimals, `mint` restricted to the deployer) on Base Sepolia only; the relay faucet draws from the sponsor's minted balance. Never on mainnet (docs/MAINNET_PLAN.md).

## EIP-7702 adapter (ZeroOneIntentAccount)
- EIP-712 domain name "ZeroOneIntent", version "1", chain-bound; ops 0, 2..9 map to Baal/shaman verbs (op 1 "sponsor" removed: op 6 `work` calls `submitTask` then `sponsorProposal` in one transaction; op 0 `propose` signs `abi.encode(template, params, salt)` and the account deploys through the TemplateFactory if needed and submits the factory-built fund+start multicall). **IMMUTABLE** — exercised end to end by `npm run e2e:relay`.

## Genesis actions (not code, but hard to undo)
- genesis deposit by the founder = 50 USDC → 50e18 shares = 100% of supply (user's decision 2026-09-08, DESIGN.md §6), made in the same script as the deployment (`scripts/deploy-local.ts`, see the deposit-pricing trap above). Nothing else is minted at genesis; there is no founder allocation of any kind.
- constitution v2 text is adopted by the founder's first proposal (self-sponsored with the 50 genesis shares).

## Phase 3 Uniswap v3 venue inputs
- SwapRouter02 on Base = `0x2626664c2603336E57B271c5C0b26F421741e481`. **DECIDE** — immutable adapter constructor dependency, no owner/admin. Published by [Uniswap](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments); scenario K checks code and `factory()` / `WETH9()` before swaps.
- QuoterV2 on Base = `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`. **DECIDE** — immutable constructor dependency; K checks code and selectors, and real swaps exercise `quoteExactInputSingle`.
- UniswapV3Factory on Base = `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`. **DECIDE** — immutable constructor dependency; K checks code, `feeAmountTickSpacing(500)` and the existing pair pool.
- Asset for the fork proof = WETH `0x4200000000000000000000000000000000000006` (18 decimals), settlement = Base USDC proxy (6 decimals, read through proxy). **DECIDE** — pair immutable per adapter; Strategy valuation divides by `venue.assetUnit()`, not a hard-coded six-decimal unit.
- Pool fee = 500 (0.05%) for K. **DECIDE** — immutable per adapter instance, no setter; another fee requires another voted venue/Strategy. This is a demonstration input, not a protocol trading cap.
- `StrategyProposal.Rule.slippageBps` = 50 in K. **DECIDE / BY PROPOSAL** — tolerance from a same-transaction QuoterV2 quote to execution, valid range 0–10000 bps. `amend` by Safe changes it; 0 is exact quote output. It does not protect a prior off-chain quote, and slot0 valuation is spot, not an independent oracle.
- Adapter `safe` = DAO treasury. **DECIDE** — immutable recovery sink; permissionless `sweep()` returns unsolicited pair-token dust only to this Safe. Each swap requires no preexisting pair balances, asserts exact transfer deltas, clears router approval, and finishes empty. A failed swap reverts atomically; `stop`/`migrate` remain venue-free.
- Phase 3 Strategy ABI adds `slippageBps` and venue `assetUnit` / two-argument `buy` / `sell`. Existing deployed Sepolia factory and Strategy contracts retain their old ABI; this code's new factory must be deployed for the new template. The TypeScript builder encodes omitted mirror tolerance as zero; it is not an upgrade of the old deployment.
