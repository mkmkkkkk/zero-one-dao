# Phase 5 Base Sepolia rehearsal

Status: **BLOCKED; full acceptance is not earned**. Historical phase 3 receipts are not used as phase 5 proof.

Measured delivery status:

| Requirement | Result | Evidence |
| --- | --- | --- |
| Fresh phase 5 stack + genesis; archive old stack | PASS | `deploy.log`, new deployment record, `source-and-archive-integrity.json` |
| Canonical deployed addresses verified on Basescan | 20/20 | `verification-result.json` |
| New relay state + canonical build + Vercel rebuild | Configured; mirror READY | `service-readback.json`, `vercel-deploy-ledger.log` |
| Canonical public README and live validator | BLOCKED at delivery: 530 / 1033 | Earlier 200 and 13-fetch PASS retained; `canonical-final-*`, `validate-canonical-recheck.log` show current failure |
| Native A–L | 12/12 PASS | `scenarios-summary.json`, logs on each row |
| Changed contract corner rows | 33/33 PASS | `contract-corners-combined.json` |
| Phase 5 deficit/return, settlement, task liability, gas cap, call-only execution | PASS | `phase5-contract-corners-rerun.log`; L adds budget NAV and settled gates |
| Relay/adapter corners and 100 proposals | 12/12 PASS | `relay-corners-combined.json`, 100 distinct proposal receipts |
| Two full cold starts from two machines | BLOCKED | Mini T1 partial; real governance wait; second-machine identity/result unknown |

Actual summary output (`native-summary.log`):

```text
NATIVE CONTRACT CORNERS: 33/33 rows with current-run evidence
NATIVE SCENARIOS A-L: 12/12 PASS (failed attempts retained; L completed on its original DAO)
```

## Deployed source and records

- Chain: Base Sepolia, 84532. RPC: `https://sepolia.base.org`.
- Contract source / immutable Constitution commit: `06a0bf010480dbbab2cca58892dc5a1ee1a95ff7`, confirmed against the advertised remote `main` before deployment. No push was performed.
- `deployments/base-sepolia.json` contains the fresh stack and genesis transaction. `source-and-archive-integrity.json` checks all 25 Solidity sources against the merge and all 28 archived old files byte for byte.
- The old record is `deployments/base-sepolia-phase3.json`; old verification inputs and readbacks are in `deployments/verification-base-sepolia-phase3/`.
- `deploy.log`: the new Safe/Baal/token/shaman/WorkManager/TreasuryLedger/factory/template-deployer/intent-account/Constitution stack and the same-run 50 mock-USDC genesis deposit.
- `verification-result.log`: **`BASESCAN SOURCE READBACK: 20/20 verified`**. The JSON manifest links each address, the corresponding explorer source readback, its SHA-256 and the Baal proxy's new implementation. Submission GUIDs alone do not count as verification.

## Served deployment

- Canonical: `https://relay-zero.mkyang.ai/README.txt`. `README-headers.txt` and `README-served.txt` capture the actual HTTP response and new addresses.
- launchd uses `deployments/base-sepolia.json`, `state/relay-base-sepolia-phase5` and `beacon/public-phase5`. `service-config.json` and `service-readback.json` record the resulting deployment identity. No old requests or T0 passes were imported.
- `validate-canonical-delivery.log`: delivery-time validation of the canonical origin, 13 live fetches, 44 README lines and 12 addresses with code. `README-delivery-headers.txt` and the mirrored counterpart both report HTTP/2 200. The validator's reported block is the local build checkpoint, not a claim that live state stopped advancing.
- Vercel mirror: `https://zero-one-beacon.vercel.app`; `vercel-deploy-ledger.log` records provider readiness for the rebuild containing TreasuryLedger, with actual mirrored README response files alongside it.

Delivery-time reachability regression: the follow-up at **2026-09-10T21:19:53Z** returned **HTTP/2 530**, body **`error code: 1033`**, from the canonical README. `canonical-recheck-headers.txt` / `canonical-recheck-body.txt` preserve the response. The local launchd relay still returns HTTP 200 (`local-health-headers.txt`, `local-health-delivery.json`); `tunnel-delivery-readonly.log` records `TLS handshake with edge error: EOF`. The user's explicit no-network-change boundary prevents changing tunnel/network configuration. `validate-canonical-recheck.log` independently fails its live fetch with `530 !== 200` and `exit_code=1`. Earlier 200/validator evidence remains valid for its timestamp, but current canonical reachability is **blocked** until a new live 200 and validator pass are obtained.

## What the new test receipts prove

Native scenario logs and records are collected in this directory. Each scenario uses its own DAO deployed from the current Solidity artifacts; shared test singletons and mock settlement come from the fresh deployment.

- `scenarios-A-J-L.log`: initial A–G run. B initially failed, then `scenarios-B-H-I-J-L-rerun.log` reported `SCENARIO B: PASS` with settlement transaction `0xa72f0c27585aad29fc8ed12d4e7ecbc80c45111876b0c920050377fbc2cb7917`. This corrected process reports B/H/I/J PASS and stops at J; `scenarios-L-native.log` runs L with isolated signer/actors. The boundary logs explain why the original batch exit is 143, rather than presenting it as a fully passing batch.
- `scenario-K.log`: real Sepolia Uniswap v3 calls on an owned mock pair, after a real 1800-second oracle history. Lifecycle, output bounds and atomic spot-manipulation tests are separate assertions. Public dependencies are checked against the [official Base Sepolia deployment table](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments).
- `scenario-K-weth18.log`, `K/weth18.json`: the 18-decimal WETH companion, including actual buy/sell amounts and venue allowance/balance cleanup. This is separate from K's six-decimal mock-pair fixture.
- `scenario-K-window-refusal.log`: a mined constructor revert before the real WETH pool has 30 minutes of history, decoded as `WindowUnavailable`; `K/window-refusal.json` records its hash and block. `scenarios/K-spot-threshold-sepolia.ts` additionally checks that a manipulated spot portfolio crosses the actual voted stop-loss threshold while the unchanged TWAP value does not; `scenario-K-spot-threshold.log` reports **NATIVE SPOT THRESHOLD COUNTEREXAMPLE PASS** with receipt `0x82a21a730a750e46698fe9363c9ee47dc460eaf7666592f6d147e9e92e02dff4`. The hypothetical spot value was 6,056,121, below the 7,500,000 stop threshold; the TWAP value remained 12,379,660 (all settlement base units).
- `phase5-contract-corners-rerun.log`: **PHASE5 CONTRACT CORNERS PASS**. It proves account-specific retention deficit, another account's ineffective deposit, exit-and-return repair, incremental settlement, atomic unsettled refusal, task-share liability, the baalGas cap and a voted delegatecall refused by MultiSendCallOnly. The first attempt in `phase5-contract-corners.log` lacked enough free test ETH for the gas reserve; it is retained as a failed attempt.
- `corner-cases*.log` and JSON: changed money/governance/template rows, including zero-supply donations, actual ERC-20 recipient behavior, voted migration and retention boundaries. The initial template footer said PASS despite a row mismatch; the aggregate `24/25` result is authoritative. The follow-up in `corner-cases-migration-followup.log` reports **NATIVE MIGRATION CORNERS PASS**, distinguishing the correctly refused EOA from an actual non-template contract; transaction `0x1877ca6a592368ecf55928c3c03a763037a8cbb7dc7735b99dcbe73859520c6d` transfers exactly 100 mock USDC to that contract. Negative simulations are described separately from mined reverts.
- `corner-cases-relay.log`: a disposable loopback relay on the fresh `corner-money` Sepolia DAO, with its own sponsor and never-used state. It tests T0 entropy, adapter replay/domain/delegation/thresholds, duplicate instances, 100 proposals, pagination and burst limits. This run hit the real sponsor-balance reserve after 24 proposals. `corner-cases-relay-spam-resume.log` continues the same account after the recorded free-test-ETH top-up; `relay-corners-combined.json` contains 100 distinct proposal receipts and **12/12** current-run passing rows. The initial immediate index read was one proposal behind; the final readback waited for the index rather than submitting duplicates. `relay-corners-resume-runner-4.log` records the temporary relay shutting down, and port 18871 was checked clear.
- `receipt-readback.json`: independent RPC receipt readbacks, including actual status/block/gas and the log or deployment record that referenced each hash. Intentional reverts are not silently counted as successful transactions. Final independent readback at 2026-09-10T21:28:21.265Z: **1350 collected receipts, 1329 success, 21 reverted, 0 unknown**. This is the receipt set extracted from the supplied native logs/records; it is not a count of every transaction ever sent by the signers.

Additional native red-to-green checks:

- L ran out of free test ETH at the submission of proposal #10, after proving the 100k budget pricing, both settled gates, and unwind. `resume-actor-gas-topups.log` records the test-account top-ups. `scenarios-L-native-resume.log` reports SCENARIO L PASS. It attaches to the same DAO, checks proposal count 9 and its live S3 asset balance, and executes the remaining three governance proposals and final dust/atomic assertions.
- The retention boundary submission reverted with 270244 gas. `vote-gas-diagnosis.json` replays the identical calldata at the preceding block: the original limit fails and 390244 succeeds. The shared test sender reserves 120000 additional gas for checkpoint appends across block timestamps. The resume script checks the same DAO still has exactly 100 shares and two proposals before retrying.
- `corner-cases-same-block-vote-resume.log` reports **NATIVE SAME-BLOCK VOTE REFUSAL PASS**. `same-block-vote.json` records an atomic submit+vote with a decoded `TimePointNotDetermined(uint256,uint256)` event and a successful later-block vote. The original back-to-back transaction row did not land in the same block and is superseded by this direct proof. The disposable probe's recursive input is `same-block-probe-input.json`; it is test instrumentation, separate from the 20 canonical deployed addresses. Its first selector mismatch and a second vote that landed in the same block remain in the red logs.

Local regressions supplement these receipts; they are not substitutes for Sepolia tests:

- `relay-readme-settlement-red.log` reproduces `422 RetentionUnsettled` for a signed README execution after an outside mint/burn. `relay-readme-settlement-green.log` reruns the same path successfully after the relay settles bounded chunks through its locked, journaled sponsorship path.
- `B-lag-diagnosis.json` demonstrates a pre-settlement block returning `RetentionUnsettled` and a later block returning the correct deficit. The shared helper now propagates the observed settlement block into the next simulation.
- `corner-votes-local-green.log` reports `10/10 rows OK`, including the fork's `!voting` refusal and exact 33.9%/34% boundaries. The old `ended` expectation remains visible in the failed native log. `corner-cases-votes-rerun.log` proves the corrected native voting/time refusals and actionFailed payment; the final retention rows continue in `corner-cases-vote-boundaries-resume.log`.
- Failed pool gas, block-lag, error-decoding and test-account gas-reserve attempts remain in the `*-red.log` files or their original failed logs. They do not earn acceptance.

## Cold-start blockers and resumption

`cold-start-mini-T1.log` is a partial real-chain outside-agent path. `relay/cold-start-readme.mjs` uses Node builtins and downloads only the served README and snippet for protocol information; private resume material is confined to ignored `state/cold-start-phase5-mini-T1/`.

`canonical-governance-delivery.json` independently reads the current 21600/21600 periods and both still-unprocessed proposals at block 46653696. The recorded grace-end timestamps below are boundaries; execution must occur in a chain block after them.

The canonical Config proposal #1 was voted under the initial 21600 s / 21600 s periods. It requests test-only 120 s / 120 s, but is not executable until **2026-09-11T07:14:24Z** (15:14:24 Asia/Shanghai). The mini's Payment #2 is not executable until **2026-09-11T07:28:22Z** (15:28:22 local). These real-chain waits cannot be replaced with a local clock advance.

After the actual deadlines, execute #1 using `scripts/testnet-governance.ts --execute 1 --data <the proposalData printed in governance-120s.log>`, then resume the mini T1 path with:

```sh
node relay/cold-start-readme.mjs --mode T1 --beacon https://relay-zero.mkyang.ai --work state/cold-start-phase5-mini-T1
```

The resumed task proposal has its own real voting/grace wait; rerun with the same private work directory until it reports a full pass. Restore 21600 s / 21600 s by a final voted Config only after both full cold starts finish.

The second machine remains **blocked**: known SSH endpoints either timed out or refused authentication. `second-machine-access.json` records the actual attempts; second-machine identity and cold-start result are **unknown**. Computer Use also refused Terminal access on safety grounds; that restriction was not bypassed, and the UI lock was released. A working authorized second-machine SSH target is still required. The second machine must start a new T0 path from the served README/snippet, not copy the mini's pass or private state.

No mainnet transaction, paid account, card binding, marketing or push is part of this rehearsal. Keys, environment files and relay/agent state are excluded from the delivery commit.

## Delivery checks and cleanup

`typecheck-delivery-final.log` records `tsc --noEmit` with `exit_code=0`. Source/document whitespace checks pass; raw CLI/HTTP evidence deliberately retains its original whitespace and CRLF headers. Credential scans compare actual private values with staged bytes and report zero matches. State, keys, environment files and the pre-existing `docs/REVIEW_RETENTION.md` are excluded.

The requested launchd relay remains as the persistent service. Disposable local test relays/Anvil processes and task watchers exited; no browser tabs were created. No automatic hours-long waiter is left running. The pending cold starts require the real deadlines, restored canonical reachability and an authenticated second machine.
