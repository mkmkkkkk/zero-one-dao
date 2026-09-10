# Zero One DAO — make retention settlement incremental, then finish the acceptance (K included)

Red-line clarification: our own repository. Local anvil, including an anvil fork of Base. **Explicit permission, granted by
the design authority**: reading Base mainnet through a public RPC in order to run a LOCAL fork is allowed and is not a
public-network transaction; use https://mainnet.base.org, https://base-rpc.publicnode.com or https://base.drpc.org and
export HTTPS_PROXY=http://127.0.0.1:7897 if a direct connection fails. Never send a transaction to any public chain.
Never construct any rm command; never commit .env, keys or state; never push; git email yangzk01@gmail.com.

Code on disk: `/Users/michaelmacmini/srv/zero-one-phase4`, branch phase4-ledger-twap. **Before you start**:
`export HTTPS_PROXY=http://127.0.0.1:7897; git fetch origin phase4-ledger-twap && git reset --hard origin/phase4-ledger-twap`
— the orchestrator merged your journal work with the entry-point and fork-rehearsal work, so origin is now ahead of your
worktree. Your own specification is docs/RETENTION_MECHANISM.md; your rationale is in decision.md under
"2026-09-10 retention mechanism", and the authority's response to it is the section immediately after.

## The ruling you are implementing (authority Fable, not open for redesign)
Your report states the hazard plainly: minting is permissionless, so an attacker can put enough records inside a window that
settling growth exceeds the proposal's gas budget, and since Baal processes in sponsorship order that griefs every later
proposal in the queue permanently. That is the same shape as the capped-gas defect the audit found (GOV-05), which is ruled
impossible. Close it by bounding work per transaction, not by capping anything:
- Settlement is incremental and permissionless: anyone may advance a cursor over the journal window in chunks, accumulating
  growth; `processProposal` requires the cursor to have reached the end of the window. No single transaction scans an
  unbounded range. No deadline is introduced — a proposal must never become unprocessable because settling it was expensive
  at one moment, and a partially settled proposal must never record a wrong deficit.
- Deposits and ordinary exits stay constant-cost. That property is why this design won; do not trade it away.
- Add append-time deduplication if it stays simple: an account already recorded inside the oldest open window need not be
  recorded again, so an attacker must pay for fresh addresses.
- No cap, cooldown, lock or minimum deposit anywhere.

## GOAL
1. Implement the above in contracts/NavShareToken.sol and the Baal fork, keeping the fork delta minimal and every
   "ZERO ONE:" marker. Say in your report how a partially settled window is represented and why a proposal cannot be
   processed against a partial sum, including when a new mint lands between two settle calls.
2. Tests under evidence/audit/governance-nav/, all green: the exit-and-return counterexample still reports zero; GOV-03 and
   GOV-04 still closed; a spam run that puts at least 5,000 mint records inside a window ends with the proposal processed
   after repeated settle calls, with the number of calls and the total gas reported, and with a deposit and an exit measured
   during the storm to show both stayed constant; processing against an unsettled or partially settled window reverts and
   marks nothing; a settle call on an already finished window is a no-op.
3. Report the attacker-versus-settler economics with the measured numbers: gas and USDC the attacker spends per record
   against the gas a settler spends per record.
4. Finish the acceptance you could not finish: `npm run scenarios` with FORK_RPC set so scenario K runs on the Base fork
   (the pinned block is in src/baseFork.ts; warm the pool as the harness already does), `npm run e2e:relay`,
   `npm run e2e:entry-point`, `npm run test:deploy-refusals`, and the full audit test set. Then re-run everything from a
   clean clone of the branch into a temp directory under ~/srv and paste the outputs into
   evidence/phase5/acceptance-rerun-retention.log.
5. Update docs/RETENTION_MECHANISM.md, docs/PARAMETERS.md and decision.md ("2026-09-10 incremental settlement") to match.

## ACCEPTANCE
The 5,000-record storm ends in a processed proposal with the settle-call count and gas reported; deposit and exit gas
unchanged under the storm; the counterexample, GOV-03 and GOV-04 green; scenarios A–L green with K actually run on a fork;
e2e:relay, e2e:entry-point and the deploy refusals green; the clean-clone re-run log committed.

## NOT AN ANSWER
A cap on mints, deposits or proposals; a deadline that can lose a proposal; a settlement that can be processed half-done;
making exits or deposits depend on journal length; "K blocked" now that the RPC permission is explicit.
