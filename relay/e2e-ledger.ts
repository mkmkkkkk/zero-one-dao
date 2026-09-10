import { settleRetention } from '../src/retention.js';
/** Phase 4 HTTP regression against the owned relay/devnet after the ordinary cold start. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { type Abi, type Address, type Hex } from "viem";
import { loadBaalArtifact, loadLocalArtifact, type WriteContext } from "../src/baal.js";
import { deployLocal, increaseTime, writeAndWait } from "../src/onchain.js";
import { stopCalls, submitCalls, submitTemplateProposal, unwindCalls } from "../src/proposals.js";
import { HOUR, SETTLEMENT_UNIT as U, type ZeroOneDao } from "../src/zeroOne.js";

export async function ledgerHttp(origin: string, owner: WriteContext, dao: ZeroOneDao): Promise<void> {
  const client = owner.publicClient;
  const token = loadLocalArtifact("TestToken").abi;
  const baal = loadBaalArtifact("Baal").abi;
  const strategy = loadLocalArtifact("StrategyProposal").abi;
  const ledger = loadLocalArtifact("TreasuryLedger").abi;
  const send = async (address: Address, abi: Abi, functionName: string, args: readonly unknown[], gas?: bigint) => {
    const simulation = await client.simulateContract({ address, abi, functionName, args, account: owner.account } as never);
    const result = await writeAndWait(owner, { ...simulation.request as unknown as Record<string, unknown>, ...(gas ? { gas } : {}) });
    console.log(`   ledger HTTP tx ${functionName}: ${result.hash} block=${result.receipt.blockNumber}`);
    return result;
  };
  const balance = async (address: Address, asset = dao.settlement) => await client.readContract({ address: asset, abi: token, functionName: "balanceOf", args: [address] }) as bigint;
  const pass = async (proposal: { id: number; data: Hex }) => {
    await increaseTime(owner, 2);
    await send(dao.baal, baal, "submitVote", [proposal.id, true]);
    await increaseTime(owner, 12 * HOUR + 5);
    await settleRetention(owner, dao.shares, proposal.id);
    await send(dao.baal, baal, "processProposal", [proposal.id, proposal.data], 5_000_000n);
  };
  const state = async () => {
    // The service caches for three seconds; compare both endpoints with a pinned chain read.
    await new Promise((resolve) => setTimeout(resolve, 3_100));
    const s = await (await fetch(`${origin}/state.json`)).json() as { block: { number: number }; treasury: { settled: boolean; depositTreasury: string; usdc: string } };
    const m = await (await fetch(`${origin}/me/${owner.account.address}.json`)).json() as { settled: boolean; depositTreasury: string };
    assert.equal(m.settled, s.treasury.settled);
    assert.equal(m.depositTreasury, s.treasury.depositTreasury);
    const blockNumber = (await client.getBlock()).number;
    assert.equal(s.treasury.depositTreasury, (await client.readContract({ address: dao.treasuryLedger, abi: ledger, functionName: "depositTreasury", blockNumber }) as bigint).toString());
    assert.equal(s.treasury.settled, await client.readContract({ address: dao.treasuryLedger, abi: ledger, functionName: "settled", blockNumber }));
    console.log(`   ASSERT ledger HTTP settled=${s.treasury.settled} safe=${s.treasury.usdc} depositTreasury=${s.treasury.depositTreasury} block=${blockNumber}`);
    return s.treasury;
  };

  const asset = await deployLocal(owner, "TestToken", ["Relay Mock Asset", "RMOCK", 1_000n * U]);
  const dex = await deployLocal(owner, "MockDex", [dao.settlement, asset.address, 2n * U]);
  await send(asset.address, token, "transfer", [dex.address, 100n * U]);
  const before = await balance(dao.safe);
  const proposal = await submitTemplateProposal(owner, dao, { template: "Strategy", params: {
    venue: dex.address, asset: asset.address, budget: 10n * U,
    rule: { maxPerRun: 2n * U, minInterval: 0n, deadline: (await client.getBlock()).timestamp + BigInt(7 * 24 * HOUR), takeProfitBps: 0n, stopLossBps: 0n },
  } }, "phase 4 relay ledger regression");
  await pass(proposal);
  assert.equal(await balance(proposal.instance.address), 10n * U, "voted strategy actually funded");
  const opened = await state();
  assert.equal(opened.settled, true);
  assert.equal(BigInt(opened.depositTreasury), before);
  assert.equal(BigInt(opened.usdc), before - 10n * U);
  await send(proposal.instance.address, strategy, "run", []);
  assert.equal((await state()).settled, false);

  const passphrase = randomBytes(32).toString("base64url");
  const join = await (await fetch(`${origin}/relay?op=join&pass=${passphrase}`)).json() as { ok: boolean };
  assert.equal(join.ok, true);
  const refuse = async () => {
    const safeBefore = await balance(dao.safe);
    const response = await fetch(`${origin}/relay?op=deposit&amount=${U}&pass=${passphrase}`);
    const body = await response.json() as { ok: boolean; reason: string; error: { name: string } };
    console.log(`   ASSERT ledger HTTP deposit ${response.status}: ${JSON.stringify(body)}`);
    assert.equal(response.status, 422);
    assert.equal(body.ok, false);
    assert.equal(body.error.name, "TreasuryNotSettled");
    assert.match(body.reason, /settles the registered assets to USDC/);
    assert.equal(await balance(dao.safe), safeBefore, "refused deposit did not move treasury funds");
  };
  await refuse();
  const stop = await submitCalls(owner, dao, stopCalls(proposal.instance.address), "phase 5 relay stop");
  await pass(stop);
  // Phase 5 ruling 4b: stop() keeps the asset inside the stopped instance (still open); the Safe holds none of it.
  assert.equal(await balance(proposal.instance.address, asset.address), U);
  assert.equal(await balance(dao.safe, asset.address), 0n);
  assert.equal((await state()).settled, false);
  await refuse();
  const settlement = await submitCalls(owner, dao, unwindCalls(proposal.instance.address), "phase 5 relay unwind vote");
  await pass(settlement);
  assert.equal(await balance(proposal.instance.address, asset.address), 0n);
  assert.equal(await balance(dao.safe, asset.address), 0n);
  assert.equal((await state()).settled, true);
  const response = await fetch(`${origin}/relay?op=deposit&amount=${U}&pass=${passphrase}`);
  const body = await response.json() as { ok: boolean; hash?: string };
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(await balance(dao.safe), before + U);
  console.log(`   ASSERT ledger HTTP same deposit succeeds after settlement: ${body.hash}`);
  console.log("=== RELAY LEDGER HTTP: PASS ===");
}
