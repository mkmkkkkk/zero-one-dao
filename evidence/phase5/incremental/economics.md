# Measured journal writer versus settler economics

Source: `green-storm.log`, run committed in `d776548`.
SHA-256: `81da73ccaba06aba5b9c153060f025c7d21427ef394804ddc36eaba82bffa642`.
Independent log readback counted 100 deposit batch receipts (50 records each)
and 40 settlement receipts, and summed their actual `gasUsed` fields.

| Work | Records | Total gas | Gas per record | USDC contributed per record |
| --- | ---: | ---: | ---: | ---: |
| Writer: real DepositShaman deposits, 50 per transaction | 5,000 | 487,702,824 | 97540.5648 | 0.000001 |
| Settler: chunks of at most 128 records | 5,000 | 41,263,129 | 8252.6258 | 0 |

The writer spends 11.819337 times the settler's gas for this workload.
Total contributed USDC is 0.005. This is recoverable principal through ordinary
exit, not a protocol fee or an irreversible loss. One repeated address writes all
5,000 deposit records; this result assumes neither fresh addresses nor a minimum
deposit. Gas includes batch-call overhead, but excludes helper deployment,
funding transfer and approval. Their transaction hashes are in the source log
where emitted; they are not included in the per-record sums above.

Identical single deposits cost 245,235 gas and identical partial exits cost
249,624 gas at quiet, 2,500 and 5,000 records. Those are whole operation costs,
including a journal append, not marginal journal storage costs. Batching shares
transaction overhead and warm storage, so the writer's measured batch average
is lower than a standalone deposit. An exit also appends a record; its USDC
contribution is zero and it returns assets according to NAV. The storm replay
average above specifically measures the deposit-record workload, not a universal
cost for every account checkpoint history or every mint/burn mixture.

For a gas price P in wei per gas, execution cost is gasUsed * P / 10^18 ETH.
Public-chain gas price, Base L1 data fees, fiat ETH price and total public-chain
currency cost: **unknown**. Local receipt gas does not measure those amounts.
Timestamp checkpoint boundaries can change batch gas between runs; the clean
clone will report its own independently measured totals.

Actual source output:

```text
GAS MID_STORM records=2500 deposit=245235 exit=249624
GAS CONSTANT quiet_deposit=245235 storm_deposit=245235 quiet_exit=249624 storm_exit=249624
STORM records=5000 settle_calls=40 settle_total_gas=41263129 settle_gas_per_record=8252.6258 process_gas=147349 processed=true passed=true actionFailed=false
ECONOMICS attacker_deposit_gas=487702824 attacker_gas_per_record=97540.5648 attacker_USDC=0.005 attacker_USDC_per_record=0.000001 settler_gas_per_record=8252.6258 gas_ratio=11.819336919408123 approval_and_helper_deployment_excluded=true USDC_recoverable_by_exit=true
```
