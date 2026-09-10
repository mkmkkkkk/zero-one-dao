# Zero One DAO — pick and specify the retention mechanism (design task, then a reference implementation)

Red-line clarification: our own repository; local anvil only; no public-network transaction. Never construct any rm command;
never push. Commit your work on the branch.

Code on disk, nothing to fetch: `/Users/michaelmacmini/srv/zero-one-phase4`, git worktree on branch phase4-ledger-twap,
`node_modules` installed. (If a network call is unavoidable: export HTTPS_PROXY=http://127.0.0.1:7897.)
Your own round-2 report is docs/REVIEW_RETENTION.md in that worktree; it proved the current code is wrong.

## The ruling you are implementing (decision.md, 2026-09-10, authority Fable — not open for redesign)
For proposal p: `deficit(p) = Σ_accounts max(0, balance_at_votingStarts(p) − balance_now)`, and p fails when
`deficit(p) * 100 > (100 − minRetention) * supply_at_votingStarts(p)`. The current implementation records permanent cohort
departures instead, which is wrong: it reported 40 for an account that exited 40 and came back to 100.

Constraint hierarchy, in order: (1) exactly that quantity, no approximation; (2) leaving is always cheap — proposal volume
is uncapped, so no actor may make exits expensive by spamming proposals; (3) no cap, cooldown or lock anywhere;
(4) simplicity first, then gas.

Identity you may use: with A = supply at votingStarts and S = supply now,
`deficit(p) = (A − S) + growth(p)` where `growth(p) = Σ_accounts max(0, balance_now − balance_at_votingStarts(p))`.
A and S are single reads, so only `growth` needs machinery, and only accounts that received shares inside the window can
contribute to it. An account whose last mint predates the oldest open window contributes zero to every open proposal.

## GOAL
1. Evaluate exactly these three mechanisms against the hierarchy, with measured gas from this repository (deposit, exit,
   process, under both a quiet DAO and a hundred-open-proposal storm — the spam case already exists in the audit evidence):
   (a) the current epoch lots plus Fenwick tree (for the record: it computes the wrong quantity, so it can only survive if
       you can repair its semantics without losing its O(log n) exit);
   (b) recomputing each open proposal's stored per-account contribution on every balance change, with the last-mint
       timestamp shortcut so an ordinary exit is O(1);
   (c) the identity above with `growth(p)` settled lazily at processing time from an append-only mint journal (records are
       timestamp-ordered, so the window is a binary search), the loop paid by whoever processes the proposal and bounded by
       Baal's baalGas, with a completeness argument that the journal cannot omit a contributing account.
   For each: is the quantity exact, what does an exit cost in the storm, what can an attacker grief, how many lines.
2. Recommend one in a single sentence, then specify it precisely enough to implement: state, hooks, the Baal-side call, and
   the invariant each function preserves.
3. Implement it. Replace the wrong accounting; keep the Baal fork diff as small as you can and keep every "ZERO ONE:" marker.
4. Tests, all of which must pass and one of which must be the counterexample: the exit-and-return sequence reports zero;
   GOV-03 (a deposit at processing cannot mask other members' exits) still fails the proposal; GOV-04 (a flash deposit, a
   vote and an exit) cannot veto; a member who votes yes and then leaves reduces the yes side by leaving; several proposals
   with different start times each get their own correct deficit; ragequit(0) is a no-op; exit gas in the storm is reported.
   Put them under evidence/audit/governance-nav/ and keep the existing t03 and t07 assertions honest.
5. Re-run `npm run scenarios` (A–L) and `npm run e2e:relay` green, and write evidence/phase5/retention-mechanism.log with
   the decisive lines and the gas table. Record the mechanism and its rejected alternatives in decision.md under
   "2026-09-10 retention mechanism".

## ACCEPTANCE
The counterexample test reports zero exited with the balance restored; GOV-03 and GOV-04 still closed; scenarios A–L and
e2e:relay green; the gas table names the exit cost in a hundred-proposal storm; decision.md updated; committed, not pushed.

## NOT AN ANSWER
Keeping the current semantics; an approximation of the deficit; making exits O(number of open proposals) without the
shortcut; a cap or cooldown; a recommendation without measured gas; changing docs/CONSTITUTION.md or the CLAUDE.md principle.
