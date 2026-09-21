/** Independent read-only verification: fetch fresh chain receipts, inputs, logs and balances. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicClient, http, decodeEventLog, decodeFunctionData, encodeDeployData } from 'viem';
import { compileBond, read, save, sha, canonical, validateFile } from './bond.mjs';
const pub = createPublicClient({ transport: http('https://sepolia.base.org', { timeout: 20000 }), cacheTime: 0 });
assert.equal(await pub.getChainId(), 84532);
const artifact = compileBond();
const actors = read('evidence/g3/actors.json');
const rows = [];
for (const mode of ['release', 'slash']) {
  const dir = `evidence/g3/sepolia-${mode}`;
  const c = read(dir + '/contract.json');
  validateFile(dir + '/contract.json');
  const j = read(dir + '/journal.json');
  const evidenceBytes = readFileSync(dir + '/replay/evidence.json');
  const evidence = JSON.parse(evidenceBytes);
  assert.equal(sha(canonical(c)), j.contract_hash);
  assert.equal(evidence.contract_sha256, j.contract_hash);
  assert.equal(sha(evidenceBytes), j.result.evidence_hash);
  assert.equal(evidence.verdict, mode === 'release' ? 'pass' : 'fail');
  assert.equal(evidence.artifact_sha256, sha(readFileSync(c.patch.artifact)));
  assert.equal(c.patch.sha256, evidence.artifact_sha256);
  for (const row of evidence.replays) {
    assert.equal(sha(canonical(row.observed)), row.output_sha256);
    assert.equal(row.pass, row.output_sha256 === row.expected_output_sha256);
  }
  const fresh = {};
  for (const op of ['commit', 'report', 'settle']) {
    const hash = j[op].transactionHash;
    const tx = await pub.getTransaction({ hash });
    const receipt = await pub.getTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    assert.notEqual(receipt.blockHash, '0x' + '0'.repeat(64));
    const canonicalBlock = await pub.getBlock({ blockNumber: receipt.blockNumber });
    assert.equal(receipt.blockHash, canonicalBlock.hash);
    assert.equal(receipt.blockNumber, BigInt(j[op].blockNumber));
    assert.equal(tx.from.toLowerCase(), (op === 'commit' ? c.promisor : c.oracle.address).toLowerCase());
    const events = receipt.logs.filter(l => l.address.toLowerCase() === j.address.toLowerCase())
      .map(l => decodeEventLog({ abi: artifact.abi, data: l.data, topics: l.topics }));
    if (op === 'commit') {
      assert.equal(tx.value, BigInt(c.bond.amount_wei));
      assert.equal(tx.input, encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode,
        args: [j.contract_hash, c.beneficiary, c.oracle.address, BigInt(c.starts_at), BigInt(c.expires_at), BigInt(c.dispute.seconds)] }));
      assert.equal(events[0].args.contractHash, j.contract_hash);
    } else if (op === 'report') {
      const call = decodeFunctionData({ abi: artifact.abi, data: tx.input });
      assert.equal(call.functionName, 'report');
      assert.equal(call.args[0], mode === 'slash');
      assert.equal(call.args[1], sha(evidenceBytes));
      assert.equal(events[0].args.evidenceHash, sha(evidenceBytes));
    } else {
      assert.equal(events[0].args.contractHash, j.contract_hash);
      assert.equal(events[0].args.evidenceHash, sha(evidenceBytes));
      assert.equal(events[0].args.slashed, mode === 'slash');
      assert.equal(events[0].args.amount, BigInt(c.bond.amount_wei));
    }
    fresh[op] = { transaction: tx, receipt, events, initial_receipt_block_hash: j[op].blockHash };
  }
  const beforeBlock = fresh.settle.receipt.blockNumber - 1n;
  const afterBlock = fresh.settle.receipt.blockNumber;
  const recipient = mode === 'release' ? actors.promisor : actors.beneficiary;
  const before = await pub.getBalance({ address: recipient, blockNumber: beforeBlock });
  const after = await pub.getBalance({ address: recipient, blockNumber: afterBlock });
  assert.equal(after - before, BigInt(c.bond.amount_wei));
  const escrowAfter = await pub.getBalance({ address: j.address, blockNumber: afterBlock });
  assert.equal(escrowAfter, 0n);
  for (const [fn, expected] of Object.entries({ contractHash: j.contract_hash, evidenceHash: sha(evidenceBytes), settled: true, failed: mode === 'slash' })) {
    assert.equal(await pub.readContract({ address: j.address, abi: artifact.abi, functionName: fn, blockNumber: afterBlock }), expected);
  }
  const reportTime = Number((await pub.getBlock({ blockNumber: fresh.report.receipt.blockNumber })).timestamp);
  const settledTime = Number((await pub.getBlock({ blockNumber: afterBlock })).timestamp);
  assert(settledTime >= reportTime + c.dispute.seconds);
  if (mode === 'release') assert(reportTime >= c.expires_at);
  save(dir + '/independent-receipts.json', fresh);
  const row = { mode, address: j.address, contract_hash: j.contract_hash, evidence_hash: sha(evidenceBytes),
    commit_tx: fresh.commit.receipt.transactionHash, report_tx: fresh.report.receipt.transactionHash,
    settlement_tx: fresh.settle.receipt.transactionHash, recipient, before_wei: String(before), after_wei: String(after),
    payout_wei: String(after - before), escrow_after_wei: String(escrowAfter), verified: true };
  rows.push(row);
  console.log(JSON.stringify(row));
}
save('evidence/g3/independent-verification.json', rows);
