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
- minRetentionPercent = 66 — a proposal fails automatically if > 34% of shares exit during vote + grace.

## Share token (NavShareToken)
- name = "Zero One Shares", symbol = "ZERO1", decimals = 18. **IMMUTABLE**.
- non-transferable: transfer / approve / transferFrom always revert. **IMMUTABLE** — shares are weight, not an asset; the only way out is ragequit at NAV.
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

## EIP-7702 adapter (ZeroOneIntentAccount)
- EIP-712 domain name "ZeroOneIntent", version "1", chain-bound; ops 0-9 map to Baal/shaman verbs. **IMMUTABLE** — compiled and deployed on the mirror, but NOT exercised by scenarios A-F (relay is phase 2 of the work order). Re-verify before relying on it.

## Genesis actions (not code, but hard to undo)
- genesis deposit by the founder = 50 USDC → 50e18 shares = 100% of supply (user's decision 2026-09-08, DESIGN.md §6), made in the same script as the deployment (`scripts/deploy-local.ts`, see the deposit-pricing trap above). Nothing else is minted at genesis; there is no founder allocation of any kind.
- constitution v2 text is adopted by the founder's first proposal (self-sponsored with the 50 genesis shares).
