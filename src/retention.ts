/** Permissionless client for the explicit retention-settlement step. Caller chooses chunk size. */
import type { Address } from 'viem';
import { loadLocalArtifact, type WriteContext } from './baal.js';
import { awaitRead } from './onchain.js';

export async function settleRetention(context: WriteContext, shares: Address, proposalId: number, chunk = 128n): Promise<{ calls: number; gasUsed: bigint; blockNumber: bigint }> {
  if (chunk <= 0n) throw new RangeError('chunk must be positive');
  const abi = loadLocalArtifact('NavShareToken').abi;
  let calls = 0, gasUsed = 0n, observedBlock = 0n;
  for (;;) {
    const latest = await context.publicClient.getBlockNumber({ cacheTime: 0 });
    const blockNumber = latest > observedBlock ? latest : observedBlock;
    observedBlock = blockNumber;
    const [progress, end] = await awaitRead(() => Promise.all([
      context.publicClient.readContract({ address: shares, abi, functionName: 'settlements', args: [BigInt(proposalId)], blockNumber }),
      context.publicClient.readContract({ address: shares, abi, functionName: 'journalLength', blockNumber }),
    ]) as Promise<[readonly [bigint, bigint], bigint]>, () => true);
    if (progress[0] === end) return { calls, gasUsed, blockNumber };
    const hash = await context.walletClient.writeContract({ address: shares, abi, functionName: 'settleRetention', args: [BigInt(proposalId), chunk], gas: 8_000_000n, account: context.account, chain: context.chain });
    const receipt = await context.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`retention chunk reverted: ${hash}; retry with a smaller chunk`);
    calls++; gasUsed += receipt.gasUsed; observedBlock = receipt.blockNumber;
    console.log(`RETENTION proposal=${proposalId} chunk=${calls} gas=${receipt.gasUsed} tx=${hash}`);
  }
}
