/** ragequit(0) must be a no-op even before genesis, when total supply is zero. */
import { boot, shutdown, read } from '../../../scenarios/lib.js';
if (process.env.ZERO_ONE_LIVE_DEPLOYMENT || process.env.FORK_RPC) throw new Error('LOCAL ONLY');
async function main() {
 const m=await boot('retention-zero-empty');
 try {
  const c=m.actors.A;
  if(await read<bigint>(m,'shares','totalSupply')!==0n) throw new Error('fixture must be empty');
  const hash=await c.walletClient.writeContract({address:m.dao.baal,abi:m.abi.baal,functionName:'ragequit',args:[c.account.address,0n,0n,[m.dao.settlement]],gas:300_000n,account:c.account,chain:c.chain} as never);
  const r=await c.publicClient.waitForTransactionReceipt({hash});
  console.log(`ASSERT empty-DAO ragequit(0): status=${r.status} gas=${r.gasUsed} hash=${hash}`);
  if(r.status!=='success') throw new Error('zero exit must not divide by zero');
  if(await read<bigint>(m,'shares','totalSupply')!==0n || await read<bigint>(m,'shares','numCheckpoints',[c.account.address])!==0n) throw new Error('zero exit changed state');
  console.log('GREEN empty-DAO zero exit no-op');
 } finally {await shutdown(m);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
