/**
 * Testnet governance helper for the canonical Base Sepolia DAO, driven by the founder key on the mini:
 *   --voting <s> --grace <s>   submit a Config template proposal (Baal.setGovernanceConfig with the two
 *                              periods replaced, everything else read from Baal) and vote YES after the
 *                              next block; prints the proposal id, votingEnds and graceEnds.
 *   --execute <id>             process a Ready proposal with the explicit 5,000,000 gas and print the flags
 *                              and Baal's periods afterwards.
 *   --status <id>              print the proposal state and deadlines.
 * 120 s / 120 s is a TESTNET-ONLY setting so scenarios and cold starts finish in real time; the final
 * proposal restores 6 h / 6 h (docs/PARAMETERS.md). Direct contract calls; the relay path is exercised
 * by the cold-start runs. Usage: tsx scripts/testnet-governance.ts ... [--key-file <env file>] [--deployment deployments/base-sepolia.json]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Address, Hex } from "viem";

import { parseArgs } from "../beacon/scripts/build.js";
import { loadBaalArtifact, type GovernanceConfig } from "../src/baal.js";
import { keyFromEnvFile, liveChain, liveContexts } from "../src/live.js";
import { awaitRead, simulateSettled } from "../src/onchain.js";
import { submitTemplateProposal } from "../src/proposals.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROCESS_GAS = 5_000_000n;
const STATES = ["Unborn", "Submitted", "Voting", "Cancelled", "Grace", "Ready", "Processed", "Defeated"] as const;

interface Deployment {
  chainId: number;
  safe: Address;
  settlement: Address;
  baal: Address;
  templateFactory: Address;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const deploymentFile = path.resolve(ROOT, args.deployment ?? "deployments/base-sepolia.json");
  const deployment = JSON.parse(readFileSync(deploymentFile, "utf8")) as Deployment;
  const keyFile = args["key-file"] ?? process.env.ZERO_ONE_DEPLOYER_KEY_FILE ?? path.join(process.env.HOME ?? "", "srv", "aow-exit", ".env.sepolia");
  const chain = liveChain(deployment.chainId, args.rpc);
  const { publicClient, contexts } = liveContexts(chain, [keyFromEnvFile(keyFile, args["key-var"] ?? "ANCHOR_PRIVATE_KEY")]);
  const founder = contexts[0]!;
  const baalAbi = loadBaalArtifact("Baal").abi;
  const readBaal = <T,>(functionName: string, fnArgs: readonly unknown[] = []): Promise<T> => publicClient.readContract({ address: deployment.baal, abi: baalAbi, functionName, args: fnArgs } as never) as Promise<T>;
  const periods = async (): Promise<{ votingPeriod: number; gracePeriod: number }> => ({ votingPeriod: Number(await readBaal<number>("votingPeriod")), gracePeriod: Number(await readBaal<number>("gracePeriod")) });
  const proposalView = async (id: number): Promise<Record<string, unknown>> => {
    const raw = await readBaal<readonly unknown[]>("proposals", [id]);
    const status = await readBaal<readonly boolean[]>("getProposalStatus", [id]);
    return { id, state: STATES[Number(await readBaal<number>("state", [id]))], votingStarts: Number(raw[2]), votingEnds: Number(raw[3]), graceEnds: Number(raw[4]), yesVotes: String(raw[7]), noVotes: String(raw[8]), sponsor: raw[11], cancelled: status[0], processed: status[1], passed: status[2], actionFailed: status[3] };
  };

  if (args.status !== undefined) {
    console.log(JSON.stringify({ ...(await proposalView(Number(args.status))), baal: await periods(), chainTime: Number((await publicClient.getBlock()).timestamp) }, null, 2));
    return;
  }
  if (args.execute !== undefined) {
    const id = Number(args.execute);
    const before = await proposalView(id);
    if (before.state !== "Ready") throw new Error(`proposal #${id} is ${String(before.state)}, not Ready (graceEnds ${String(before.graceEnds)}, now ${Number((await publicClient.getBlock()).timestamp)})`);
    // Baal reads the proposal data back from the submission event; re-encode via the stored details is impossible, so the caller passes --data.
    const data = args.data as Hex | undefined;
    if (data === undefined) throw new Error("--data <proposalData hex> is required to execute (printed at submission)");
    const simulation = await simulateSettled<{ request: Record<string, unknown> }>(founder, { address: deployment.baal, abi: baalAbi, functionName: "processProposal", args: [id, data], gas: PROCESS_GAS });
    const hash = await founder.walletClient.writeContract({ ...simulation.request, gas: PROCESS_GAS, account: founder.account, chain } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`processProposal reverted: ${hash}`);
    const after = await awaitRead(() => proposalView(id), (view) => view.processed === true);
    console.log(JSON.stringify({ hash, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), proposal: after, baal: await periods() }, null, 2));
    return;
  }

  const voting = Number(args.voting);
  const grace = Number(args.grace);
  if (!Number.isInteger(voting) || !Number.isInteger(grace) || voting < 1 || grace < 0) throw new Error("--voting <seconds> and --grace <seconds> are required");
  const current: GovernanceConfig = {
    votingPeriod: Number(await readBaal<number>("votingPeriod")),
    gracePeriod: Number(await readBaal<number>("gracePeriod")),
    proposalOffering: await readBaal<bigint>("proposalOffering"),
    quorumPercent: await readBaal<bigint>("quorumPercent"),
    sponsorThreshold: await readBaal<bigint>("sponsorThreshold"),
    minRetentionPercent: await readBaal<bigint>("minRetentionPercent"),
  };
  const next: GovernanceConfig = { ...current, votingPeriod: voting, gracePeriod: grace };
  const summary = args.summary ?? (voting <= 600 ? `testnet-only: voting ${current.votingPeriod}s -> ${voting}s, grace ${current.gracePeriod}s -> ${grace}s so Base Sepolia scenarios and cold starts finish in real time; to be restored to 6h/6h by a final proposal` : `restore voting ${current.votingPeriod}s -> ${voting}s, grace ${current.gracePeriod}s -> ${grace}s (docs/PARAMETERS.md initial values)`);
  console.log(`founder ${founder.account.address}: Config proposal ${JSON.stringify({ ...next, proposalOffering: next.proposalOffering.toString(), quorumPercent: next.quorumPercent.toString(), sponsorThreshold: next.sponsorThreshold.toString(), minRetentionPercent: next.minRetentionPercent.toString() })}`);
  const submitted = await submitTemplateProposal(founder, deployment, { template: "Config", params: next }, summary);
  console.log(`instance ${submitted.instance.address} (deploy ${submitted.instance.deployHash ?? "existing"}, salt ${submitted.instance.salt}, codeHash ${submitted.instance.codeHash}); proposal #${submitted.id} submit ${submitted.submitHash}`);
  console.log(`proposalData ${submitted.data}`);
  const view = await awaitRead(() => proposalView(submitted.id), (candidate) => candidate.state === "Voting");
  const votingStarts = Number(view.votingStarts);
  await awaitRead(() => publicClient.getBlock().then((block) => Number(block.timestamp)), (timestamp) => timestamp > votingStarts, 60);
  const vote = await simulateSettled<{ request: Record<string, unknown> }>(founder, { address: deployment.baal, abi: baalAbi, functionName: "submitVote", args: [submitted.id, true] });
  const voteHash = await founder.walletClient.writeContract({ ...vote.request, account: founder.account, chain } as never);
  const voteReceipt = await publicClient.waitForTransactionReceipt({ hash: voteHash });
  if (voteReceipt.status !== "success") throw new Error(`submitVote reverted: ${voteHash}`);
  const after = await awaitRead(() => proposalView(submitted.id), (candidate) => BigInt(String(candidate.yesVotes)) > 0n);
  console.log(JSON.stringify({ proposal: after, voteHash, executeAfter: new Date(Number(after.graceEnds) * 1000).toISOString(), executeCommand: `tsx scripts/testnet-governance.ts --execute ${submitted.id} --data ${submitted.data}` }, null, 2));
}

main().catch((error: unknown) => {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  console.error(error instanceof Error ? `${error.message}${cause ? ` (cause: ${cause.code ?? ""} ${cause.message ?? ""})` : ""}` : error);
  process.exitCode = 1;
});
