/** A mined constructor refusal before the companion WETH pool has a full real TWAP window. */
import { readFileSync, writeFileSync } from 'node:fs';
import { BaseError, decodeErrorResult, encodeDeployData, type Hex } from 'viem';
import { liveChain, liveContexts, keyFromEnvFile } from '../src/live.js';
import { loadLocalArtifact } from '../src/baal.js';
import { awaitRead } from '../src/onchain.js';
const p=JSON.parse(readFileSync('evidence/testnet/phase5/K/weth18.json','utf8'));
if(p.chainId!==84532||!process.env.ZERO_ONE_DEPLOYER_KEY_FILE)throw Error('explicit Sepolia test key required');
const chain=liveChain(84532),{publicClient:pc,contexts:[c]}=liveContexts(chain,[keyFromEnvFile(process.env.ZERO_ONE_DEPLOYER_KEY_FILE)]);
if(await pc.getChainId()!==84532||(await pc.getBlock()).timestamp>=BigInt(p.readyAt)-1n)throw Error('outside the expected short-window fixture');
const a=loadLocalArtifact('UniswapV3Venue'),args=[p.safe,p.settlement,p.weth,'0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4','0xC5290058841028F1614F3A6F0F5816cAd0df5E27','0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',500];
const data=encodeDeployData({abi:a.abi,bytecode:a.bytecode,args});
const hash=process.env.ZERO_ONE_RECEIPT as Hex|undefined ?? await c!.walletClient.sendTransaction({account:c!.account,chain,data,gas:3_000_000n});
const receipt=await pc.waitForTransactionReceipt({hash});
let reason='unknown';
try{await awaitRead(()=>pc.call({account:c!.account,data,blockNumber:receipt.blockNumber}),()=>true);}catch(e){
 if(e instanceof BaseError){
  const detail=e.walk(x=>typeof (x as {data?:unknown}).data==='string') as {data?:Hex}|null;
  if(detail?.data&&detail.data!=='0x')reason=decodeErrorResult({abi:a.abi,data:detail.data}).errorName;
 }
}
const result={chainId:84532,hash,blockNumber:String(receipt.blockNumber),status:receipt.status,reason,pool:p.pool};
writeFileSync('evidence/testnet/phase5/K/window-refusal.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
if(receipt.status!=='reverted'||reason!=='WindowUnavailable')throw Error('mined short-window refusal not proven');
console.log('NATIVE TWAP WINDOW REFUSAL PASS');
