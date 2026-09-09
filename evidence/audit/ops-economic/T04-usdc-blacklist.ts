/**
 * Component 6, rows OPS-05 / OPS-06: USDC blacklist (Circle) of the Safe or of a member, reproduced
 * with an audit BlacklistToken whose transfer/transferFrom/approve revert exactly like FiatTokenV2 when
 * msg.sender, the source or the destination is blacklisted. (a) Safe blacklisted: every ragequit for
 * USDC reverts, every deposit reverts, every Payment ends actionFailed: the treasury is frozen for
 * everyone; the only exit is ragequit with tokens = [] which burns shares for 0. (b) Member
 * blacklisted: the member can still exit through Baal.ragequit(to = another address) directly, but the
 * intent-account path (op 4 pays address(this)) cannot. (c) Blacklisted Payment recipient: the whole
 * multicall fails, nothing moves. Expected: (a) frozen (demonstrated), (b) direct-only exit, (c) safe.
 */
import { encodeFunctionData, type Address } from "viem";

import { assert, deposit, fmt, fmtS, fund, processProposal, propose, ragequit, read, runIfMain, sendAt, SETTLEMENT_UNIT, shutdown, simulate, snapshot, step, transferCall, verdict, vote, warpPastGrace, warpPastVoting } from "../../../scenarios/lib.js";
import { GENESIS_DEPOSIT } from "../../../src/zeroOne.js";
import { bootAudit, deployAudit, mustRevert } from "./lib-audit.js";

export async function main(): Promise<void> {
  let tokenAbi: import("viem").Abi = [];
  const mirror = await bootAudit("audit-ops05", {
    settlement: async (founder) => {
      const token = await deployAudit(founder, "BlacklistToken", [100_000_000n * SETTLEMENT_UNIT]);
      tokenAbi = token.artifact.abi;
      console.log(`   BlacklistToken (audit USDC with blacklist) ${token.address}; blacklister = founder ${founder.account.address}`);
      return token.address;
    },
  });
  let passed = false;
  const blacklist = async (who: Address, label: string): Promise<void> => {
    await sendAt(mirror, "F", mirror.dao.settlement, "settlement", "transfer", [who, 0n], "noop").catch(() => undefined);
    const hash = await mirror.actors.F.walletClient.writeContract({ address: mirror.dao.settlement, abi: tokenAbi, functionName: "blacklist", args: [who], account: mirror.actors.F.account, chain: mirror.actors.F.chain });
    await mirror.chain.publicClient.waitForTransactionReceipt({ hash });
    console.log(`   Circle-role: blacklist(${label} ${who}) tx ${hash}`);
  };
  const unblacklist = async (who: Address): Promise<void> => {
    const hash = await mirror.actors.F.walletClient.writeContract({ address: mirror.dao.settlement, abi: tokenAbi, functionName: "unBlacklist", args: [who], account: mirror.actors.F.account, chain: mirror.actors.F.chain });
    await mirror.chain.publicClient.waitForTransactionReceipt({ hash });
  };
  try {
    step("seed: genesis 50, A/B/C 1000 each");
    for (const actor of ["A", "B", "C", "O"] as const) await fund(mirror, actor, 10_000n * SETTLEMENT_UNIT);
    await deposit(mirror, "F", GENESIS_DEPOSIT);
    for (const actor of ["A", "B", "C"] as const) await deposit(mirror, actor, 1_000n * SETTLEMENT_UNIT);
    const seeded = await snapshot(mirror, "seeded", ["F", "A", "B", "C"]);

    step("(c) Payment to a blacklisted recipient O: multicall fails, nothing moves");
    await blacklist(mirror.actors.O.account.address, "recipient O");
    const pay = await propose(mirror, "A", [transferCall(mirror, mirror.actors.O.account.address, 100n * SETTLEMENT_UNIT)], "A: pay O 100");
    await vote(mirror, "A", pay.id, true);
    await warpPastGrace(mirror, pay.id);
    const payResult = await processProposal(mirror, "A", pay);
    assert(payResult.info.status.passed && payResult.info.status.actionFailed, "passed=true actionFailed=true");
    assert((await read<bigint>(mirror, "settlement", "balanceOf", [mirror.dao.safe])) === seeded.safeSettlement, `Safe still holds ${fmtS(seeded.safeSettlement)} USDC`);

    step("(b) member C blacklisted: C's USDC is frozen at Circle's level, but C's shares can still exit to another address via Baal directly");
    await blacklist(mirror.actors.C.account.address, "member C");
    await mustRevert(simulate(mirror, "C", "baal", "ragequit", [mirror.actors.C.account.address, seeded.shares.C, 0n, [mirror.dao.settlement]]), "ragequit(to = C) reverts: blacklisted destination");
    await mustRevert(simulate(mirror, "C", "deposit", "deposit", [1n]), "deposit by blacklisted C reverts");
    const dBefore = await read<bigint>(mirror, "settlement", "balanceOf", [mirror.actors.D.account.address]);
    const exitC = await sendAt(mirror, "C", mirror.dao.baal, "baal", "ragequit", [mirror.actors.D.account.address, seeded.shares.C, 0n, [mirror.dao.settlement]], "C ragequit(to = D)");
    const dAfter = await read<bigint>(mirror, "settlement", "balanceOf", [mirror.actors.D.account.address]);
    assert(dAfter - dBefore === (seeded.shares.C * seeded.safeSettlement) / seeded.totalShares, `C's pro-rata ${fmtS(dAfter - dBefore)} USDC paid to D (tx ${exitC.hash})`);
    console.log("   the relay/intent path cannot do this: ZeroOneIntentAccount op 4 calls baal.ragequit(address(this), ...) (contracts/ZeroOneIntentAccount.sol) so a blacklisted T1/T0 member must call Baal itself");
    await unblacklist(mirror.actors.C.account.address);

    step("(a) the Safe itself is blacklisted: every USDC exit, deposit and payment is frozen");
    const pre = await snapshot(mirror, "before Safe blacklist", ["F", "A", "B"]);
    await blacklist(mirror.dao.safe, "Safe");
    await mustRevert(simulate(mirror, "A", "baal", "ragequit", [mirror.actors.A.account.address, pre.shares.A, 0n, [mirror.dao.settlement]]), "A ragequit for USDC reverts");
    await mustRevert(simulate(mirror, "B", "baal", "ragequit", [mirror.actors.O.account.address, pre.shares.B, 0n, [mirror.dao.settlement]]), "B ragequit to a third address reverts too (source = Safe)");
    await mustRevert(simulate(mirror, "A", "deposit", "deposit", [SETTLEMENT_UNIT]), "deposit reverts (destination = Safe)");
    const pay2 = await propose(mirror, "A", [transferCall(mirror, mirror.actors.A.account.address, 100n * SETTLEMENT_UNIT)], "A: pay A 100 while the Safe is blacklisted");
    await vote(mirror, "A", pay2.id, true);
    await warpPastGrace(mirror, pay2.id);
    const pay2Result = await processProposal(mirror, "A", pay2);
    assert(pay2Result.info.status.passed && pay2Result.info.status.actionFailed, "Payment passes the vote but actionFailed: nothing moves");
    const approveCall = { to: mirror.dao.settlement, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [mirror.actors.A.account.address, pre.safeSettlement] }) };
    const pay3 = await propose(mirror, "A", [approveCall], "A: Safe approves A (escape attempt)");
    await vote(mirror, "A", pay3.id, true);
    await warpPastGrace(mirror, pay3.id);
    const pay3Result = await processProposal(mirror, "A", pay3);
    assert(pay3Result.info.status.actionFailed, "approve from a blacklisted Safe also fails: no escape by vote");
    // The only exit: burn shares for nothing.
    const burnOnly = await sendAt(mirror, "B", mirror.dao.baal, "baal", "ragequit", [mirror.actors.B.account.address, pre.shares.B, 0n, []], "B ragequit(tokens = []) burns shares, receives 0");
    const post = await snapshot(mirror, "after Safe blacklist", ["A", "B"]);
    assert(post.shares.B === 0n && post.settlement.B === pre.settlement.B, `B burned ${fmt(pre.shares.B)} shares and received 0 USDC (tx ${burnOnly.hash})`);
    console.log(`   frozen value: ${fmtS(post.safeSettlement)} USDC for ${fmt(post.totalShares)} shares; remedy: none on chain (no vote can move USDC out of a blacklisted Safe); only Circle's unBlacklist`);
    await warpPastVoting(mirror, pay3.id).catch(() => undefined);
    await ragequit(mirror, "A").catch(() => console.log("   A still cannot exit while blacklisted"));
    passed = true;
  } finally {
    verdict("OPS-05/06 usdc-blacklist", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
