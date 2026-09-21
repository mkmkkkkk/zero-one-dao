/** Real local-EVM checks: authorization, timing, hash binding, release and slash. */
import assert from 'node:assert/strict';
import { startDevnet, stopDevnet } from '../../src/devnet.ts';
import { clients, compileBond, deploy, write, checkBinding, read, sha, canonical, save } from './bond.mjs';

const devnet = await startDevnet(`g3-bond-${Date.now()}`, { chainId: 31337 });
try {
  const owner = await clients(devnet.rpcUrl, 31337, devnet.privateKeys[0]);
  const oracle = await clients(devnet.rpcUrl, 31337, devnet.privateKeys[1]);
  const outsider = await clients(devnet.rpcUrl, 31337, devnet.privateKeys[2]);
  const artifact = compileBond();
  const rows = [];
  const step = async name => { rows.push(name); console.log('PASS ' + name); };
  const warp = async seconds => {
    await owner.pub.request({ method: 'evm_increaseTime', params: [seconds] });
    await owner.pub.request({ method: 'evm_mine', params: [] });
  };
  const balance = address => owner.pub.getBalance({ address, blockTag: 'latest' });
  async function setup(id) {
    const c = read('evidence/g3/example.contract.json');
    const now = Number((await owner.pub.getBlock()).timestamp);
    Object.assign(c, { contract_id: id, promisor: owner.account.address, beneficiary: outsider.account.address, starts_at: now, expires_at: now + 30 });
    c.oracle.address = oracle.account.address;
    const hash = sha(canonical(c));
    const deployed = await deploy(owner, artifact, c, hash);
    const address = deployed.contractAddress;
    await checkBinding(owner, artifact, address, c, hash);
    return { c, address, hash };
  }
  const pass = await setup('local-pass');
  const evidence = sha('local-evidence');
  await assert.rejects(() => write(outsider, artifact, pass.address, 'report', [true, evidence]));
  await step('unauthorized oracle rejected');
  await assert.rejects(() => write(oracle, artifact, pass.address, 'report', [false, evidence]));
  await step('pass before expiry rejected');
  await assert.rejects(() => write(owner, artifact, pass.address, 'settle'));
  await step('no-result settlement rejected');
  await warp(31);
  await write(oracle, artifact, pass.address, 'report', [false, evidence]);
  await assert.rejects(() => write(owner, artifact, pass.address, 'settle'));
  await step('early dispute settlement rejected');
  await warp(7);
  const before = await balance(owner.account.address);
  // A third-party caller pays gas, making the recipient's exact refund observable.
  await write(outsider, artifact, pass.address, 'settle');
  assert.equal((await balance(owner.account.address)) - before, BigInt(pass.c.bond.amount_wei));
  assert.equal(await balance(pass.address), 0n);
  await step('pass release exact bond, escrow empty');
  await assert.rejects(() => write(owner, artifact, pass.address, 'settle'));
  await step('duplicate settlement rejected');
  const fail = await setup('local-fail');
  await warp(31);
  await write(oracle, artifact, fail.address, 'report', [false, evidence]);
  await write(oracle, artifact, fail.address, 'report', [true, sha('failure')]);
  await assert.rejects(() => write(oracle, artifact, fail.address, 'report', [false, evidence]));
  await step('failure overrides pass and cannot be erased');
  await assert.rejects(() => checkBinding(owner, artifact, fail.address, fail.c, sha('wrong-contract')));
  await step('wrong contract hash rejected by client');
  await warp(7);
  const recipientBefore = await balance(outsider.account.address);
  await write(owner, artifact, fail.address, 'settle');
  assert.equal((await balance(outsider.account.address)) - recipientBefore, BigInt(fail.c.bond.amount_wei));
  assert.equal(await balance(fail.address), 0n);
  await step('slash transfers exact bond to beneficiary, escrow empty');
  save('evidence/g3/bond-tests.json', { passed: rows.length, checks: rows, compiler: artifact.compiler, source_sha256: artifact.sourceSha256 });
} finally {
  await stopDevnet(devnet);
  console.log('owned anvil stopped');
}
