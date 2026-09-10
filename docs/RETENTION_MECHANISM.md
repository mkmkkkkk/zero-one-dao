# Retention mechanism — incremental settlement, 2026-09-10

Fable's final ruling is implemented for a fresh deployment. The exact rule remains
`deficit(p) = Σ max(0, balanceAtStart(a,p) − balanceNow(a))`; retention fails iff
`100 × deficit > (100 − minRetentionPercent) × supplyAtStart`. End-of-sponsorship-
timestamp balances and supply are the baseline, as with Baal's timestamp votes.
Same-account returns restore retention. Another account's deposits cannot restore
it; flash mint/burn does not create a deficit. Historical YES tallies are unchanged.

The former monolithic mint-journal scan is superseded: permissionless callers now
settle a bounded number of records per transaction. Processing never scans the
journal and does not forward a proposal-specific gas budget to retention accounting.
No new cap, minimum deposit, cooldown, lock, deadline or mandatory settler is added.
The historical comparison and rejected variants remain in
`evidence/phase5/retention-mechanism.log` and `evidence/audit/governance-nav/retention/`.

## State and why partial sums are safe

- `votingStarts[id]` records sponsorship once, only through Baal, on both sponsorship
  paths. `_supplyAtTime[t]` is overwritten on registration and every positive balance
  change in timestamp `t`, including changes later in that same timestamp.
- `balanceJournal` expands the old positive-mint journal into immutable
  `(timestamp, account, beforeBalance, afterBalance)` records for **both mints and
  burns**. Each positive change appends one record. Zero mint/burn appends nothing.
- `settlements[id] = {cursor, growth}` represents a possibly partial window.
  Registration sets `cursor` to the current journal length and `growth` to zero.
  Records subsequently appended within the start timestamp are consumed but excluded
  from growth, because they belong to the final timestamp baseline.
- `settleRetention(id, maxRecords)` is permissionless. It consumes at most
  `min(maxRecords, journalLength − cursor)` records, without addition overflow for
  even a uint256-max request. For each strictly post-start record it finds that
  account's baseline and adds `g(after) − g(before)`, where `g(x)=max(0,x−baseline)`.
  It writes the new cursor and growth only after the chunk completes. An OOG/revert
  preserves the previous complete chunk. A zero-size chunk, or an already-current
  window, performs no writes and emits no event.
- `exitedSince(id)` does constant work: require a registered, past start; require
  **cursor == the current journal length**; return `A + growth − totalSupply, A`.
  Otherwise it reverts `RetentionUnsettled(id,cursor,end)`. It never returns a partial
  deficit or performs a hidden view scan.
- Baal calls this guard before setting any processed/pass/actionFailed flag, including
  before expiration/quorum failure verdicts. A refused processing transaction changes
  none of the four proposal flags and cannot execute the action.

Suppose a mint lands between two settle calls, even to an account already visited.
It appends an immutable transition; the second call continues from the stored cursor
and eventually includes that transition's growth delta. A burn of already-settled
shares works identically with a negative delta. No restart, invalidation scan, live-
balance reread of previous records, fixed end snapshot or lost update is needed.
A new mint/burn after completion makes the window pending again until that suffix is
settled. Once the guard succeeds, the EVM cannot interleave an external transaction
before the retention verdict. Proposal actions occur after that verdict.

A caller may batch the last chunk and `processProposal` in one ordinary multicall to
avoid a transaction gap. GOV-03 tests a deposit, settlement and processing in the same
transaction. Continuous new changes still cost their originator transactions and
append work; an arbitrarily long **finite** history can always be settled in chunks.
This does not promise that a particular settler's transaction wins a censorship or
perpetual active-spam race. Old fixed `baalGas` cannot permanently strand the backlog.
Existing caller-selected Baal expiration semantics remain; no settlement expiration
has been introduced and partial progress never expires.

## Proof and complexity

For each account with baseline `b` and current balance `c`,
`max(0,b−c) − max(0,c−b) = b−c`. Summing gives
`deficit = A + growth − S`. Initially every account's growth is zero at the final
start timestamp. Every later mint/burn is journaled centrally in the only token
balance-mutation paths, including manager/reward mints. Replaying each account's
ordered transitions telescopes from `g(b)=0` to `g(c)`. Interleaving accounts does
not change that sum. Thus every cursor prefix has an exact growth sum for that
prefix, and at the **current** end the sum is exactly the required live growth.
Only then is it combined with the live supply. This also explains why immutable
burn records are necessary: a settled positive growth contribution can later fall.

The arithmetic `growth + afterGrowth − beforeGrowth` cannot underflow: the prefix
sum includes this account's beforeGrowth. Growth and supply obey the existing
uint224 balance/supply range; their sums and percentage products fit uint256.
The existing timestamp/vote integer widths are unchanged.

Mint, burn, deposit and ordinary single-token exit perform O(1) retention work,
independent of journal length, open proposals, accounts and balance history.
Registration is O(1). A chunk takes O(k × log H) for k requested records and account
checkpoint history H; timestamp checkpoints are binary-searched, never linearly
scanned. `processProposal`'s retention read is O(1). Storage grows with balance
changes and registrations. The extra fixed journal writes increase absolute hook
cost relative to the previous implementation; they do not increase it during spam.

Append-time account deduplication is deliberately omitted under the ruling's
“if it stays simple” condition. An account may already have been consumed by one
window but not another; suppressing its next transition would lose a return or burn
for that window. Updating all affected windows, or finding the oldest live window
with unbounded cleanup, would sacrifice constant-cost hooks. The stress test uses
**one repeated address and the smallest positive USDC unit**, so the economic result
does not assume that attackers need fresh addresses or a minimum deposit. The former
latest-mint-index field is removed; transitions must not be suppressed at replay.

## Baal delta and callers

Every previous `ZERO ONE:` marker remains. Both sponsorship hooks and the zero-exit
return remain. Relative to the prior journal implementation, the only executable
Baal change is moving its `exitedSince(id)` call before the processed flag and removing
its explicit `prop.baalGas` forwarding. The read no longer loops. Existing action-gas,
readiness, sponsorship ordering, ballot and configuration checks are unchanged.
No settlement cleanup hook or additional Baal storage is required.

`src/retention.ts` provides the explicit permissionless client loop, with a default
128-record chunk; this is a client choice, not a protocol cap. Its receipts are
logged and verified. Scenario processing and relay E2E preparation use it. Production
callers must settle the window before requesting relay execution; the relay's existing
signed execute operation is unchanged. A concurrently appended suffix causes a retry,
never processing with a stale result. A caller can use a smaller chunk if its chosen
transaction gas is insufficient. Unknown/unregistered and present-time starts revert.

## Receipts, gas and attacker economics

The source of truth is `evidence/phase5/incremental/green-storm.log`, with an independent
rerun in `evidence/phase5/acceptance-rerun-retention.log`. Both runs use owned loopback
Anvil, the repository's compiler/optimizer settings and actual receipt `gasUsed`.
The stress workload makes 5,000 real `DepositShaman.deposit(1)` calls, batched 50 per
transaction through an audit-only contract. No privileged mint or direct storage
injection creates the storm. Snapshots isolate identical A deposits and partial exits
before, midway through and after the storm; balance checkpoint timestamp shape is
held constant. The proposal uses `baalGas=50,000`, deliberately far below the total
settlement cost, and a subsequent proposal also processes.

Measured values are recorded below after the acceptance run. Attacker gas includes
batch-call overhead and all deposit receipts; it excludes helper deployment and
approval (both are separately receipted). USDC is contributed principal and can be
recovered via ordinary exit, **not an irreversible protocol fee or burned cost**.
No fiat ETH price, public-chain gas price or Base L1 data fee is inferred from local
gas units; those costs are unknown. Timestamp boundary writes cause small variations
in batched attacker gas between runs, so each run reports its own totals.

## Reproduction and acceptance coverage

```
npm ci
HTTPS_PROXY=http://127.0.0.1:7897 FORK_RPC=https://mainnet.base.org python3 scripts/acceptance-retention.py
```

The runner executes compile, typecheck, `npm run scenarios` with K included at the
pinned Base block 51,000,000 (pool warming is retained), relay E2E, entry-point E2E,
deployment refusals, and the full maintained audit test set (governance/NAV, economic,
work templates and account/relay). Each job's complete output and exit status is
preserved; a failure makes the runner fail. The untracked t15 lotCount experiment
predates this branch's journal and is not part of the maintained suite. Frozen a/b
comparison variants are historical research fixtures, not acceptance implementations.

`t18 --legacy` installs the prior monolithic token only in an empty owned local DAO:
it is RED because processing accepts an unsettled window. The same test against the
normal deployment is GREEN. t16 retains the exit40/return40 counterexample, multiple
windows, same-timestamp starts/mints, zero-exit behavior, registration access controls,
YES-member departures and the independent 36-step/6-window oracle. GOV-03/GOV-04 are
rerun with the explicit settlement step and preserve their economic assertions.
