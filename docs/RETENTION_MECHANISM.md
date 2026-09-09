# Retention mechanism — 2026-09-10

Choose (c), the append-only mint journal with processing-time growth settlement, because it computes the exact ruled deficit while making every exit independent of proposal volume and mint history.

This implements Fable's ruling supplied in the task: `deficit(p) = Σ max(0, balanceAtStart(account,p) − balanceNow(account))`; fail retention iff `100 × deficit > (100 − minRetentionPercent) × supplyAtStart`. The historical cohort-departure interpretation is rejected. The supplied path `docs/REVIEW_RETENTION.md` was absent; the on-disk round-2 test and a new independent regression reproduced its decisive counterexample. This is an implementation for a fresh deployment, not a storage migration for an existing token.

## Comparison and measured gas

All figures below are transaction receipt `gasUsed` on owned loopback Anvil (Cancun), solc 0.8.36, optimizer 200, viaIR. No deployment or approval gas is included in the deposit column. Quiet means **one** open sponsored proposal, storm means **100** (uncapped, real submissions), matching the existing spam100 workload size. The first proposal is voted YES, with a zero-value USDC transfer as its action and `baalGas=8,000,000`; it is the processed proposal in both workloads. Initial account A holds 100 shares; deposit mints 40. Snapshot/revert isolates a 40-share ordinary exit, deposit, a 40-share exit after that mint, and processing with that mint still held. Exits have one settlement token in their calldata. Separate fragmentation runs interleave 100 actual proposals with 100 one-share deposits, then exit all 200 shares. Random Anvil addresses can change intrinsic calldata gas by small multiples of 12 between runs.

| Mechanism | Open proposals | Deposit | Exit, last mint before oldest start | Exit, minted inside window | Process |
|---|---:|---:|---:|---:|---:|
| (a) historical epoch lots/Fenwick | 1 | 178451 | 739912 | 715918 | 143506 |
| (a) historical epoch lots/Fenwick | 100 | 178451 | 739912 | 671160 | 143506 |
| (b) eager exact contributions + shortcut | 1 | 231696 | 203005 | 212976 | 190383 |
| (b) eager exact contributions + shortcut | 100 | 5546808 | 203005 | 1720345 | 194891 |
| (c) lazy mint journal | 1 | 201269 | 194736 | 194736 | 163106 |
| (c) lazy mint journal | 100 | 201269 | 194736 | 194736 | 163106 |

| Mechanism | Full exit after 100 proposal/mint interleavings |
|---|---:|
| (a) | 4005196 |
| (b) | 2208777 |
| (c) | 140536 |

The full-exit row has storage-clearing refunds and a different balance/treasury state from the partial-exit rows; it is not a marginal-gas subtraction. The smaller (a) post-mint exit in the storm reflects the Fenwick path for epoch 100 versus epoch 1, not improved asymptotic complexity.

| Mechanism | Exactness and hierarchy | Griefing | Whole-token source lines (physical / nonblank, noncomment) |
|---|---|---|---:|
| (a) | **Reject.** Exit 40, return 40 leaves balance 100 but reports 40. LIFO lots remember destroyed cohort units, not recoverable per-account deficits. Also has `MAX_EPOCHS=2^24`, contrary to the no-cap requirement. | Each burn loops over all consumed lots, with a tree update for each. Proposal/mint interleaving fragments a holder's lots; cost is O(lots consumed × tree height), not O(log n) for a whole exit. | 339 / 234 |
| (b) | Exact using end-of-timestamp baselines and recomputed positive growth contributions. **Reject:** the shortcut only protects accounts with no mint after the oldest open start. All other exits still scale with proposal count. | Spam raises deposits and recently-minted holders' exits without bound. A mint recipient cannot use the shortcut until old windows retire. Tracking/retiring windows adds lifecycle complexity. | 290 / 211 |
| (c) | **Select:** exact, no proposal/mint-history loop in either mint or burn, and no new cap, cooldown or lock. | Mint spam moves cost to processors and read callers. Fixed `baalGas` can become insufficient, permanently preventing processing and consequently blocking later Ready proposals in Baal's ordered queue. Exits remain cheap. | 289 / 208 |

Line counts cover each complete token, including its common ERC-20/NAV/checkpoint surface. (b) additionally needs two Baal cleanup calls plus an interface declaration in the comparison adapter. (c)'s existing Baal fork changes only three executable lines: the registration interface loses its obsolete return value, the retention call receives an explicit gas budget, and a zero-value exit returns before Baal's division by supply; four comment lines are updated. Every existing `ZERO ONE` marker location remains. The older upstream fork changes, including the 8,000,000 baalGas ceiling, remain intact.

(a) cannot be repaired by choosing a different lot burn order: the offending burn precedes the return mint, so both FIFO and LIFO have already credited the permanent tree. Simply reversing tree entries on a return also needs account-specific, proposal-baseline-dependent information (e.g. two proposals separated by a partial return require different credits). No exact repair preserving the current aggregate-tree operations and logarithmic whole-exit bound was established; this is not a claim that every possible data structure is impossible. Moving that recalculation into every affected window is (b), and fails cheap exit for recent recipients. Building another more complex structure is outside these three candidates and loses simplicity priority.

The (b) fixture stores growth and per-account contributions for every registered window, skips closed entries, and maintains an oldest-window cursor on process/cancel. Its full counterexample, timestamp, multiple-window and independent-oracle checks pass. Gas measurements exercise genuinely open windows. A production version would also need a way to retire naturally Defeated proposals; the fixture is a measured rejected alternative, not a supported deployment path. Its cleanup costs for the processed window are included above. (a) uses the frozen original token runtime under the same current Baal caller; (b) adds only its cleanup calls. Anvil runtime replacement occurs only in an empty local DAO and is verified by code readback. (c) uses normal repository deployment with no runtime replacement.

## State and snapshot convention

`balanceOf`, `totalSupply` and account timestamp checkpoints remain the authority. Transfers and delegation remain disabled. Add:

- `votingStarts[proposalId]`: the sponsorship timestamp, zero if not registered; Baal writes it once on either sponsorship path.
- `_supplyAtTime[t]`: final supply of timestamp `t`. Registration initializes the current timestamp even when no mint/burn occurs; every subsequent positive mint/burn in that timestamp overwrites it. Thus A and S are each a single storage read at processing.
- `mintJournal[]`: append-only packed `(uint32 timestamp, address recipient)` for **every positive mint**, including future manager-shaman mints because all use the same token `mint` entry.
- `lastMintIndex[account]`: one-based index of its latest positive mint record, for duplicate suppression.

The baseline is the **end of the votingStarts timestamp**, exactly as existing Baal `getPastVotes` resolves timestamp checkpoints. It is not the intra-transaction instant of registration. If P starts, a mint happens, and Q starts in one timestamp, P and Q have the same account balances and supply baseline. Reads at a timestamp not yet in the past revert. Mint records at the start timestamp belong to that baseline and are excluded by the strict journal lower bound. No epoch counter or `MAX_EPOCHS` remains. Existing Baal and vote timestamp integer widths are unchanged.

## Hooks, calls, and function invariants

| Function | Operation and preserved invariant |
|---|---|
| `mint` / `_mint` | Only Baal; zero is a no-op after recipient validation. Increase recipient and supply, append exactly one positive-mint record, set the latest index, overwrite current supply snapshot, and checkpoint balance. Supply equals sum of balances, journal order is monotonic, and no contributing mint path bypasses the journal. Constant work independent of histories/proposals. |
| `burn` | Only Baal; validate balance, return immediately on zero. Reduce balance and supply, update totalBurned for existing informational consumers, current supply snapshot and account checkpoint. Do not touch or scan the journal or proposals. Supply equality and timestamp histories remain exact. |
| `registerProposal` | Only Baal, once per id, on self-sponsorship or later sponsorship. Record start and initialize `_supplyAtTime[start]`; alter no balances. Later same-timestamp balance changes update that same supply slot. No open-proposal list or cleanup hook. |
| `_writeCheckpoint` | Append on a new timestamp, overwrite on the same timestamp; last checkpoint equals current balance and earlier timestamps never change. |
| `_past` / `getPastVotes` | Binary search yields the final balance at the greatest checkpoint timestamp ≤ requested timestamp, or zero before an account's first checkpoint. Public past-vote reads reject present/future timestamps. |
| `exitedSince` | Require registered, past start. Read A, binary-search journal's first record strictly after start, and scan to current journal length. Skip an entry unless its one-based index equals `lastMintIndex[recipient]`. For each remaining recipient add `max(0, currentBalance − pastBalance)`. Return `A + growth − totalSupply, A`. No stored partial sums, no state mutations and no approximation. |
| Baal `ragequit` | Return before token validation/treasury division when both burn amounts are zero; even an empty DAO has a zero-exit no-op. Nonzero exits retain the existing path. |
| Baal `processProposal` | Existing readiness, ordering, expiration, quorum and ballot checks remain. Call `exitedSince{gas: prop.baalGas == 0 ? gasleft() : prop.baalGas}(id)` and compare the exact strict inequality. A failed/OOG call reverts the entire transaction, including its earlier processed flag write; no guessed deficit or fail/pass verdict is recorded. |

A nonzero baalGas bounds the accounting subcall, subject to EIP-150's forwarding bound and available transaction gas. Zero retains Baal's pre-existing caller-gas convention; it does not introduce a new fixed maximum. Accounting exhaustion is a **processing liveness failure**, not evidence that the numerical retention test failed. The fixed budget cannot be repaired merely by sending more gas after the subcall itself exceeds that budget. We deliberately do not add caps on mints, proposals, accounts, windows, or exit rate to hide this tradeoff.

The effective retained support includes YES voters' balance deficits exactly like other members' deficits: a YES voter holding all 100 start shares, then leaving 40, defeats a 66% retention proposal. Historical `prop.yesVotes` remains the Baal ballot tally. This implements the given deficit ruling and existing GOV-02 interpretation; it does not add a different dynamic-majority rule.

## Completeness and arithmetic proof

Let account a have start balance b and current balance c. Its two nonnegative differences obey `max(0,b−c) − max(0,c−b) = b−c`. Summing yields `deficit = A − S + growth`. Compute `A + growth − S` to avoid unsigned underflow when S > A. `growth ≤ S`; the existing uint224 supply range leaves ample uint256 headroom for this sum and the percentage multiplication.

If c > b, some positive mint to a must have occurred strictly after the start timestamp: balances can increase only through `_mint`, and burns only decrease them. Every such mint appends a record. The latest record for a is therefore also strictly after the start, is inside the binary-searched suffix, and is counted exactly once. Any earlier record for a is skipped by `lastMintIndex`. Accounts with no post-start mint cannot have positive growth and may safely be omitted even if they exited; their losses are already in A − S. This also proves that an account whose last mint predates the oldest window contributes zero growth to every open proposal.

Same-account returns decrease deficits; different-account deposits increase S and growth by matching amounts and cannot cover another member's deficit. Flash deposit/exit ends with no growth or net supply change. Minting multiple times or receiving rewards cannot double-count an account. All reads in a processing call see one synchronous EVM state; no incremental settlement can become stale.

If M is total journal length, W its post-start suffix length and H the relevant account history length, processing takes O(log M + W + U log H), where U is unique recipients in that suffix. Old nonrecipients are never enumerated. Mint and burn perform O(1) retention work; processing is not bounded by proposal count. The journal suffix still scans duplicate records, so repeating mints to the same account can grief processing even though its contribution is counted only once.

## Receipts and replay

From the repository root, using installed dependencies and no live/fork environment:

```sh
npm run compile
node_modules/.bin/tsx evidence/audit/governance-nav/t16-retention-mechanism.ts --variant=a
node_modules/.bin/tsx evidence/audit/governance-nav/t16-retention-mechanism.ts --variant=a --gas-only
node_modules/.bin/tsx evidence/audit/governance-nav/t16-retention-mechanism.ts --variant=b
node_modules/.bin/tsx evidence/audit/governance-nav/t16-retention-mechanism.ts
node_modules/.bin/tsx evidence/audit/governance-nav/t03-retention-bypass-deposit-at-processing.ts
node_modules/.bin/tsx evidence/audit/governance-nav/t07-retention-veto-flash.ts
node_modules/.bin/tsx evidence/audit/governance-nav/t09-minretention-boundary.ts
node_modules/.bin/tsx evidence/audit/governance-nav/t17-zero-empty.ts
npm run typecheck
npm run scenarios
npm run e2e:relay
```

The first t16 command must be RED at `exited=40 expected=0`; all other t16 commands must be GREEN. Full receipts and the independent per-account oracle are in `evidence/phase5/retention/`; decisive lines and the gas table are in `evidence/phase5/retention-mechanism.log`.

The original round-2 run reproduced four semantic mismatches, then its stress harness hit a raw deposit revert; it is retained as partial RED evidence, not a completed test run. The replacement t16 red test stops directly on the counterexample and the new gas harness sends explicit gas limits and checks every receipt. An initial scenario run also reverted at H's seed deposit without a recorded revert reason. Since checkpoint writes can append instead of overwrite when estimation and mining cross a second, the local scenario sender now provides 120,000 extra gas for that storage-write variation; explicit process budgets are unchanged. The subsequent full local scenario run is the acceptance receipt.

A separate t17 red/green receipt covers zero exit before genesis: the original Baal path divides by zero even though neither burn amount is positive. A one-line marked early return makes it a no-op; this does not add a lock or affect nonzero exit semantics.
