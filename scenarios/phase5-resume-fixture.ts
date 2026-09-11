/** Attach only to an explicitly selected native test fixture; never deploy or copy relay state. */
import {readFileSync} from 'node:fs';
import {type Hex, getAddress} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {liveChain,liveContexts,keyFromEnvFile} from '../src/live.js';
import {loadBaalArtifact,loadLocalArtifact,loadLocalAbi} from '../src/baal.js';
import {factoryAbi} from '../src/proposals.js';
import {DEFAULT_PARAMS,type ZeroOneDao} from '../src/zeroOne.js';
import {type Mirror,type ActorName} from './lib.js';
export async function attach(recordFile:string):Promise<Mirror>{
const d=JSON.parse(readFileSync(recordFile,'utf8'));
if(d.chainId!==84532||!process.env.ZERO_ONE_ACTORS_FILE||!process.env.ZERO_ONE_DEPLOYER_KEY_FILE)throw Error('Explicit native fixture required');
const names:ActorName[]=['F','A','B','C','D','O','W'];
const ak=JSON.parse(readFileSync(process.env.ZERO_ONE_ACTORS_FILE,'utf8'));
const keys:Hex[]=[keyFromEnvFile(process.env.ZERO_ONE_DEPLOYER_KEY_FILE),...names.slice(1).map(n=>ak[n])];
const chainDef=liveChain(84532),{publicClient,contexts}=liveContexts(chainDef,keys);
if(await publicClient.getChainId()!==84532)throw Error('RPC chain mismatch');
names.forEach((n,i)=>{if(getAddress(contexts[i]!.account.address)!==getAddress(d.actors[n]))throw Error('Actor identity mismatch '+n);});
const governance={...d.governance};for(const k of ['proposalOffering','quorumPercent','sponsorThreshold','minRetentionPercent'])governance[k]=BigInt(governance[k]);
const dao={...d,constitution:d.constitution.address,constitutionHash:d.constitution.textHash,constitutionTextUrl:d.constitution.textUrl,infrastructure:d.singletons,startBlock:BigInt(d.startBlock),params:{...DEFAULT_PARAMS,founder:d.founder,settlement:d.settlement,governance}} as ZeroOneDao;
console.log('RESUME native fixture',d.scenario,d.baal,'from',recordFile);
return {head:await publicClient.getBlockNumber({cacheTime:0}),chain:{chain:chainDef as never,publicClient,contexts,accounts:keys.map(k=>privateKeyToAccount(k))},dao,
    abi: {
      baal: loadBaalArtifact("Baal").abi,
      safe: loadBaalArtifact("GnosisSafe").abi,
      shares: loadLocalArtifact("NavShareToken").abi,
      settlement: loadLocalArtifact("TestToken").abi,
      deposit: loadLocalArtifact("DepositShaman").abi,
      work: loadLocalArtifact("WorkManager").abi,
      constitution: loadLocalArtifact("Constitution").abi,
      factory: factoryAbi(),
      // Common surface plus the base contract's custom errors, so negative cases decode OnlySafe / WrongStatus.
      proposal: [...loadLocalAbi("IProposalContract"), ...loadLocalAbi("ProposalBase").filter((item) => item.type === "error" || item.type === "event")],
      payment: loadLocalArtifact("PaymentProposal").abi,
      strategy: loadLocalArtifact("StrategyProposal").abi,
      project: loadLocalArtifact("ProjectProposal").abi,
      config: loadLocalArtifact("ConfigProposal").abi,
      dex: loadLocalArtifact("MockDex").abi,
    },
actors:Object.fromEntries(names.map((n,i)=>[n,contexts[i]])) as Mirror['actors']};
}
