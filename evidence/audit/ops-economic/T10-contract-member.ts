/**
 * Component 7, row ECO-07: contracts as members. DepositShaman is open to any address, so a contract
 * can hold shares, vote, propose and ragequit; its owner can be sold, which makes the non-transferable
 * share weight transferable in one transaction; it can also deposit and ragequit inside one transaction.
 * Expected: demonstrated (allowed by design; the numbers show what "non-transferable" does not cover).
 */
import { assert, deposit, fmt, fmtS, fund, processProposal, proposalInfo, propose, read, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, step, transferCall, verdict, vote, warp, warpPastGrace } from "../../../scenarios/lib.js";
import { bootAudit, deployAudit } from "./lib-audit.js";

export async function main(): Promise<void> {
  const mirror = await bootAudit("audit-eco07");
  let passed = false;
  try {
    await seedMembers(mirror);
    const client = mirror.chain.publicClient;
    const owner1 = mirror.actors.W;
    const owner2 = mirror.actors.O;
    step("W deploys MemberContract and deposits 1000 USDC through it");
    const member = await deployAudit(owner1, "MemberContract");
    await fund(mirror, "W", 2_000n * SETTLEMENT_UNIT);
    await owner1.walletClient.writeContract({ address: mirror.dao.settlement, abi: mirror.abi.settlement, functionName: "transfer", args: [member.address, 1_000n * SETTLEMENT_UNIT], account: owner1.account, chain: owner1.chain });
    const dep = await owner1.walletClient.writeContract({ address: member.address, abi: member.artifact.abi, functionName: "deposit", args: [mirror.dao.depositShaman, mirror.dao.settlement, 1_000n * SETTLEMENT_UNIT], account: owner1.account, chain: owner1.chain });
    await client.waitForTransactionReceipt({ hash: dep });
    const held = await read<bigint>(mirror, "shares", "balanceOf", [member.address]);
    assert(held === 1_000n * 10n ** 18n, `contract ${member.address} holds ${fmt(held)} shares (24.6% of supply)`);

    step("the contract votes; then W sells it (setOwner) and O votes with the same shares on the next proposal");
    const p1 = await propose(mirror, "A", [transferCall(mirror, mirror.actors.O.account.address, SETTLEMENT_UNIT)], "A: pay O 1");
    const v1 = await owner1.walletClient.writeContract({ address: member.address, abi: member.artifact.abi, functionName: "vote", args: [mirror.dao.baal, p1.id, false], account: owner1.account, chain: owner1.chain });
    await client.waitForTransactionReceipt({ hash: v1 });
    assert((await proposalInfo(mirror, p1.id)).noVotes === held, `contract voted NO with ${fmt(held)} shares`);
    const sale = await owner1.walletClient.writeContract({ address: member.address, abi: member.artifact.abi, functionName: "setOwner", args: [owner2.account.address], account: owner1.account, chain: owner1.chain });
    const saleReceipt = await client.waitForTransactionReceipt({ hash: sale });
    console.log(`   setOwner(O): tx ${sale}, gas ${saleReceipt.gasUsed}: control of ${fmt(held)} shares changed hands with 0 share transfers (NavShareToken.transfer would revert NonTransferable)`);
    const p2 = await propose(mirror, "A", [transferCall(mirror, mirror.actors.O.account.address, SETTLEMENT_UNIT)], "A: pay O 1 (again)");
    const v2 = await owner2.walletClient.writeContract({ address: member.address, abi: member.artifact.abi, functionName: "vote", args: [mirror.dao.baal, p2.id, true], account: owner2.account, chain: owner2.chain });
    await client.waitForTransactionReceipt({ hash: v2 });
    assert((await proposalInfo(mirror, p2.id)).yesVotes === held, `new owner O voted YES with the same ${fmt(held)} shares`);

    step("the contract exits to any address chosen by its owner");
    const oBefore = await read<bigint>(mirror, "settlement", "balanceOf", [owner2.account.address]);
    const rq = await owner2.walletClient.writeContract({ address: member.address, abi: member.artifact.abi, functionName: "ragequit", args: [mirror.dao.baal, owner2.account.address, held, [mirror.dao.settlement]], account: owner2.account, chain: owner2.chain });
    await client.waitForTransactionReceipt({ hash: rq });
    const oAfter = await read<bigint>(mirror, "settlement", "balanceOf", [owner2.account.address]);
    assert(oAfter - oBefore === 1_000n * SETTLEMENT_UNIT, `O received ${fmtS(oAfter - oBefore)} USDC for shares W paid for`);

    step("same-transaction deposit + ragequit (round trip inside one block)");
    await owner1.walletClient.writeContract({ address: mirror.dao.settlement, abi: mirror.abi.settlement, functionName: "transfer", args: [member.address, 500n * SETTLEMENT_UNIT], account: owner1.account, chain: owner1.chain });
    const before = await read<bigint>(mirror, "settlement", "balanceOf", [member.address]);
    const rt = await owner2.walletClient.writeContract({ address: member.address, abi: member.artifact.abi, functionName: "roundTrip", args: [mirror.dao.depositShaman, mirror.dao.settlement, mirror.dao.baal, 500n * SETTLEMENT_UNIT, [mirror.dao.settlement]], account: owner2.account, chain: owner2.chain });
    const rtReceipt = await client.waitForTransactionReceipt({ hash: rt });
    const after = await read<bigint>(mirror, "settlement", "balanceOf", [member.address]);
    console.log(`   roundTrip 500 USDC in one tx (${rtReceipt.gasUsed} gas): contract USDC ${fmtS(before)} -> ${fmtS(after)} (delta ${fmtS(after - before)}); shares now ${fmt(await read<bigint>(mirror, "shares", "balanceOf", [member.address]))}`);
    assert(after <= before, "no profit from a same-block round trip while the Safe holds only USDC (phase 4 keeps this: exit price <= deposit price)");
    await warp(mirror, 1);
    await warpPastGrace(mirror, p2.id);
    await processProposal(mirror, "A", p2);
    passed = true;
  } finally {
    verdict("ECO-07 contract-member", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
