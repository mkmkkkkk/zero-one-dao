# Zero One DAO — hard-to-reverse parameters (confirm each line before mainnet)

Every line is one parameter, its current value in `src/zeroOne.ts` / the contracts, and why. Lines
marked **IMMUTABLE** cannot be changed after deployment by anyone, including a unanimous vote; the
only remedy is a new deployment. Lines marked **BY PROPOSAL** are the initial state and can be
changed later by an ordinary proposal (DESIGN.md §3/§0). Lines marked **DECIDE** have no value yet.

## Chain and identities
- chain = Base (8453). **DECIDE** — Baal, Safe, MultiSend singletons are re-deployed by us (vendored 1.2.18), so no dependency on DAOhaus' canonical addresses.
- founder = the deployer EOA (`FounderStream.founder`). **IMMUTABLE** — the stream can only ever mint to this address; use a key you will hold for 4 years.
- settlement asset (`NavShareToken.settlementToken`). **IMMUTABLE, DECIDE** — defines NAV forever: deposits, exits and task rewards are all priced in it. Mirror uses an 18-decimal TestToken; Base needs a real ERC-20 (USDC 6 dec or WETH 18 dec). Must not be fee-on-transfer or rebasing (DepositShaman reverts on inexact transfers; ragequit assumes balanceOf accounting).
- salt = 1 (Safe/Baal proxy create2 nonces 2 and 3). **IMMUTABLE** — only affects addresses.

## Treasury and governance module
- Safe owners = [Baal], threshold 1, enabled modules = [Baal] only. **IMMUTABLE in practice** — no EOA can sign for the Safe; Baal executes passed proposals through the module path. A proposal could in theory add owners/modules (it is "anything"); by design that is a vote, not a code rule.
- Baal implementation = vendored @daohaus/baal-contracts 1.2.18, minimal proxy via ModuleProxyFactory. **IMMUTABLE** — no upgrade path.
- adminLock = true. **IMMUTABLE** — no admin shaman can ever be added; share/loot pause does not exist anyway (tokens revert on pause), so this closes nothing the design wants open.
- managerLock = false. **BY PROPOSAL (one-way)** — a passed proposal can add another minting shaman or lock managers forever. Left open on purpose: a new WorkManager/DepositShaman version must be installable by vote; members stop a bad one by NO or exit (DESIGN.md §0). Locking it would be a rule in code.
- governorLock = false. **BY PROPOSAL (one-way)** — same reasoning; no governor shaman is installed at genesis, so governance config changes only through proposals.
- trustedForwarder = 0x0. **BY PROPOSAL** — sponsored gas uses the EIP-7702 adapter, not EIP-2771.
- manager shamans at genesis = [FounderStream, DepositShaman, WorkManager], permission 2 each. **BY PROPOSAL** — the only three mint paths (DESIGN.md §2 a/b/c).

## Initial governance config (all BY PROPOSAL via Baal.setGovernanceConfig; scenario D proves it)
- votingPeriod = 21600 s (6 h) — agents poll at least hourly, ≥ 6 chances to see a proposal.
- gracePeriod = 21600 s (6 h) — exit window after the vote closes, before execution.
- proposalOffering = 0 — no ETH tribute to submit.
- quorumPercent = 0 — silence is consent; abuse is stopped by exit, not turnout.
- sponsorThreshold = 1 share (1e18 wei-shares) — anti-spam only. Baal will not accept a threshold above totalShares, and at genesis totalShares = 0: the founder's first sponsorship works ~127 s after genesis (1e24 × t / 126230400 ≥ 1e18).
- minRetentionPercent = 66 — a proposal fails automatically if > 34% of shares exit during vote + grace.

## Share token (NavShareToken)
- name = "Zero One Shares", symbol = "ZERO1", decimals = 18. **IMMUTABLE**.
- non-transferable: transfer / approve / transferFrom always revert. **IMMUTABLE** — shares are weight, not an asset; the only way out is ragequit at NAV.
- votes = balance, self-delegated, timestamp checkpoints; no delegation. **IMMUTABLE**.
- mint / burn callable only by Baal. **IMMUTABLE**.
- no pause, no lock, no cliff, no unvested gate: every share is exitable the moment it exists. **IMMUTABLE** (the design's "owned means exitable").
- NAV fallback: while totalShares = 0 or treasury = 0, one settlement unit mints one share (18-dec scaled). **IMMUTABLE** — needed so work-for-shares and the first deposit function at zero assets (DESIGN.md §6). Trap: if the founder stream has already minted shares and the treasury is still empty, the first depositor's shares sit next to those founder shares at 1:1, so the founder owns a pro-rata slice of that deposit. Mitigation is procedural: make the genesis deposit before or immediately after the first stream claim (the mirror seed does exactly this).
- LootToken exists with zero supply, mint/burn only by Baal, transferable. **IMMUTABLE** — Baal requires a loot token; nothing mints it unless a proposal installs a shaman that does.

## Founder stream (FounderStream)
- totalAmount = 1,000,000 shares (1e24). **IMMUTABLE** — the absolute number is arbitrary; what matters is its ratio to shares minted by deposits and work, which is set by NAV at each mint. On the mirror, 1 h of stream = 28.5 shares next to 1000 shares per 1000 settlement deposited at NAV 1.
- duration = 126,230,400 s (1461 days = 4 years incl. one leap day), linear, no cliff. **IMMUTABLE**.
- startedAt = FounderStream deployment timestamp (genesis). **IMMUTABLE**.
- claim() callable by anyone, mints only to `founder`. **IMMUTABLE**.
- the DAO can stop the stream only by removing the shaman's manager permission by proposal (setShamans([stream],[0])); it cannot redirect it.

## Deposits (DepositShaman)
- open to any address, no membership check. **IMMUTABLE** — "phase 1 agents only" is a constitution clause enforced by votes (DESIGN.md §2). Scenario C's depositor D is a non-member at deposit time.
- shares = amount × totalShares / treasury at the moment of deposit (fallback above); exact-amount transfer required. **IMMUTABLE**.
- deposits go straight to the Safe; no minimum, no maximum, no cap. **IMMUTABLE** by design (§0).

## Work (WorkManager)
- verifier ≠ proposer, proposer = msg.sender of submitTask, enforced at the only entry point. **IMMUTABLE** (DESIGN.md §5, constitution clause 5).
- verifiers cannot claim their own task. **IMMUTABLE**.
- reward is a settlement amount converted to shares at the NAV of the final confirmation, minted only then. **IMMUTABLE**.
- single delivery per round, re-delivery resets confirmations; activate / cancel only by the Safe (i.e. by a passed proposal). **IMMUTABLE**.
- no referral grants in phase 1 (AowReferralRewards is not in the reuse list); adding them later means a new shaman by proposal.

## EIP-7702 adapter (ZeroOneIntentAccount)
- EIP-712 domain name "ZeroOneIntent", version "1", chain-bound; ops 0-9 map to Baal/shaman verbs. **IMMUTABLE** — compiled and deployed on the mirror, but NOT exercised by scenarios A-E (relay is phase 2 of the work order). Re-verify before relying on it.

## Genesis actions (not code, but hard to undo)
- genesis deposit amount by the founder: any value incl. zero (DESIGN.md §6). See the NAV-fallback trap above.
- constitution v2 text is adopted by the founder's first proposal (needs ≥ 1 streamed share to self-sponsor, ~127 s after genesis).
