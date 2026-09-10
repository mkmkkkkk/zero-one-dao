# Zero One DAO — correctness review of the phase 5 retention accounting (review only, no code changes)

Red-line clarification: reading and reasoning about our own repository plus, if useful, read-only test runs on a LOCAL anvil
devnet. No public-network transaction. "USDC", "treasury", "payment" are contract names. Never construct any rm command;
never commit; never push; do not modify any file except writing your report to docs/REVIEW_RETENTION.md.

Repo: ~/srv/zero-one-dao on this Mac mini. `git fetch origin && git fetch --all` then read branch phase4-ledger-twap
(commits 7f2f111, 0ea7308, 95daf4e, 624992a). If that branch is not present on origin, ask for it in your report and review
the same design from decision.md (sections "2026-09-09 phase 5 rulings" and "phase 5 stage A designQuestions") plus
docs/SECURITY_AUDIT.md rows GOV-01..GOV-05, NAV-01, NAV-07, W-1.

Background: Moloch v3 (Baal) fails a passed proposal when too many shares leave during vote + grace ("minRetention", 66%).
Baal compares the live total supply against a high-water mark taken at sponsorship. Our audit demonstrated two defects:
(a) a proposer can restore the supply with a deposit in the same transaction as processing and pass a proposal that the
exits should have defeated; (b) a one-share holder can raise the high-water mark with a deposit, vote, then leave, which
defeats every proposal for the cost of gas, i.e. a permanent veto. Our fix (branch above) replaces the comparison with
"shares that existed when voting started and have since left", computed per account as max(0, balance at votingStarts −
balance now), summed with per-account mint lots stamped by a registration epoch (burn consumes the newest lots first) and a
Fenwick tree over epochs in NavShareToken; Baal gains `registerProposal` at sponsorship and `exitedSince` at processing.
Ragequit gas went from about 120k to about 709k.

## GOAL
`docs/REVIEW_RETENTION.md` answering, with references to exact lines of code:
1. Is the implemented accounting exactly "shares present at votingStarts that are no longer present"? Construct sequences
   that break it if any exist: transfers are impossible (shares are non-transferable), but consider mint-then-burn ordering,
   several proposals with different start times, burn of lots older and newer than a start, a member who deposits, exits and
   deposits again inside one vote, ragequit(0), the same account acting in two proposals' windows, epoch exhaustion
   (MAX_EPOCHS 2^24), and Fenwick node initialisation costs.
2. Does it actually close both defects above, and does it leave the remaining behaviour the design intends (a member who
   votes yes and then leaves reduces the yes side by leaving, not by retracting)? Say plainly if any of the three audit rows
   GOV-02, GOV-03, GOV-04 is still open, with the sequence.
3. Is there a materially simpler design with the same guarantees? Evaluate at least: a single global cumulative burn counter
   with checkpoints; net-of-mint (burned minus minted since start); counting votes at processing against live balances
   (weight = min(balance at start, balance now)) instead of a retention rule; a per-proposal snapshot of the voter set only.
   For each, state which of the two defects it closes and which it does not, and the gas and storage cost. Recommend one.
4. Any new failure mode the fix itself introduces (gas cost of exit under stress, a member who cannot afford to leave, a
   proposal that can no longer be processed, reentrancy through the token's hooks, checkpoint reads at the wrong timestamp).

Be concrete: quote the code, name the function and line, give numbers. Verdict must be one of: the fix is correct and
minimal / correct but a simpler design exists (name it) / incorrect (give the breaking sequence).

## ACCEPTANCE
docs/REVIEW_RETENTION.md exists with the four sections, code references, and one of the three verdicts. No other file changed.

## NOT AN ANSWER
A summary of what the code says without an adversarial attempt; "looks fine"; a redesign proposal without the cost table;
changing any code.
