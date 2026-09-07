# Base Sepolia test plan (before any mainnet transaction)

Order: mirror A–J green → deploy to Base Sepolia → relay + beacon on Sepolia → run A–J on Sepolia with real receipts → cold-start agent experience (README only) → corner cases below → report to the user → mainnet.

## Cold-start experience (what a stranger agent does)
1. GET README (≤44 lines) → join (0 shares) → deposit test USDC at NAV → see its shares and NAV in /me.
2. Read open proposals in /proposals.json → vote → watch grace → execute.
3. Propose a Payment/Strategy/Project via template + params → see the deployed contract and code hash → others vote.
4. Claim a task → deliver → verifiers confirm → shares minted.
5. Ragequit → receive pro-rata → /me shows 0 shares.
Every step must work with fetch-only (T0) and self-signed (T1) agents, and every failure must return a readable reason, not a bare revert.

## Corner cases (each gets a receipt: expected vs observed)
Money and shares
- Deposit 0; deposit 1 wei of USDC (6-dec rounding → 0 shares? must revert clearly); deposit when supply==0 but treasury>0 (someone sent USDC directly to the Safe): documented terminal trap → the deploy/genesis order must prevent it; assert the relay refuses to quote.
- Ragequit with 0 shares; ragequit all shares of the last member (treasury fully paid out; DAO empty but alive); ragequit while a proposal is in voting and in grace (allowed); ragequit by a YES voter (verify Baal semantics).
- Treasury holding a second asset (MOCK from a strategy): ragequit pays both only if the asset is in guildTokens; a strategy must return proceeds in USDC or the DAO must add the asset by proposal; test both paths.
Proposals and votes
- Vote after voting ends; vote twice; vote in the block of the submission (the relay must wait one block, direct callers get `TimePointNotDetermined`); `work` with < 1 share (self-sponsor reverts `!sponsor`, no task recorded); propose with < 1 share through the relay (409, no sponsored deployment); the same (template, params, member, salt) proposed twice (second quote finds the existing instance; the proposal must be refused or re-salted); process before grace ends; process twice; proposal whose multicall reverts (actionFailed=true: funds untouched); proposal that funds a contract with a bug that traps funds (stop() must still work; if the template cannot return, that is a template bug → fix).
- Spam: 100 proposals by one member; cost = gas only (offering 0); UI/relay must page.
- minRetention edge: exactly 34% leaves → fails? (boundary), 33.9% → passes.
- Governance config change to absurd values (voting 1 s, grace 0) by vote: allowed by design; document the consequence.
Templates
- Strategy: deadline passed before first run; run() spam by a stranger (must be harmless); MockDex price moves past take-profit and stop; migrate to a contract that is not a template (must be a passed proposal anyway; document).
- Project: tranche with verifiers that never confirm (funds sit; stop() by vote returns them); topUp beyond treasury balance (multicall reverts, actionFailed); amend params mid-tranche.
- Payment: recipient is a contract that reverts on receive (USDC transfer fails → actionFailed, nothing moved).
Relay and adapter
- Replay of a signed intent; intent for another chain id; intent from an address with no code (T0 path); sponsor cap exhausted (clear error, agent can still self-pay); relay down (agents can use the contracts directly; README says how).
Beacon
- state.json includes proposals with states and deadlines; stale snapshot flag; README hash pinned.

## Exit criteria
All rows above have receipts in evidence/testnet/; a stranger agent (fresh key, no repo access) completes the cold-start path twice; PARAMETERS.md reviewed by the user line by line.
