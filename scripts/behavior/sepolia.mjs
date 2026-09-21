/** Two funded behavioral commitments on Base Sepolia. Existing relay is read-only. */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { clients, compileBond, deploy, write, checkBinding, read, save, canonical, sha, replay, validateFile } from './bond.mjs';
const rpc = 'https://sepolia.base.org';
const role = async name => clients(rpc, 84532, readFileSync(`state/g3/keys/${name}.key`, 'utf8').trim());
const owner = await role('promisor');
const oracle = await role('oracle');
const actors = read('evidence/g3/actors.json');
const artifact = compileBond();
save('evidence/g3/bond-artifact.json', artifact);
const health = await (await fetch('http://127.0.0.1:18761/health.json', { signal: AbortSignal.timeout(20000) })).json();
assert.equal(health.chainId, 84532);
save('evidence/g3/relay-before.json', health);
assert(!health.verbs.includes('commit'), 're-evaluate: relay has changed');
const balances = async (address, blockNumber) => {
  const at = blockNumber ? { blockNumber } : { blockTag: 'latest' };
  const result = {};
  for (const [label, who] of Object.entries({ promisor: actors.promisor, oracle: actors.oracle, beneficiary: actors.beneficiary, ...(address ? { escrow: address } : {}) })) {
    result[label] = String(await owner.pub.getBalance({ address: who, ...at }));
  }
  return result;
};
const waitTime = async target => {
  const deadline = Date.now() + 180000;
  while (Number((await owner.pub.getBlock()).timestamp) < target) {
    if (Date.now() > deadline) throw Error('chain time wait timed out; keep escrow receipt for recovery');
    await new Promise(r => setTimeout(r, 2000));
  }
};
for (const name of ['release', 'slash']) {
  const dir = `evidence/g3/sepolia-${name}`;
  if (existsSync(dir + '/journal.json')) throw Error('existing commitment journal: inspect and resume explicitly, do not double-fund');
  mkdirSync(dir, { recursive: true });
  const c = read('evidence/g3/example.contract.json');
  const now = Number((await owner.pub.getBlock()).timestamp);
  Object.assign(c, { contract_id: `g3-${name}-${now}`, starts_at: now, expires_at: now + 45 });
  const file = dir + '/contract.json';
  save(file, c);
  validateFile(file);
  const contractHash = sha(canonical(c));
  const journal = { chain_id: 84532, contract_hash: contractHash, before: await balances(), mode: name, relay: 'unsupported-direct-testnet-client' };
  save(dir + '/journal.json', journal);
  const deployed = await deploy(owner, artifact, c, contractHash, tx => { journal.commit_broadcast = tx; save(dir + '/journal.json', journal); });
  const address = deployed.contractAddress;
  Object.assign(journal, { address, commit: deployed, locked: await balances(address, deployed.blockNumber) });
  save(dir + '/journal.json', journal);
  await checkBinding(owner, artifact, address, c, contractHash);
  assert.equal(journal.locked.escrow, c.bond.amount_wei);
  console.log(JSON.stringify({ stage: 'committed', mode: name, address, hash: deployed.transactionHash, bond_wei: c.bond.amount_wei }));
  if (name === 'release') await waitTime(c.expires_at);
  const result = replay(file, dir + '/replay', name === 'slash');
  assert.equal(result.verdict, name === 'release' ? 'pass' : 'fail');
  // The transaction boolean derives exclusively from the replay result, never a CLI verdict.
  journal.result = result;
  save(dir + '/journal.json', journal);
  journal.report = await write(oracle, artifact, address, 'report', [result.verdict === 'fail', result.evidence_hash], tx => { journal.report_broadcast = tx; save(dir + '/journal.json', journal); });
  save(dir + '/journal.json', journal);
  const at = Number((await owner.pub.getBlock({ blockNumber: journal.report.blockNumber })).timestamp);
  await waitTime(at + c.dispute.seconds);
  journal.before_settlement = await balances(address);
  // Oracle pays settlement gas, so release/slash recipient's exact balance increase is visible.
  journal.settle = await write(oracle, artifact, address, 'settle', [], tx => { journal.settle_broadcast = tx; save(dir + '/journal.json', journal); });
  journal.after = await balances(address, journal.settle.blockNumber);
  save(dir + '/journal.json', journal);
  const receiver = name === 'release' ? 'promisor' : 'beneficiary';
  assert.equal(BigInt(journal.after[receiver]) - BigInt(journal.before_settlement[receiver]), BigInt(c.bond.amount_wei));
  assert.equal(journal.after.escrow, '0');
  const onchainEvidence = await owner.pub.readContract({ address, abi: artifact.abi, functionName: 'evidenceHash', blockNumber: journal.settle.blockNumber });
  assert.equal(onchainEvidence, result.evidence_hash);
  assert.equal(await owner.pub.readContract({ address, abi: artifact.abi, functionName: 'settled', blockNumber: journal.settle.blockNumber }), true);
  assert.equal(await owner.pub.readContract({ address, abi: artifact.abi, functionName: 'failed', blockNumber: journal.settle.blockNumber }), name === 'slash');
  journal.verified = true;
  save(dir + '/journal.json', journal);
  console.log(JSON.stringify({ stage: 'settled', mode: name, ...result, commit_tx: deployed.transactionHash,
    report_tx: journal.report.transactionHash, settlement_tx: journal.settle.transactionHash, before: journal.before_settlement, after: journal.after }));
}
const after = await (await fetch('http://127.0.0.1:18761/health.json', { signal: AbortSignal.timeout(20000) })).json();
save('evidence/g3/relay-after.json', after);
assert.equal(after.startedAt, health.startedAt);
console.log('relay startedAt unchanged; existing relay bond receipt = unsupported');
