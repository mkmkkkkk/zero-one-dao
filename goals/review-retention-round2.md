# Zero One DAO — retention accounting, round 2: the code is local now (review + one decisive test)

Red-line clarification: our own repository, read-only reasoning plus tests on a LOCAL anvil devnet. No public-network
transaction. Never construct any rm command; never push. You may commit only your own report file.

THE CODE IS ALREADY ON DISK — do not fetch anything: `/Users/michaelmacmini/srv/zero-one-phase4` is a git worktree checked
out at commit dcb3e83 with `node_modules` installed. (If a network call is unavoidable, export
HTTPS_PROXY=http://127.0.0.1:7897 first; but nothing here needs the network except the optional Base fork.)
Your previous report is at /Users/michaelmacmini/srv/zero-one-dao/docs/REVIEW_RETENTION.md — it was written blind and is
explicitly not sign-off. Rewrite it as docs/REVIEW_RETENTION.md inside the worktree, now against the real code.

Read: contracts/NavShareToken.sol (mint lots, epochs, the Fenwick tree, `registerProposal`, `exitedSince`),
contracts/vendor/Baal.sol (search "ZERO ONE:"), contracts/DepositShaman.sol, decision.md sections
"2026-09-09 phase 5 rulings" and "phase 5 stage A designQuestions", docs/SECURITY_AUDIT.md rows GOV-02, GOV-03, GOV-04.
Run things: `npx tsx scenarios/A-*.ts` style, `npm run scenarios`, and the audit tests under evidence/audit/governance-nav/.

## GOAL — answer these, with code lines and executed output

1. THE DECISIVE QUESTION. The intended rule is a per-account deficit: exits = Σ over accounts of
   max(0, balance at votingStarts − balance now). Your blind review argued that lot-based accounting where a burn
   permanently consumes an old cohort disagrees with it on this sequence: an account holds 100 shares when voting starts,
   burns 40, then mints 40 again before processing; the deficit formula says 0, irreversible cohort accounting says 40.
   Write a test that runs exactly that sequence against the deployed contracts and print what `exitedSince(proposalId)`
   returns. Say which semantics the code implements. The design authority's ruling, for your report: the deficit (0) is
   correct, because a member who left and came back has not voted with its feet, and permanent cohort accounting would hand
   any 34% holder a free veto while keeping its stake. If the code returns 40, that is a defect to report with the fix.
2. Re-run your section 1 adversarial sequences against the code (mint-then-burn ordering, several proposals with different
   start times, burns of lots older and newer than a start, deposit-exit-deposit inside one window, ragequit(0), one account
   inside two windows, epoch exhaustion at MAX_EPOCHS, first-touch Fenwick costs). Report each as executed or as impossible
   with the reason.
3. Do GOV-03 and GOV-04 actually stay closed against the code (not the description)? The repository's own tests
   evidence/audit/governance-nav/t03-*.ts and t07-*.ts claim so; re-run them and say whether the assertion is the real thing.
4. Given the code, is the Fenwick machinery still the simplest way to compute the deficit exactly? Keep your cost table, but
   compare against what the code actually costs: measure ragequit gas in the repository (a scenario prints it), and compare
   with the simplest alternative that computes the same deficit. Recommend keep or replace, in one sentence.
5. Any new failure mode the implementation introduces: exit gas under stress, an account that cannot afford to leave,
   a proposal that cannot be processed, reentrancy through the token hooks, checkpoint reads at the wrong timestamp,
   the `registerProposal` hook being callable at the wrong moment.

## ACCEPTANCE
docs/REVIEW_RETENTION.md in the worktree, with: the executed output of the question-1 test, the five sections, and one
verdict: correct and minimal / correct but simpler design exists (name it) / incorrect (give the sequence and the fix).
Committed on the branch (no push). Nothing else modified except a test file you add under evidence/audit/governance-nav/.

## NOT AN ANSWER
Reviewing the description again instead of the code; "blocked" for anything that does not need the network; a verdict
without the question-1 output.
