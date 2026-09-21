# G3: a bonded compatibility patch

This version guarantees only Compat Foundry's real `mvc-trailing-slash` replay,
not all 12 scanner rules. The source is the existing
[Spring fixture](../../compat-foundry/java-spring-trailing-slash/README.md);
[Compat Foundry integration](../../compat-foundry/BEHAVIOR_CONTRACT.md) links back here.
The [schema](../schemas/behavior_contract.schema.json) is Draft 2020-12 and each
property includes its reason in `description`. The
[complete example](../evidence/g3/example.contract.json) uses actual measured hashes.

## Disk findings and choice

The checked-out decision.md, DESIGN.md, PARAMETERS.md, RELAY.md, contracts, and
live relay `/health.json` do **not** contain the background's commitment/bond/
release/slash primitive. Existing verbs are join, deposit, task, deliver, propose,
vote, execute, ragequit, work, confirm. The live service is **Base Sepolia 84532**,
not Ethereum Sepolia 11155111. Chosen: an independent, new
[BehaviorBond](../contracts/BehaviorBond.sol) plus direct Sepolia client, as the
request permits new logic and testnet deployment. No existing instance, DAO
parameter, relay file, process, port or tunnel is modified. A bond transaction
receipt from the existing relay is **blocked: unsupported interface**. RPC receipts
are the actual settlement evidence; they are not called relay receipts.

## Fields and why each is necessary

| Field | Meaning and reason |
|---|---|
| `schema_version` | Selects exact validation and hashing semantics. |
| `contract_id` | Distinguishes separately bonded deliveries. |
| `chain_id` | Fixed 84532; stops accidental mainnet funding. |
| `promisor` | Names the bond owner and pass-refund recipient. |
| `beneficiary` | Fixes who receives failure compensation; must differ from promisor. |
| `patch.artifact` | Locates the exact delivered JAR; a CLI mirror must have the same hash. |
| `patch.sha256` | Binds the guaranteed binary; replacement is a failure without executing that binary. |
| `patch.source` / `spring_boot` | Identifies fixture provenance and the covered upgraded runtime. |
| `replays[].drift_id` | Links the covered behavior to the existing drift catalog; unique IDs only. |
| `replays[].command` | Records the exact application command. It is allowlisted, never shell-evaluated. |
| `replays[].request` | Fixes `GET /api/greeting/`, so another endpoint cannot satisfy the clause. |
| `replays[].normalization` | Defines stable status/body JSON bytes, avoiding timestamps in Spring's error body. |
| `replays[].expected_output_sha256` | Pins the measured Boot 2 baseline output; no discretionary interpretation. |
| `bond.amount_wei` / `currency` / `decimals` | Exact integer liability and units: native **test** ETH, 18 decimals; no floating point. |
| `oracle.kind` / `address` | Declares the trusted runner and signer allowed to publish results. |
| `oracle.runner_sha256` | Pins the adjudicator implementation; validator rejects a different implementation. |
| `oracle.evidence_commitment` | Canonical evidence SHA-256 is submitted in an on-chain event and storage. |
| `oracle.relay_validation` | Explicitly states that the current relay does not check this evidence. |
| `starts_at` / `expires_at` | Unix seconds define coverage start and the final pass replay time; expiry must be later. |
| `release_condition` | Requires a pass replay after expiry and the report's dispute window. |
| `slash_condition` | Output or artifact hash mismatch triggers failure; infrastructure errors never imply failure. |
| `dispute.seconds` | Minimum wait after a report before permissionless settlement (demo: 6 seconds). |
| `dispute.policy` | A runner rerun can supersede pass with fail; fail cannot be erased. No human arbitration. |
| `dispute.unavailable_oracle` | Without a report the bond stays locked; no fabricated timeout verdict. |

The schema intentionally supports exactly one proven Spring clause today. Extending
to the other rules requires real replay evidence and a new schema/runner version.

## Hashes and executable adjudication

SHA-256 is written as lowercase `0x` plus 64 hex digits, including on-chain bytes32.
Contract/evidence canonicalization: recursively sort object keys, preserve array
order, no whitespace, ASCII-escaped JSON, no floats; no trailing newline in the
hashed bytes. File formatting is not hashed. Artifact/runner hashes cover exact
file bytes. Contract hash covers **every** contract field, including participants,
times, bond, runner and acceptance hashes. Evidence includes that contract hash,
actual artifact hash, actual response, expected/actual output hashes, verdict and
fault-injection flag. [Independent verifier](../scripts/behavior/verify-sepolia.mjs)
recomputes hashes and fetches receipts/storage directly from the fixed testnet RPC.

The exact application argv is `java -jar ${artifact} --compat.trailing-slash=true`;
the trusted harness appends a free loopback port and `--server.address=127.0.0.1`.
It waits on `/api/greeting`, then probes `/api/greeting/`. The response hash covers
`{"body":"Hello from legacy route","status":200}`. For JSON error responses only
`timestamp` is removed; all other fields remain. It does not hash Maven console
noise, port numbers, request times, or server logs. Readiness, missing files,
invalid schema, runner mismatch, and network/JVM errors exit blocked rather than
slash. Every started JVM is terminated and reaped in `finally`.

`--inject-drift` disables the repair flag in the actual Boot 3 process. It reproduces
the unpatched upgraded behavior (404), not the Boot 2 baseline (200). The JAR hash
is unchanged: the failure proves the behavioral predicate, not only file-integrity
checking. The evidence labels this deliberate testnet injection. It is not evidence
that the repair spontaneously regressed.

## Settlement and trust boundary

One immutable contract per promise escrows 1,000,000,000 wei of Base Sepolia test
ETH. Constructor pins contract SHA-256, owner, beneficiary, oracle, start, expiry,
dispute window, and paid bond. The client checks all bindings before reporting.
Only the oracle can `report(failed, evidenceHash)`; the client obtains `failed`
from the executable replay, not a caller-supplied verdict. A pass can be reported
only after expiry. A fail may replace a pass before settlement and restarts the
window. Once fail is recorded it cannot become pass. After the window anyone can
`settle()`: pass refunds owner, fail pays beneficiary; exactly once. No report
means locked funds until the oracle returns. There is no promise of continuous
monitoring or an always-running worker in this delivery.

The EVM verifies the authorized signer, time, hashes, and payout. It **does not
verify Java execution**. The named oracle can lie or withhold a report, and a hash
alone provides neither truthful execution nor evidence availability. This is an
automated named-oracle guarantee, **not trustless/no-discretion insurance**. Third
parties can replay and compare evidence, but cannot override the oracle on-chain.
A fully trustless execution proof is outside this delivery. Evidence JSON must be
retained off-chain; this run commits it to the repository. No production/mainnet
support, paid account, token approval, or existing DAO authority is involved.

## Reproduce

Requirements: existing npm lock dependencies, Maven, JDK 17 at the local Homebrew
path used by Compat Foundry; Python `jsonschema==4.26.0`. All commands run from
zero-one-dao. Build copies preserve original compat WIP and keep generated binary
files in ignored `state/g3/`. The two fixture source files in `evidence/g3/fixture`
are byte-for-byte copies of the real original, not substitute implementations.

```sh
npm install --ignore-scripts
python3 -m venv state/g3/venv
state/g3/venv/bin/pip install -r scripts/behavior/requirements.txt
python3 scripts/behavior/build_fixture.py
node scripts/behavior/init-testnet.mjs
state/g3/venv/bin/python scripts/behavior/test_replay.py
state/g3/venv/bin/python scripts/behavior/red-green.py
node --import tsx scripts/behavior/test-bond.mjs
```

`build_fixture.py` refuses to overwrite an existing build. On this machine use the
existing recorded JARs. Rebuilding may change JAR timestamps and hence the binary
hash: create a **new** contract with the freshly measured hash, never rewrite an
old promise to match it. `init-testnet.mjs` retains newly generated mode-0600 keys
in `state/g3/keys/` and creates the example from a fresh baseline observation.

```sh
state/g3/venv/bin/python scripts/behavior/adjudicate.py \
  evidence/g3/example.contract.json \
  --artifact state/g3/build-3.0.13/target/spring-trailing-slash-compat-1.0.0.jar \
  --out state/g3/my-replay
```

The adjudicator prints `{verdict: pass|fail, evidence_hash}`. Invalid/infrastructure
input prints `{status: blocked, reason}` and exits 2. `acceptance.py` provides the
CI gate (pass exits 0, measured fail exits 1). The red-green runner executes this
same gate with the repair disabled (red) then enabled (green).

Testnet write steps, already exercised in this delivery:

```sh
node scripts/behavior/fund-testnet.mjs
node scripts/behavior/sepolia.mjs
node scripts/behavior/verify-sepolia.mjs
```

Funding uses only the documented testnet `.env.sepolia` key, after verifying RPC
84532 and donor address. New owner and oracle each get 0.00001 test ETH. No relay
sponsor or mainnet key is read. Fixed Sepolia RPC and on-chain chain-id guards
reject mainnet. Local EVM tests use chain 31337. Write scripts preserve broadcast
hashes; they refuse a second run over existing journals rather than double-fund.
If a receipt wait fails, recover that recorded transaction before resuming; never
silently create another promise. Relay integration remains blocked until the live
service supports bond calls under a separately authorized deployment.

See [execution report](../evidence/g3/REPORT.md) for exact outputs, transaction
hashes, balance deltas, limitations, and independently fetched chain receipts.
