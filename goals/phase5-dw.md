# Phase 4 + 5 on branch phase4-ledger-twap (DW, local main Mac) — the complete pre-mainnet fix set

Authority: decision.md sections "2026-09-09 phase 4 rulings" and "2026-09-09 phase 5 rulings" (final), goals/phase4-finish.md
(original scope), docs/SECURITY_AUDIT.md (the failing tests under evidence/audit/ are the acceptance oracle: every Critical/High
test named in the must-fix list must flip to the expected outcome). Branch already holds codex WIP: contracts/TreasuryLedger.sol,
UniswapV3Venue.sol (spot, must become TWAP), TickMath.sol, partial scenario L/K, docs edits. Build on it, do not restart.

Hard rules for every stage: never run rm; commit on this branch with git user.email yangzk01@gmail.com after each green step
(small commits, message says what); never push; no public-network transaction (anvil + anvil fork only, fork RPCs
https://mainnet.base.org / https://base-rpc.publicnode.com / https://base.drpc.org); Google-style docstrings on every function;
no owner/admin/pause anywhere; docs/CONSTITUTION.md and the CLAUDE.md principle untouched; failing is not an outcome — a red test
is fixed (code or test, say which), an interrupted subtask is redone by you.

Stage A — contracts + mirror (scenarios A–J stay green, L added, audit tests flipped):
 A1 TreasuryLedger per phase 4 ruling amended by phase 5 ruling 4: settled() looks only at open instances' asset holdings;
    depositTreasury = Safe USDC + Σ open-instance USDC; share liability = Σ Active-task rewardShares (WorkManager view);
    DepositShaman: shares = amount × (totalShares + liability) / depositTreasury; refuse TreasuryNotSettled; while
    totalShares == 0: 1 USDC = 1e18 shares regardless of treasury (zero-supply trap removed; genesisDeposit refuses only
    supply > 0). Strategy stop(): settlement raw to Safe, asset stays, instance stays open; new onlySafe unwind() sells via the
    venue with the rule's slippage bound and then closes; migrate() unchanged (moves both raw, closes).
 A2 Baal fork (vendored copy under contracts/ or a patched build; keep the diff to a few lines and record it in
    docs/PARAMETERS.md): submitProposal requires baalGas <= 8_000_000; processProposal retention =
    burned(now) − burned(votingStarts) <= (100 − minRetention)% × pastTotalSupply(votingStarts), using a timestamp-checkpointed
    cumulative burned counter on NavShareToken. Our submit paths (src/proposals.ts, ZeroOneIntentAccount, WorkManager) set
    baalGas = simulated × 1.5 capped at 8M.
 A3 MultiSendCallOnly replaces MultiSend everywhere the Safe executes (deploy + proposalData builders).
 A4 WorkManager.confirm() reverts after the task expiration; claim timeout (W-2); Project end()/release() race (T-7).
 A5 Scenario L (see goals/phase4-finish.md §3) + flip audit tests: GOV-01, GOV-03, GOV-04, GOV-05 (t08: #2 processable after
    cap), NAV-01, NAV-07 (dust on Safe must NOT pause deposits), W-1, OPS-03. Put each run's key output lines in
    evidence/phase5/<id>.log. `npm run scenarios` green.
Stage B — TWAP venue + fork: UniswapV3Venue price() = 30-min TWAP (observe), execution bound against TWAP-implied output,
    constructor refuses pools that cannot serve the window; scenario K on a Base fork proving: same-block spot move > 20% leaves
    price() unchanged and makes run() revert on the bound; after restoring, run() succeeds; T-4/T-5 tests flip. Log to
    evidence/phase5/uniswap-twap-fork.log. If the venue constructor fails on the fork (codex's last red), decode the revert,
    check the real pool's observation cardinality, and fix.
Stage C — relay + beacon + docs: relay decodes TreasuryNotSettled, exposes settled/depositTreasury/liability on /state.json and
    /me; approve/increaseAllowance counted as treasury effect; operation ≠ 0 flagged; instance panel bound to decoded calls;
    ok only after broadcast + /pending.json; rate-limit counter persisted before rejection; 128-bit entropy floor on T0 pass;
    /me flags Config proposals cutting voting+grace below 3600 s or terminal shapes. Docs: DESIGN §6c (≤ 8 lines), PARAMETERS
    (ledger, TWAP window, baalGas cap, retention rule, Baal diff, disclosures OPS-05/NAV-05/ECO-08/NAV-02/NAV-06/ECO-05/ECO-09/
    A5-13/A5-14/A5-07, Config terminal shapes), TEMPLATES lifecycle (open/close/unwind), RELAY.md, README ≤ 44 lines with the
    settlement line and the T0 line ("the relay operator can delay or drop your intents; anything you cannot afford to lose goes
    through T1"). `npm run e2e:relay` green; beacon validate green with line count logged.
Stage D — acceptance from a clean clone of the branch into a temp dir under the scratchpad: scenarios A–L, e2e:relay, K with
    FORK_RPC, every flipped audit test, no-admin grep; write evidence/phase5/acceptance-rerun.log and a short review of any
    ruling the code could not honour verbatim (say exactly where and why).
