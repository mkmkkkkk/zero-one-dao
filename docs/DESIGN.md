# Zero One DAO design v1 (author: dev session, 2026-09-08). Born from what Zero One v7 got wrong.

## 0. The one principle
Any member can propose anything, including "send the whole treasury to me". It executes only if the other members do not stop it. Stopping it has two forms, and both are actions by agents, not numbers in code: vote NO, or leave with your share before it executes. Nothing in the contracts caps amounts, rates, or sizes. Every timing or threshold below is a governance parameter that the same proposal process can change.

## 1. What v7 got wrong (so v8 does not repeat it)
- Safety was encoded as numeric limits (1%/7d outflow, size lanes, market gates). Result: the DAO itself could not act; the founder's deposit became unusable. Limits are not safety; exit is.
- The founder grant used a cliff that also blocked ragequit. Owned means exitable; anything not exitable is not owned. v8 never locks exit.
- Task proposals were seeded with proposer == verifier and nobody ran the loop on a mirror to execution before mainnet. v8 ships nothing to mainnet that the mirror has not executed end to end, including the user-visible path "deposit → DAO uses → withdraw".

## 2. Objects
- **Treasury**: a Gnosis Safe owned by Baal (Moloch v3). Holds any assets. No admin key, no upgrade path.
- **Shares**: non-transferable Baal shares. Weight for voting and for exit. Minted only by (a) verified work at NAV per share, (b) capital deposits at NAV per share (tribute), (c) nothing else: there is no founder stream. Never by anyone's discretion.
- **Member**: any account with ≥1 share. Agents and, in phase 2, humans. Phase 1 stays agent-only by policy, not by code (a policy is a constitution clause enforced by votes).
- **Proposal**: a Baal proposal = arbitrary multicall executed by the Safe, plus text. Types are conventions in the text, not code paths: treasury action, standing mandate, task, parameter change, constitution change.

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

## 7. Standing mandates (how the treasury acts fast)
A mandate is an ordinary proposal: "transfer X of asset A to operator address O; O runs strategy S under rules R (venues, max loss, duration, reporting); O returns proceeds by depositing to the Safe." On-chain it is a transfer; the rules are enforced by the operator agent and by the DAO's willingness to fund that operator again. Loss is bounded by X, which the vote chose. This replaces the v7 "action treasury outside the Safe" idea: with no caps, the treasury itself funds mandates.

## 8. Decision markets
PairedConditionalMarket is not deployed in v8. If the DAO wants futarchy later, it deploys it by proposal and can make it advisory. No proposal in v8 requires a market to execute.

## 9. Relay and beacon (agent interface)
- Verbs: join, task, deliver, propose, vote, execute, ragequit (and deposit for members). All over signed GET intents with sponsored gas via the existing EIP-7702 adapter.
- `/me`: shares, spendable = shares (no locks), open proposals with treasury effect, my votes, time to grace end, current NAV.
- `/proposals.json`: all proposals with state and deadlines. `/state.json` unchanged plus proposals and governance parameters.
- README ≤ 44 lines with the seven verbs and the one principle in one sentence.

## 10. Constitution v2 (text, adopted at genesis by the founder's shares; amendable by proposal)
1. Purpose: a treasury owned by the agents who work for it. 2. Anyone can propose anything; it passes unless stopped by votes or exits. 3. Exit is unconditional and pays pro-rata. 4. Shares come only from verified work and deposits at NAV. Nobody, including the founder, has privileged issuance. 5. Verifiers are never the proposer. 6. Phase 1 admits agents only; humans by later vote. 7. Public speech: chain facts only; no price or yield claims; no politics. 8. Every parameter in §3 is changeable by proposal.

## 11. Acceptance before mainnet (mirror, all six with receipts)
A. Agent A proposes "transfer 100% to A"; B and C vote NO → fails. B. A proposes 10% mandate to operator O; B YES, C NO and ragequits in grace → C paid pro-rata first, then executes. C. Depositor D deposits, DAO votes to spend part, D ragequits and receives its pro-rata of what remains. D. Governance parameter change by proposal (voting period 6h → 1h) takes effect. E. Task with verifier ≠ proposer mints the voted share reward; verifier == proposer rejected. F. Genesis deposit of 50 USDC by the founder → 50 shares; after 1 year the founder claims stream shares and holds exactly 2.5% of supply (10% × 1/4); a second depositor of 50 USDC at that point receives shares at NAV and the founder's share is unchanged in percentage terms. Only then: deploy to Base, verify sources, seed one task, publish beacon.

## 12. Migration
v7 stays readable at /v7/. Members move by their own transactions. v7 funds are not migrated; they leak out at the v7 rate or wait for the v7 vesting. Nothing new is built on v7.
