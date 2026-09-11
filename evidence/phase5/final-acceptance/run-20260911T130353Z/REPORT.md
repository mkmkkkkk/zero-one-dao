# Zero One DAO — Phase 5 Final Acceptance (clean-clone re-run)

- **Certified HEAD commit:** `afedfc87117a290a8fa8c36f3b7ad5157ede8dfb` (origin/main)
- **Clone:** fresh `git clone --branch main`, then `npm ci` (exit 0), `npm run compile` (exit 0).
- **Node** v22.16.0, **npm** 10.9.2, anvil 1.7.1 (via `@foundry-rs/anvil-darwin-arm64`, resolved by src/devnet.ts — the npm bin shim is absent on a clean clone by design).
- **Base fork:** local Anvil fork of Base (chain 8453) pinned at block 51000000; upstream read from `https://mainnet.base.org` (direct, no proxy needed). No transaction sent on any public chain.
- **Run dir:** this directory; per-job stdout+stderr under `logs/`.

## Verdict

**NOT MAINNET-READY (per the strict "every job green" rule): 1 red — `evidence/audit/governance-nav/t15-retention-round2.ts` (exit 1).**

All 40 other jobs are green (compile, typecheck, 12 scenarios incl. K on the Base fork, e2e:relay, e2e:entry-point, test:deploy-refusals, e2e:base-fork, and 34 of 35 audit tests).

### The single red — t15, with context (reported, not fixed)

t15 is a **local-only round-2 review** that, by its own docstring, "Default asserts the deficit specification (**RED on dcb3e83**)" — i.e. its default mode is intentionally red against an *old* commit and only goes green under `--candidate` (a local anvil_setCode fix experiment). It is **not one of the 15 GOV/NAV acceptance rows** in the governance-nav README (those are t01–t14); it and t16–t18 are supplementary.

On current main it does not even reach its by-design red exit: it **crashes uncaught** because the shipped NavShareToken now *reverts* `exitedSince` when retention is unsettled — phase-5 semantics the test predates:

```
ContractFunctionExecutionError: The contract function "exitedSince" reverted.
Error: RetentionUnsettled(uint256 proposalId, uint256 cursor, uint256 end)
                         (1, 1, 3)
  function:  exitedSince(uint256 proposalId)   args: (1)
```
```
main().catch(e=>{console.error(e);process.exitCode=1;});   // -> exit 1
```

This is **not** the stale-artifact exception (`exitedSince` is present in the freshly-compiled ABI and reverts at runtime; artifacts were rebuilt via `npm run compile`). It is a genuine, deterministic, local-only result: a supplementary review test written against old-commit semantics, left unmaintained against the current retention-settlement design. A certifier scoping the gate to the 15 documented GOV/NAV rows + the other suites would read all-green; by the literal "every audit test under evidence/audit/" rule it is red.

## Job table

| # | Job | Command | Exit |
|---|-----|---------|------|
| 1 | compile | `npm run compile` | 0 |
| 2 | typecheck | `npm run typecheck` (tsc --noEmit) | 0 |
| 3 | scenarios (A–L, K on Base fork) | `FORK_RPC=https://mainnet.base.org npm run scenarios` | 0 |
| 4 | e2e:relay | `npm run e2e:relay` | 0 |
| 5 | e2e:entry-point | `npm run e2e:entry-point` | 0 |
| 6 | test:deploy-refusals | `npm run test:deploy-refusals` | 0 |
| 7 | e2e:base-fork | `FORK_RPC=https://mainnet.base.org npm run e2e:base-fork` | 0 |

### Audit — governance-nav (each `npx tsx t*.ts`)
| test | exit |
|---|---|
| t01-lowgas-process-kills-proposal | 0 |
| t02-vote-weight-survives-exit | 0 |
| t03-retention-bypass-deposit-at-processing | 0 |
| t04-hole1-instance-usdc-invisible | 0 |
| t05-empty-safe-repricing | 0 |
| t06-last-holder-inflation | 0 |
| t07-retention-veto-flash | 0 |
| t08-baalgas-20m-blocks-chain | 0 |
| t09-minretention-boundary | 0 |
| t10-one-second-periods-terminal | 0 |
| t11-same-tx-roundtrip | 0 |
| t12-sponsor-order-delays-execution | 0 |
| t13-ready-proposal-vs-later-depositor | 0 |
| t14-nav07-safe-dust-does-not-pause-deposits | 0 |
| **t15-retention-round2** | **1 (RED)** |
| t16-retention-mechanism | 0 |
| t17-zero-empty | 0 |
| t18-incremental-settlement | 0 |

### Audit — account-relay / work-templates / ops-economic
| test | exit |
|---|---|
| account-relay/intent-account.test | 0 |
| account-relay/relay-adversarial.test | 0 |
| work-templates/work-invariants | 0 |
| work-templates/strategy-price-reference | 0 |
| work-templates/project-config-edges | 0 |
| work-templates/factory-create2-onlysafe | 0 |
| ops-economic/T01-founder-key-compromise | 0 |
| ops-economic/T02-sponsor-key-compromise | 0 |
| ops-economic/T03-pre-genesis-window | 0 |
| ops-economic/T04-usdc-blacklist | 0 |
| ops-economic/T05-deploy-refusals | 0 |
| ops-economic/T06-capture-small-treasury | 0 |
| ops-economic/T07-config-shortening | 0 |
| ops-economic/T08-spam-economics | 0 |
| ops-economic/T09-hidden-treasury-effect | 0 |
| ops-economic/T10-contract-member | 0 |
| ops-economic/T11-exit-cost-deployed-capital | 0 |
