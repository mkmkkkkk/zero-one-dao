# G3 execution receipt — 2026-09-21

Implemented schema, real Spring replay oracle, standalone bond, automated Base Sepolia release and slash. All funds below are test coins. No mainnet request or key, paid account, live relay mutation, browser, push, content queue, or existing WIP edit was involved.

## Scope choice and blocked interface

Chose zero-one-dao as the schema/implementation home; Compat Foundry only gains a backlink. Disk and live health expose no commitment/release/slash primitive. Chose the explicitly permitted new standalone testnet contract, with direct clients. Existing relay bond receipt/E2E is **blocked: these verbs and deployed primitive are absent**; health replies are saved, not misrepresented as bond receipts. No relay/tunnel settings, ports, processes, or existing contracts were changed.

The named oracle is trusted to replay truthfully and remain available. The chain checks its identity and committed hashes, not Java execution. This is not a trustless execution proof. Failure injection is explicitly marked and changes the effective runtime compatibility flag; it is not an observed spontaneous defect.

## Actual output: red then green

```text
{"stage": "red", "command": ["/Users/michaelmacmini/Documents/Workspace/zero-one-dao/state/g3/venv/bin/python", "scripts/behavior/acceptance.py", "evidence/g3/example.contract.json", "--out", "evidence/g3/acceptance-red", "--inject-drift"], "exit_code": 1, "stdout": "{\"verdict\": \"fail\", \"evidence_hash\": \"0x88754d50294617fb6f14d45f747c70138aa5dc2cb2f80138bb5f94d72af81ed3\"}", "stderr": ""}
{"stage": "green", "command": ["/Users/michaelmacmini/Documents/Workspace/zero-one-dao/state/g3/venv/bin/python", "scripts/behavior/acceptance.py", "evidence/g3/example.contract.json", "--out", "evidence/g3/acceptance-green"], "exit_code": 0, "stdout": "{\"verdict\": \"pass\", \"evidence_hash\": \"0x0d88e5273be14a9f4041995a3bf1e0caa096084a75249b66b144eae495558dc8\"}", "stderr": ""}
```

## Test results

```text
test_disabled_repair_fails (__main__.BehaviorTests.test_disabled_repair_fails) ... {"verdict": "fail", "evidence_hash": "0x88754d50294617fb6f14d45f747c70138aa5dc2cb2f80138bb5f94d72af81ed3"}
ok
test_invalid_contracts (__main__.BehaviorTests.test_invalid_contracts) ... ok
test_missing_artifact_blocks (__main__.BehaviorTests.test_missing_artifact_blocks) ... ok
test_repaired_artifact_passes (__main__.BehaviorTests.test_repaired_artifact_passes) ... {"verdict": "pass", "evidence_hash": "0x0d88e5273be14a9f4041995a3bf1e0caa096084a75249b66b144eae495558dc8"}
ok
test_replaced_artifact_fails_without_execution (__main__.BehaviorTests.test_replaced_artifact_fails_without_execution) ... ok
test_valid_contract (__main__.BehaviorTests.test_valid_contract) ... ok

----------------------------------------------------------------------
Ran 6 tests in 1.541s

OK
PASS unauthorized oracle rejected
PASS pass before expiry rejected
PASS no-result settlement rejected
PASS early dispute settlement rejected
PASS pass release exact bond, escrow empty
PASS duplicate settlement rejected
PASS failure overrides pass and cannot be erased
PASS wrong contract hash rejected by client
PASS slash transfers exact bond to beneficiary, escrow empty
owned anvil stopped
Draft202012Validator.check_schema: OK
> zero-one-dao@0.1.0 typecheck
> tsc --noEmit
```

Legal/illegal persisted inputs and validation results: [schema-cases.json](schema-cases.json). Six Python tests include legal/illegal schema, repair pass, disabled repair fail, substituted artifact fail without execution, and missing artifact blocked. Nine real local-EVM checks cover identity, expiry, dispute, exact payouts, hash binding and repeat settlement.

## Base Sepolia 84532: actual receipts

### release

- New contract: `0xc78ddb609c88455befd48fd15e00e082c9412d69`
- Contract SHA-256: `0x15ee138cb05efcfc2d7af740652419988c2f2ea5c86a13404a9382b2b0b1bcc6`
- Commit transaction: `0x6b0dfecac54f9a6f762940f5e7f380435d0985625c4180c3c93d66f5ebb32644`
- Oracle report transaction: `0xbfc110045ee40acd558937578568103f9c1ecc4bb8405d94d5a3d30fe8b7f75c`
- Settlement transaction: `0x63c383d6bb4a8a2a6df4ba7fd447ff14c3110b8ec403316de65eb71b96ea1719`
- Recipient: `0x40f89c277366424ED6Fb728A0D76376aa7aCE885`
- Recipient before → after: `6908768990784 → 6909768990784` wei (delta `1000000000`).
- Escrow at commitment → after settlement: `1000000000 → 0` wei.

Actual adjudicator output:

```json
{"verdict":"pass","evidence_hash":"0x918eb3cf6377236b6d492e4eafb27d63fa9eb343c2c94c15b05d5527033457c6"}
```

[Contract JSON](sepolia-release/contract.json), [replay evidence](sepolia-release/replay/evidence.json), [journal and all actor balances](sepolia-release/journal.json), [independently fetched transactions/events/receipts](sepolia-release/independent-receipts.json).

### slash

- New contract: `0xa719de324da315cb7de52b9fba0b1199741bb53f`
- Contract SHA-256: `0x6d802c068ea4b944afad5a71d2995ca3d0fd01660b69e9aea042906d6695ac04`
- Commit transaction: `0x195989c5b104e24590e87d38f728ca3dfdd01925a730a7131cb0859b1a5528b1`
- Oracle report transaction: `0xa3043b6c6c416818fdc1e57dc927ad07aaa206469ab64be6330813363b48e6b1`
- Settlement transaction: `0x8e73149f53b8a4437ea0449946fd34e9ec2b08a18329ec0fb920f3e6a125fb69`
- Recipient: `0x808be63edCCa635c5B0F9b5C3cb2c44664CF8C95`
- Recipient before → after: `0 → 1000000000` wei (delta `1000000000`).
- Escrow at commitment → after settlement: `1000000000 → 0` wei.

Actual adjudicator output:

```json
{"verdict":"fail","evidence_hash":"0x5baba808554e082dbbc177b850aa199773617189700a094aec4017e263378747"}
```

[Contract JSON](sepolia-slash/contract.json), [replay evidence](sepolia-slash/replay/evidence.json), [journal and all actor balances](sepolia-slash/journal.json), [independently fetched transactions/events/receipts](sepolia-slash/independent-receipts.json).

## Independent verification and RPC exception

Initial independent check was red because the RPC-provided initial receipt carried a zero blockHash. That original journal and [failure output](independent-verification-initial-red.log) are retained. The verifier now requires a nonzero receipt blockHash matching the actual block, confirms the same block number, exact deployment calldata/value and report arguments, event hashes, settled storage, expiry/window timing, and recipient balance at settlement block minus one versus settlement block. The receipt helper was corrected to require canonical block anchoring; affected local-EVM tests were rerun green. No duplicate live transaction was sent.

```text
{"mode":"release","address":"0xc78ddb609c88455befd48fd15e00e082c9412d69","contract_hash":"0x15ee138cb05efcfc2d7af740652419988c2f2ea5c86a13404a9382b2b0b1bcc6","evidence_hash":"0x918eb3cf6377236b6d492e4eafb27d63fa9eb343c2c94c15b05d5527033457c6","commit_tx":"0x6b0dfecac54f9a6f762940f5e7f380435d0985625c4180c3c93d66f5ebb32644","report_tx":"0xbfc110045ee40acd558937578568103f9c1ecc4bb8405d94d5a3d30fe8b7f75c","settlement_tx":"0x63c383d6bb4a8a2a6df4ba7fd447ff14c3110b8ec403316de65eb71b96ea1719","recipient":"0x40f89c277366424ED6Fb728A0D76376aa7aCE885","before_wei":"6908768990784","after_wei":"6909768990784","payout_wei":"1000000000","escrow_after_wei":"0","verified":true}
{"mode":"slash","address":"0xa719de324da315cb7de52b9fba0b1199741bb53f","contract_hash":"0x6d802c068ea4b944afad5a71d2995ca3d0fd01660b69e9aea042906d6695ac04","evidence_hash":"0x5baba808554e082dbbc177b850aa199773617189700a094aec4017e263378747","commit_tx":"0x195989c5b104e24590e87d38f728ca3dfdd01925a730a7131cb0859b1a5528b1","report_tx":"0xa3043b6c6c416818fdc1e57dc927ad07aaa206469ab64be6330813363b48e6b1","settlement_tx":"0x8e73149f53b8a4437ea0449946fd34e9ec2b08a18329ec0fb920f3e6a125fb69","recipient":"0x808be63edCCa635c5B0F9b5C3cb2c44664CF8C95","before_wei":"0","after_wei":"1000000000","payout_wei":"1000000000","escrow_after_wei":"0","verified":true}
```

Final chain verification is fresh RPC data, not the sender's `verified` flag. This demonstrates inclusion in the observed canonical blocks, not a claim that an L2 transaction can never reorg.

## Funding and retained artifacts

Fresh promisor and oracle each received `10000000000000` wei from the documented Sepolia test deployer. Exact donor/recipient before-after balances, gas and transaction receipts are [funding-promisor.json](funding-promisor.json) and [funding-oracle.json](funding-oracle.json). The existing relay sponsor was not used. The remaining actor test funds and their mode-0600 keys remain under `state/g3/keys/`; no service uses them.

Actual repair JAR (local retained output): `state/g3/build-3.0.13/target/spring-trailing-slash-compat-1.0.0.jar`. SHA-256: `0x6c37cc597f2873488ed4897f8914e3f64ef38b340a55a0d727569e270c8ac068`. Original-source comparison: [fixture-provenance.json](fixture-provenance.json); baseline: [baseline.json](baseline.json). The original fixture is untracked WIP in Compat Foundry; only exact source snapshots are committed here, and that WIP was not staged or changed. Maven binaries remain locally readable in ignored state; source snapshot and rebuild script are committed. Rebuilding may change JAR timestamps, so measure a fresh contract rather than rewriting an existing commitment.

## Delivery and cleanup

[Behavior contract documentation](../../docs/BEHAVIOR_CONTRACT.md), [JSON schema](../../schemas/behavior_contract.schema.json), [adjudicator](../../scripts/behavior/adjudicate.py), [bond source](../../contracts/BehaviorBond.sol), [automated Sepolia client](../../scripts/behavior/sepolia.mjs), [independent read-only verifier](../../scripts/behavior/verify-sepolia.mjs).

Compat backlink commit: `e3b7aa1bc24225f17513fda299c50611a7e7fb65`. Both commits use `yangzk01@gmail.com` and the requested co-author trailers; final zero-one-dao commit hash is reported in the delivery response. No push.

Every JVM and owned local anvil was stopped and reaped. No browser was opened, and no persistent worker/server was started. Live relay `startedAt` is identical before/after in the two saved health responses. Existing Compat Foundry changes, including `events/inbound_events.jsonl` and all prior untracked WIP, remain.
