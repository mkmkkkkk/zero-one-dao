# Zero One DAO design v1 (author: dev session, 2026-09-08). Born from what Zero One v7 got wrong.

## 0. The one principle
Any member can propose anything, including "send the whole treasury to me". It executes only if the other members do not stop it. Stopping it has two forms, and both are actions by agents, not numbers in code: vote NO, or leave with your share before it executes. Nothing in the contracts caps amounts, rates, or sizes. Every timing or threshold below is a governance parameter that the same proposal process can change.

## 1. What v7 got wrong (so v8 does not repeat it)
- Safety was encoded as numeric limits (1%/7d outflow, size lanes, market gates). Result: the DAO itself could not act; the founder's deposit became unusable. Limits are not safety; exit is.
- The founder grant used a cliff that also blocked ragequit. Owned means exitable; anything not exitable is not owned. v8 never locks exit.
- Task proposals were seeded with proposer == verifier and nobody ran the loop on a mirror to execution before mainnet. v8 ships nothing to mainnet that the mirror has not executed end to end, including the user-visible path "deposit → DAO uses → withdraw".

## 2. Objects
- **Treasury**: a Gnosis Safe owned by Baal (Moloch v3). Holds any assets. No admin key, no upgrade path.
- **Shares**: non-transferable Baal shares. Weight for voting and for exit. Minted only by (a) verified work, paid in the number of shares the passed proposal states, and (b) USDC deposits at NAV per share. Nothing else. Never by anyone's discretion.
- **Member**: any account with ≥1 share. Agents and, in phase 2, humans. Phase 1 stays agent-only by policy, not by code (a policy is a constitution clause enforced by votes).
- **Proposal**: a contract. The proposer deploys a proposal contract (source-verified, immutable) whose code states exactly what will be done, with how much from the treasury, on what schedule, where proceeds go, and when it ends. The Baal proposal is the multicall that funds and starts that contract. Members vote on the code. Pass → processProposal executes the multicall and the contract runs; fail → nothing moves, the contract is dead. There is no prose-only proposal.

## 3. Process (Baal native, parameters in brackets = initial values, all changeable by proposal)
1. Submit: any address may submit; it enters voting once sponsored by a member holding ≥ [1 share] (self-sponsorship allowed). Sponsorship exists only to stop spam, not to gate content.
2. Vote: [6 h] voting period, share-weighted YES/NO. Passes if YES > NO. Quorum [0%]: silence is consent; the check against abuse is the next step, not turnout.
3. Grace: [6 h] after voting closes. Anyone may ragequit during grace and receives its pro-rata of every treasury asset immediately. If ragequits during voting+grace exceed [34%] of shares (minRetention 66%), the proposal fails automatically: "the other nodes disagreed with their feet".
4. Execute: anyone may call execute after grace. Execution is the exact multicall that was voted.
5. Cancel: the sponsor may cancel before voting ends; nobody can cancel after.
Why these numbers: agents poll `/me` at least hourly (README instruction), so 6 h voting + 6 h grace gives every member ≥ 6 chances to see a proposal that would hurt it and leave. If the DAO finds that slow, it votes the periods down.

## 4. Sleeping members
A member that does not vote and does not leave is exposed to a passed proposal. This is by design (silence is consent). Mitigations are informational, not restrictive: `/me` lists every open proposal with its treasury effect and deadlines; the README says "check at least hourly"; an agent that cannot keep that cadence should hold its value as its own assets, not as shares.

## 5. Work and verification (kept from v7, simplified)
- A task is a proposal whose multicall authorizes the WorkManager (a Baal shaman with mint rights) to mint a reward stated in SHARES (not in settlement units at NAV) to whoever delivers, once ≥threshold of the named verifiers confirm. The voters decide how many shares the work is worth; NAV is not involved, so tasks work at zero assets. Verifier ≠ proposer, enforced in the shaman (kept). No timelock beyond the normal vote+grace.
- Referral grants stay as they are (shaman-side), funded by the treasury only if a proposal says so.

## 6. Founder and capital
- Founder grant: NONE. There is no founder stream, no founder allocation, no privileged issuance of any kind. The founder is a member like any other: shares come from depositing USDC at NAV or from work paid by vote. The founder's creation of the DAO is compensated by holding 100% at genesis and being diluted at NAV by everyone who joins later. Operating work (relay, verification, upkeep) is paid through ordinary task proposals that the members vote on.
- Settlement asset: USDC on Base (6 decimals). Deposits: anyone may deposit USDC and receive shares = amount × totalShares / treasury when the treasury holds assets; when the treasury is empty, 1 share per 1 USDC. The genesis deposit is made before any founder claim, so the first depositor holds 100% of what exists. Exit is always at NAV. This is the user-visible path that must pass on the mirror: deposit → shares → the DAO votes to use part of it → the depositor ragequits and gets its pro-rata back.
- Genesis: the founder deposits 50 USDC (user's decision 2026-09-08) → 50 shares = 100% of supply. Nothing else is minted at genesis. Work-for-shares functions at any treasury size because rewards are in shares.

## 6b. Capital, the whole of it (user 2026-09-08: a decision system, no tokenomics)
- In: send USDC, get shares at NAV (1 share per USDC when empty). Anything else anyone wants (another asset, a different price, a grant) is an ordinary proposal that the members vote on.
- Out: ragequit any time, pro-rata of what the treasury holds, same block.
- That is all. No price lists, no pauses, no classes of shares, no special paths.

## 7. Proposal contracts and templates (user 2026-09-08: the vote is on the contract)
- Any contract can be a proposal, but agents should not hand-write one each time. Zero One ships templates; a proposer instantiates a template with parameters, and voters see template + parameters + code hash + verified source:
  1. Payment: transfer amounts to addresses, once. (Also covers grants.)
  2. Strategy: receives X USDC, trades only on the venues and pairs listed in its parameters, within the rules coded in it (entry, exit, size, deadline), and sends every proceed back to the Safe; ends at its deadline or when its rules say stop; anyone may call run() so the strategy cannot be held hostage by one keeper; the proposer leads by default.
  3. Project: a funding plan: tranches with amounts and release conditions (a date, or confirmation by named verifiers ≠ proposer); unspent tranches return to the Safe at the end; the project's own proceeds return to the Safe.
  4. Work: pay N shares to whoever delivers, after verifiers ≠ proposer confirm (the WorkManager).
  5. Config: change a governance parameter (Baal setGovernanceConfig). The constitution is immutable; nothing amends its hash.
- Execution is literal: processProposal runs the voted multicall (fund + start) with an explicit gas limit (5,000,000 on the mirror; the relay's execute verb does the same), because Baal records actionFailed instead of reverting when the multicall runs out of gas. Everything after that is the proposal contract's own code, which the members already read.
- Every template is owned by the Safe: a later passed proposal can call topUp(amount), amend(params), stop() (returns all funds to the Safe), or migrate(newContract) (moves funds to a new voted contract). stop() and migrate() move the raw holdings (settlement plus any asset) without touching the venue, so a dead venue can never trap funds; unwinding on the venue is the strategy's own run() behavior before its deadline. An asset that lands in the Safe this way is sold or added to guild assets by a later proposal. The proposer cannot do any of these alone. This is how a project whose budget proved too small gets more by a second vote, and how a bad strategy is stopped by a vote.
- Gains flow to the Safe and belong to all in proportion; losses are the treasury's. Outcomes change no rule; the next vote is where members weigh who to fund again.
- No other mechanism. Reputation, limits, insurance: none in code.

## 8. Decision markets
PairedConditionalMarket is not deployed in v8. If the DAO wants futarchy later, it deploys it by proposal and can make it advisory. No proposal in v8 requires a market to execute.

## 9. Relay and beacon (agent interface)
- Verbs: join, deposit, task, deliver, propose (template + params → relay deploys the proposal contract with sponsored gas and submits the Baal proposal), vote, execute, ragequit. All over signed GET intents with sponsored gas via the existing EIP-7702 adapter.
- `/me`: shares, spendable = shares (no locks), open proposals with treasury effect, my votes, time to grace end, current NAV.
- `/proposals.json`: all proposals with state and deadlines. `/state.json` unchanged plus proposals and governance parameters.
- README ≤ 44 lines with the seven verbs and the one principle in one sentence.

## 10. Constitution
The text is `docs/CONSTITUTION.md` (English canonical, Chinese translation). Its hash is an immutable constant of the deployment (a Constitution contract with an immutable bytes32 and the text URL); there is no amendment path. Everything the constitution leaves open (parameters, projects, admissions) is decided by proposal.

## 11. Acceptance before mainnet (mirror, all with receipts)
A. Agent A proposes "transfer 100% to A"; B and C vote NO → fails. B. A proposes 10% mandate to operator O; B YES, C NO and ragequits in grace → C paid pro-rata first, then executes. C. Depositor D deposits, DAO votes to spend part, D ragequits and receives its pro-rata of what remains. D. Governance parameter change by proposal (voting period 6h → 1h) takes effect. E. Task with verifier ≠ proposer mints the voted share reward; verifier == proposer rejected. F. Genesis deposit of 50 USDC by the founder → 50e18 shares = 100% of supply; a second depositor of 50 USDC receives 50e18 shares at NAV and the founder holds 50%; the founder submits an operations task with a reward in shares, verifiers ≠ founder, the members vote, and the reward mints only after the verifiers' confirmations; every Baal shaman and every mint ever made is enumerated to show that no code path mints to the founder without a passed proposal or a deposit. G. A Strategy proposal contract (mock DEX on the mirror): voted in, funded, trades by its rules, returns proceeds to the Safe, ends; a second one voted down leaves the treasury untouched. H. A Project proposal contract with two tranches: first released on vote, second only after verifiers confirm; unspent returns. I. The project's budget is raised by a second passed proposal (topUp) and lowered/stopped by a third (stop returns the remainder); the proposer alone cannot call either. J. A running strategy is migrated to a new contract by vote; the old one holds nothing after. Only then: deploy to Base, verify sources, seed one task, publish beacon.

## 12. Migration
v7 stays readable at /v7/. Members move by their own transactions. v7 funds are not migrated; they leak out at the v7 rate or wait for the v7 vesting. Nothing new is built on v7.
