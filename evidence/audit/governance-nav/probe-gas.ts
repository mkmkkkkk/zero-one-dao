/**
 * Probe for GOV-05: which gas limit lets processProposal clear a proposal submitted with
 * baalGas = 20,000,000 on anvil (30 M block gas limit). Not a finding by itself; feeds t08.
 */
import { encodeProposalData } from "../../../src/baal.js";
import { boot, runIfMain, seedMembers, SETTLEMENT_UNIT, shutdown, transferCall, vote, warp, warpPastGrace } from "../../../scenarios/lib.js";
import { writeWithGas } from "./audit-lib.js";

/**
 * Submit a 20 M-baalGas proposal and try increasing gas limits.
 *
 * Raises:
 *   Error: on unexpected RPC failures.
 */
export async function main(): Promise<void> {
  const mirror = await boot("probe-gas");
  try {
    await seedMembers(mirror);
    const data1 = encodeProposalData([transferCall(mirror, mirror.actors.O.account.address, SETTLEMENT_UNIT)]);
    const A = mirror.actors.A;
    const hash = await A.walletClient.writeContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "submitProposal", args: [data1, 0, 20_000_000n, "x"], account: A.account, chain: A.chain } as never);
    await A.publicClient.waitForTransactionReceipt({ hash });
    await warp(mirror, 1);
    await vote(mirror, "A", 1, true);
    await warpPastGrace(mirror, 1);
    const block = await mirror.chain.publicClient.getBlock();
    console.log("PROBE block gas limit", block.gasLimit);
    for (const g of [20_100_000n, 20_400_000n, 21_000_000n, 25_000_000n, 29_000_000n]) {
      try {
        const r = await writeWithGas(mirror.actors.W, mirror.dao.baal, mirror.abi.baal, "processProposal", [1, data1], g);
        console.log("PROBE gas", g, r.status, r.gasUsed);
        if (r.status === "success") break;
      } catch (e) {
        console.log("PROBE gas", g, "error", (e as Error).message.split("\n")[0]);
      }
    }
  } finally {
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
