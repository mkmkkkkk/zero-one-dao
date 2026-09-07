/**
 * Stand the Zero One DAO up on a fresh local anvil mirror (no fork) with a test settlement token,
 * then perform genesis: the founder deposits 50 USDC through the DepositShaman -> 50e18 shares.
 * Nothing else is minted. Deployment and genesis happen in one script on purpose (never pre-fund
 * the Safe: a treasury with zero supply cannot be priced, see docs/PARAMETERS.md).
 * Usage: npm run deploy:local [-- --keep]   (--keep leaves anvil running until Ctrl-C)
 * Writes deployments/local.json (addresses only; anvil keys stay in state/, git-ignored).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startDevnet, stopDevnet } from "../src/devnet.js";
import { connectDevnet } from "../src/onchain.js";
import { DEFAULT_PARAMS, deployZeroOne, enumerateShamans, GENESIS_DEPOSIT, genesisDeposit } from "../src/zeroOne.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Boot anvil, deploy, run genesis, write deployments/local.json, and stop anvil (unless --keep).
 *
 * @throws Error if a deployment invariant fails or the genesis mint is not exactly 50e18 shares.
 */
async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const devnet = await startDevnet(`deploy-${Date.now()}`, { hardfork: "prague" });
  try {
    const chain = connectDevnet(devnet);
    const deployer = chain.contexts[0]!;
    const dao = await deployZeroOne(deployer, { ...DEFAULT_PARAMS, founder: deployer.account.address });
    const genesis = await genesisDeposit(deployer, dao, GENESIS_DEPOSIT);
    const shamans = await enumerateShamans(deployer, dao.baal);
    const record = {
      rpcUrl: devnet.rpcUrl,
      chainId: devnet.chainId,
      deployer: deployer.account.address,
      founder: dao.params.founder,
      settlement: dao.settlement,
      safe: dao.safe,
      baal: dao.baal,
      shares: dao.shares,
      loot: dao.loot,
      depositShaman: dao.depositShaman,
      workManager: dao.workManager,
      intentAccount: dao.intentAccount,
      singletons: dao.infrastructure,
      governance: {
        votingPeriod: dao.params.governance.votingPeriod,
        gracePeriod: dao.params.governance.gracePeriod,
        proposalOffering: dao.params.governance.proposalOffering.toString(),
        quorumPercent: dao.params.governance.quorumPercent.toString(),
        sponsorThreshold: dao.params.governance.sponsorThreshold.toString(),
        minRetentionPercent: dao.params.governance.minRetentionPercent.toString(),
      },
      shamans: shamans.map(({ shaman, permission }) => ({ shaman, permission: permission.toString() })),
      genesis: {
        depositUsdc6: GENESIS_DEPOSIT.toString(),
        sharesMinted: genesis.sharesMinted.toString(),
        approveHash: genesis.approveHash,
        depositHash: genesis.depositHash,
      },
      txHashes: dao.txHashes,
    };
    mkdirSync(path.join(ROOT, "deployments"), { recursive: true });
    writeFileSync(path.join(ROOT, "deployments", "local.json"), `${JSON.stringify(record, null, 2)}\n`);
    console.log(JSON.stringify(record, null, 2));
    if (keep) {
      console.log(`anvil listening on ${devnet.rpcUrl}; press Ctrl-C to stop`);
      await new Promise<void>((resolve) => {
        process.once("SIGINT", () => resolve());
        process.once("SIGTERM", () => resolve());
      });
    }
  } finally {
    await stopDevnet(devnet);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
