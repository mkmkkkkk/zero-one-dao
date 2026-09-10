/** Permissionless client for the explicit retention-settlement step. Caller chooses chunk size. */
import type { Address } from 'viem';
import { loadLocalArtifact, type WriteContext } from './baal.js';

export async function settleRetention(context: WriteContext, shares: Address, proposalId: number, chunk = 128n): Promise<{ calls: number; gasUsed: bigint }> {
  if (chunk <= 0n) throw new RangeError('chunk must be positive');
  const abi = loadLocalArtifact('NavShareToken').abi;
  let calls = 0, gasUsed = 0n;
  for (;;) {
    const blockNumber = await context.publicClient.getBlockNumber({ cacheTime: 0 });
    const [progress, end] = await Promise.all([
      context.publicClient.readContract({ address: shares, abi, functionName: 'settlements', args: [BigInt(proposalId)], blockNumber }),
      context.publicClient.readContract({ address: shares, abi, functionName: 'journalLength', blockNumber }),
    ]) as [readonly [bigint, bigint], bigint];
    if (progress[0] === end) return { calls, gasUsed };
    const hash = await context.walletClient.writeContract({ address: shares, abi, functionName: 'settleRetention', args: [BigInt(proposalId), chunk], gas: 8_000_000n, account: context.account, chain: context.chain });
    const receipt = await context.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`retention chunk reverted: ${hash}; retry with a smaller chunk`);
    calls++; gasUsed += receipt.gasUsed;
    console.log(`RETENTION proposal=${proposalId} chunk=${calls} gas=${receipt.gasUsed} tx=${hash}`);
  }
}
