# Zero One DAO — continue the incremental settlement work (it is committed; do not restart)

Red-line clarification: our own repository; local anvil, including a local fork of Base. Explicit permission from the design
authority: reading Base through a public RPC to run a LOCAL fork is allowed and is not a public-network transaction
(https://mainnet.base.org, https://base-rpc.publicnode.com, https://base.drpc.org; export HTTPS_PROXY=http://127.0.0.1:7897
if a direct connection fails). Never send a transaction to a public chain. Never construct any rm command; never commit
.env, keys or state; never push; git email yangzk01@gmail.com.

Where you are: `/Users/michaelmacmini/srv/zero-one-phase4`, branch phase4-ledger-twap, commit 75c9ac6 holds your work in
progress (the previous run ended without finishing). Read goals/retention-incremental-settlement.md for the full task and
docs/RETENTION_MECHANISM.md for your own specification. Your recorded design decision, which stands: the journal records the
balance before and after each change, a per-proposal cursor accumulates growth deltas, and a proposal may be processed only
once its cursor has reached the journal tail, so later changes add work instead of invalidating what is settled.

Already done and committed: the contracts compile; settling in chunks works; processing an unsettled window is refused with
all four proposal flags unchanged; the exit-and-return counterexample reports zero; the multi-window balance oracle passes;
5,000 deposit records were written and the measurements came out constant — deposit 245,235 gas and exit 249,624 gas at
quiet, 2,500 and 5,000 records.

## What is left, in order
1. Prove the two remaining behaviours from the storm run: settle the 5,000-record window in chunks and report the number of
   calls and total gas, then process the proposal successfully; and show that a deposit and an exit landing between two
   settle calls are picked up correctly rather than lost or double counted.
2. Report the economics with measured numbers: what a record costs whoever writes it (gas plus USDC) against what it costs
   whoever settles it.
3. Finish the acceptance: `npm run scenarios` with FORK_RPC set so scenario K runs on the local Base fork at the pinned
   block (warm the pool as the harness does), `npm run e2e:relay`, `npm run e2e:entry-point`, `npm run test:deploy-refusals`,
   and the full audit test set.
4. Re-run everything from a clean clone of the branch into a temp directory under ~/srv and paste the output into
   evidence/phase5/acceptance-rerun-retention.log.
5. Update docs/RETENTION_MECHANISM.md, docs/PARAMETERS.md and decision.md to match what shipped.

Commit after each finished step so an interruption never costs more than one step. If a step is red, fix it and say whether
code or test changed. If something genuinely cannot be done, say which of at least three attempts failed and with what exact
error.

## ACCEPTANCE
The storm window settles in chunks and the proposal processes, with call count and gas reported; changes between chunks are
handled correctly; deposit and exit gas unchanged under the storm; scenarios A-L green with K actually run on the fork;
e2e:relay, e2e:entry-point and the deploy refusals green; the clean-clone log committed.
