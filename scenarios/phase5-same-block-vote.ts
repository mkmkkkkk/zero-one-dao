/** Native same-transaction snapshot refusal; isolated test probe, no canonical contract changes. */
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import solc from 'solc';
import {decodeEventLog,toFunctionSelector,type Abi,type Hex} from 'viem';
import {liveChain,liveContexts,keyFromEnvFile} from '../src/live.js';
import {loadLocalAbi,encodeProposalData} from '../src/baal.js';
import {writeAndWait} from '../src/onchain.js';
const source=`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface T {function approve(address,uint256)external returns(bool);}
interface D {function deposit(uint256)external returns(uint256);}
interface B {function submitProposal(bytes calldata,uint32,uint256,string calldata)external payable returns(uint32);function proposalCount()external view returns(uint32);function submitVote(uint32,bool)external;}
contract SameBlockProbe {
event Refused(uint32 proposal,bytes reason);
function check(address token,address shaman,B baal,bytes calldata data)external returns(uint32 id){T(token).approve(shaman,50e6);D(shaman).deposit(50e6);baal.submitProposal(data,0,100000,"phase5 same-block vote probe");id=baal.proposalCount();(bool ok,bytes memory reason)=address(baal).call(abi.encodeCall(B.submitVote,(id,true)));require(!ok,"same-block vote accepted");require(bytes4(reason)==bytes4(keccak256("TimePointNotDetermined(uint256,uint256)")),"wrong refusal");emit Refused(id,reason);}
function vote(B baal,uint32 id)external{baal.submitVote(id,true);}
}`;
const root='evidence/testnet/phase5',record=readdirSync(`${root}/scenario-daos`).filter(x=>x.startsWith('corner-money-')).sort().at(-1)!;
const d=JSON.parse(readFileSync(`${root}/scenario-daos/${record}`,'utf8'));
if(d.chainId!==84532)throw Error('Sepolia fixture required');
const{publicClient:p,contexts:[c]}=liveContexts(liveChain(84532),[keyFromEnvFile('state/testnet-phase5-k/founder.env')]);
if(await p.getChainId()!==84532)throw Error('RPC chain mismatch');
const input={language:'Solidity',sources:{'SameBlockProbe.sol':{content:source}},settings:{optimizer:{enabled:true,runs:200},evmVersion:'cancun',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
const compiled=JSON.parse(solc.compile(JSON.stringify(input)));if(compiled.errors?.some((x:{severity:string})=>x.severity==='error'))throw Error(JSON.stringify(compiled.errors));
const artifact=compiled.contracts['SameBlockProbe.sol'].SameBlockProbe;
writeFileSync(`${root}/same-block-probe-input.json`,JSON.stringify(input,null,2)+'\n');
const hash=await c!.walletClient.deployContract({abi:artifact.abi,bytecode:`0x${artifact.evm.bytecode.object}`,account:c!.account,chain:c!.chain,gas:1500000n} as never);
const r=await p.waitForTransactionReceipt({hash});if(r.status!=='success'||!r.contractAddress)throw Error('probe deployment failed');const probe=r.contractAddress;
console.log('RECEIPT probe deploy tx='+hash);
const funded=await writeAndWait(c!,{address:d.settlement,abi:loadLocalAbi('MockUSDC'),functionName:'transfer',args:[probe,50000000n],gas:100000n});console.log('RECEIPT fund probe tx='+funded.hash);
const tested=await writeAndWait(c!,{address:probe,abi:artifact.abi,functionName:'check',args:[d.settlement,d.depositShaman,d.baal,encodeProposalData([])],gas:1500000n});console.log('RECEIPT same-block refusal tx='+tested.hash);
const event=tested.receipt.logs.filter(l=>l.address.toLowerCase()===probe.toLowerCase()).map(l=>decodeEventLog({abi:artifact.abi as Abi,data:l.data,topics:l.topics})).find(e=>e.eventName==='Refused') as unknown as {args:{proposal:number;reason:Hex}};
if(!event||event.args.reason.slice(0,10)!==toFunctionSelector('TimePointNotDetermined(uint256,uint256)'))throw Error('missing snapshot refusal');
while(await p.getBlockNumber({cacheTime:0})<=tested.receipt.blockNumber)await new Promise(r=>setTimeout(r,2000));
const voted=await writeAndWait(c!,{address:probe,abi:artifact.abi,functionName:'vote',args:[d.baal,event.args.proposal],gas:500000n});console.log('RECEIPT later-block vote tx='+voted.hash);
if(voted.receipt.blockNumber<=tested.receipt.blockNumber)throw Error('later block required');
const out={chainId:84532,baal:d.baal,probe,deploy:hash,sameBlockRefusal:tested.hash,block:String(tested.receipt.blockNumber),reason:event.args.reason,laterVote:voted.hash,laterBlock:String(voted.receipt.blockNumber),result:'PASS'};
writeFileSync(`${root}/same-block-vote.json`,JSON.stringify(out,null,2)+'\n');console.log('NATIVE SAME-BLOCK VOTE REFUSAL PASS');
