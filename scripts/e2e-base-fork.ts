/** Full deployment entry module + genesis + Payment + K, one owned Base fork. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { fileURLToPath } from "node:url";
import { erc20Abi } from "viem";
import { startBaseFork, fundForkUsdc } from "../src/baseFork.js";
import { stopDevnet } from "../src/devnet.js";
import { connectDevnet, increaseTime, writeAndWait } from "../src/onchain.js";
import { loadBaalArtifact } from "../src/baal.js";
import { submitTemplateProposal } from "../src/proposals.js";
import { BASE_USDC, GENESIS_DEPOSIT, SETTLEMENT_UNIT } from "../src/zeroOne.js";
import { runUniswapFork } from "../scenarios/K-uniswap-v3-fork.js";
import { deployNetwork } from "./deploy-network.js";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(ROOT, "evidence", "phase3");
mkdirSync(dir, { recursive: true });
let log = path.join(dir, "deploy-base-fork.log");
writeFileSync(log, "");
const originalLog = console.log, originalError = console.error;
console.log = (...args: unknown[]) => { appendFileSync(log, format(...args) + "\n"); originalLog(...args); };
console.error = (...args: unknown[]) => { appendFileSync(log, format(...args) + "\n"); originalError(...args); };
async function main() {
  const devnet = await startBaseFork(`phase3-deploy-${Date.now()}`);
  try {
    const chain = connectDevnet(devnet);
    const founder = chain.contexts[0]!;
    await fundForkUsdc(devnet, founder.account.address, GENESIS_DEPOSIT);
    const keyFile = path.join(devnet.stateDir, "deployer.env");
    writeFileSync(keyFile, `ANCHOR_PRIVATE_KEY=${devnet.privateKeys[0]}\n`, { mode: 0o600 });
    const result = await deployNetwork(8453, ["--i-confirmed-parameters", "--fork", "--rpc", devnet.rpcUrl, "--key-file", keyFile, "--out", path.join(dir, `deploy-base-fork-${Date.now()}.json`)]);
    if (!result) throw new Error("deployment returned no DAO");
    const { dao } = result;
    const recipient = chain.contexts[1]!.account.address;
    const before = await chain.publicClient.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
    const proposal = await submitTemplateProposal(founder, dao, { template: "Payment", params: { recipients: [recipient], amounts: [SETTLEMENT_UNIT] } }, "phase3 fork Payment 1 USDC");
    console.log(`tx Payment deploy=${proposal.instance.deployHash} submit=${proposal.submitHash}`);
    const abi = loadBaalArtifact("Baal").abi;
    await increaseTime(founder, 2);
    const vote = await writeAndWait(founder, { address: dao.baal, abi, functionName: "submitVote", args: [proposal.id, true] });
    console.log(`tx Payment vote=${vote.hash}`);
    await increaseTime(founder, dao.params.governance.votingPeriod + dao.params.governance.gracePeriod + 2);
    const execution = await writeAndWait(founder, { address: dao.baal, abi, functionName: "processProposal", args: [proposal.id, proposal.data], gas: 5_000_000n });
    const status = await chain.publicClient.readContract({ address: dao.baal, abi, functionName: "getProposalStatus", args: [proposal.id] }) as readonly boolean[];
    const after = await chain.publicClient.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
    if (!status[1] || !status[2] || status[3] || after - before !== SETTLEMENT_UNIT) throw new Error("Payment exact transfer or execution failed");
    console.log(`ASSERT Payment processed passed=true actionFailed=false exactTransfer=1000000 tx=${execution.hash}`);
    console.log("ASSERT Base deployment + 50 USDC genesis + Payment PASS; no Etherscan verification invoked");
    log = path.join(dir, "uniswap-v3-fork.log");
    writeFileSync(log, `ASSERT same fork as deployment rpc=${devnet.rpcUrl} safe=${dao.safe} genesisTx=${result.record.genesis.depositHash}\n`);
    await runUniswapFork({ devnet, dao, founder, stranger: chain.contexts[1]! });
  } finally { await stopDevnet(devnet); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
