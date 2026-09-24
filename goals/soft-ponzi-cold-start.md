# Zero One DAO — cold-start incentive ("soft ponzi"): design, fork-prove, prepare the proposal (no mainnet action)

Red-line clarification: our own repo. Local anvil and a local anvil fork of Base only; reading Base mainnet through a public
RPC to build the fork is allowed (export HTTPS_PROXY=http://127.0.0.1:7897). Send NO transaction to Base mainnet or any
public chain. Never construct any rm command; never commit .env/keys/state; never print a key; git email yangzk01@gmail.com;
do not push. docs/CONSTITUTION.md is immutable on chain: do not edit it.

## Context
Zero One is LIVE on Base mainnet (deployments/base.json; decision.md "2026-09-23 ZERO ONE IS LIVE"). Treasury 50 USDC,
50 shares all held by the founder, NAV 1, governance 6 h / 6 h, managerLock false (a passed proposal can add/remove manager
shamans). The user's verdict: cold start is hard; the DAO needs a mild "soft ponzi" property — early members must gain from
later inflows, so agents have a reason to come early.

## Hard constraints (from the user and decision.md; not negotiable)
- Exit is never restricted: ragequit any time, pro-rata, no fee, no lock, no cliff, no vesting. (v7 locked the user's funds;
  the redesign exists to prevent that.)
- No complex tokenomics: one or two parameters at most, each changeable by an ordinary proposal.
- Installable on the LIVE deployment via proposals only (new shaman in, old shaman out), no redeploy of the DAO.
- Transparent: every rule is visible on chain and in the README; nothing promises a return.
- The treasury-ledger pricing rules from phase 4/5 (depositTreasury, settled gate, task liability) stay intact.

## GOAL
1. Evaluate at least: (a) an entry premium on deposits (shares priced at NAV x (1 + p); the premium stays in the Safe and
   accrues pro-rata to incumbents); (b) a referral bounty paid in shares through the existing Work template (zero code);
   (c) any other mechanism you judge stronger that meets every constraint. For each: effect on the first 10 depositors,
   round-trip arbitrage (deposit then ragequit must never profit), interaction with the ledger/settled gate, attack surface
   (flash loans, self-referral sybils), and lines of code. Recommend one combination in one sentence.
2. Implement the recommendation as a new shaman (e.g. DepositShamanV2) with Google-style docstrings, no owner/admin/pause,
   the parameter settable only by the Safe (a passed proposal).
3. Prove on a Base fork of the live deployment: build the proposal that installs V2 and removes V1 (plus sets p), have the
   founder key IMPERSONATED on the fork submit/vote/process it after warping time, then show: a new depositor pays the
   premium, incumbents' NAV per share rises by exactly the premium, an immediate ragequit by the new depositor returns less
   than deposited (no arbitrage), incumbents can still ragequit at full NAV, and every existing audit test that touches
   deposits still passes against V2. Receipts in evidence/cold-start/.
4. Produce the exact proposal calldata + a runbook (docs/COLD_START.md) for the live mainnet proposal, and a README line for
   the beacon (keep README <= 44 lines). Record the design and rejected alternatives in decision.md under
   "2026-09-24 cold-start incentive". Commit, do not push, do not submit anything to mainnet.

## ACCEPTANCE
Fork receipts show premium to incumbents, no round-trip profit, unrestricted exit, V1 removed/V2 installed via proposal;
audit deposit tests green on V2; calldata + runbook committed; zero public-chain transactions.

## NOT AN ANSWER
Any exit fee, lock, cliff, vesting or withdrawal delay; a bonus curve with more than two parameters; a design that needs a
DAO redeploy; promised yields; submitting to mainnet.
