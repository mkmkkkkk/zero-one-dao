/**
 * Deploy Zero One to Base Sepolia (84532) from the Mac mini and perform genesis in the same run:
 * MockUSDC (6 dec, mintable by the deployer), the five vendored Baal/Safe singletons, Safe + Baal
 * proxies, NavShareToken, LootToken, DepositShaman, WorkManager, four template deployers +
 * TemplateFactory, ZeroOneIntentAccount, Constitution (textHash = keccak256(docs/CONSTITUTION.md),
 * textUrl = the pinned raw GitHub URL of the genesis commit, fetched and hashed BEFORE deploying),
 * then the founder (deployer) deposits 50 mock USDC -> 50e18 shares. Nothing else is minted.
 * Writes deployments/base-sepolia.json (addresses, tx hashes, start block; committed) and
 * deployments/verification-base-sepolia/ (standard JSON + constructor arguments for Basescan).
 * Usage: tsx scripts/deploy-base-sepolia.ts --constitution-url <raw url> [--key-file <env file>] [--key-var ANCHOR_PRIVATE_KEY]
 *        [--rpc <url>] [--out deployments/base-sepolia.json] [--sponsor <address> --sponsor-usdc <units>]
 * Never prints a key. Refuses to run if the output file already exists (one canonical deployment).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress, keccak256, type Address, type Hex } from "viem";

import { parseArgs } from "../beacon/scripts/build.js";
import { deployLocal } from "../src/onchain.js";
import { fmtEth, keyFromEnvFile, liveChain, liveContexts } from "../src/live.js";
import { constitutionHash, DEFAULT_PARAMS, deployZeroOne, enumerateShamans, GENESIS_DEPOSIT, genesisDeposit, SETTLEMENT_UNIT } from "../src/zeroOne.js";
import { constructorArguments, writeVerificationInputs, type VerificationRecord } from "../src/verification.js";
import { loadLocalArtifact } from "../src/baal.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHAIN_ID = 84_532;
const MIN_DEPLOYER_WEI = 5_000_000_000_000_000n; // 0.005 ETH

/**
 * Deploy, run genesis, write the record and the verification inputs.
 *
 * @throws Error on any invariant failure (constitution URL bytes, balance, genesis mint).
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const out = path.resolve(ROOT, args.out ?? "deployments/base-sepolia.json");
  if (existsSync(out)) throw new Error(`${out} exists: the canonical Base Sepolia deployment is already recorded (move it aside deliberately to redeploy)`);
  const constitutionUrl = args["constitution-url"];
  if (constitutionUrl === undefined || !constitutionUrl.startsWith("https://")) throw new Error("--constitution-url <https url of the exact CONSTITUTION.md bytes> is required");
  const keyFile = args["key-file"] ?? process.env.ZERO_ONE_DEPLOYER_KEY_FILE ?? path.join(process.env.HOME ?? "", "srv", "aow-exit", ".env.sepolia");
  const key = keyFromEnvFile(keyFile, args["key-var"] ?? "ANCHOR_PRIVATE_KEY");

  const textHash = constitutionHash();
  const response = await fetch(constitutionUrl);
  if (!response.ok) throw new Error(`constitution URL answered ${response.status}`);
  const remote = keccak256(new Uint8Array(await response.arrayBuffer()));
  if (remote !== textHash) throw new Error(`constitution URL bytes hash to ${remote}, local docs/CONSTITUTION.md hashes to ${textHash}: push the genesis commit first`);
  console.log(`constitution ${constitutionUrl} keccak256 ${textHash} (matches local bytes)`);

  const chain = liveChain(CHAIN_ID, args.rpc);
  const { publicClient, contexts } = liveContexts(chain, [key]);
  const deployer = contexts[0]!;
  const balance = await publicClient.getBalance({ address: deployer.account.address });
  console.log(`deployer ${deployer.account.address} balance ${fmtEth(balance)} ETH on ${chain.name} (${chain.rpcUrls.default.http[0]})`);
  if (balance < MIN_DEPLOYER_WEI) throw new Error(`deployer holds ${fmtEth(balance)} ETH, below the ${fmtEth(MIN_DEPLOYER_WEI)} ETH floor`);

  const supply = 100_000_000n * SETTLEMENT_UNIT;
  const mock = await deployLocal(deployer, "MockUSDC", ["USDC-mock", "USDC", supply]);
  console.log(`MockUSDC ${mock.address} (tx ${mock.hash})`);
  const dao = await deployZeroOne(deployer, { ...DEFAULT_PARAMS, founder: deployer.account.address, settlement: mock.address, constitutionTextUrl: constitutionUrl });
  console.log(`safe ${dao.safe} baal ${dao.baal} shares ${dao.shares} factory ${dao.templateFactory} adapter ${dao.intentAccount} constitution ${dao.constitution}`);
  const genesis = await genesisDeposit(deployer, dao, GENESIS_DEPOSIT);
  console.log(`genesis: ${genesis.sharesMinted} shares to the founder (approve ${genesis.approveHash}, deposit ${genesis.depositHash})`);
  const shamans = await enumerateShamans(deployer, dao.baal, dao.startBlock);

  let sponsorFloat: { to: Address; usdc: string; hash: Hex } | undefined;
  if (args.sponsor !== undefined) {
    const to = getAddress(args.sponsor);
    const units = BigInt(args["sponsor-usdc"] ?? "1000000") * SETTLEMENT_UNIT;
    const mint = await deployer.publicClient.simulateContract({ address: mock.address, abi: mock.artifact.abi, functionName: "mint", args: [to, units], account: deployer.account } as never);
    const hash = await deployer.walletClient.writeContract({ ...mint.request, account: deployer.account, chain } as never);
    await publicClient.waitForTransactionReceipt({ hash });
    sponsorFloat = { to, usdc: units.toString(), hash };
    console.log(`minted ${units} mock USDC units to the relay sponsor ${to} (tx ${hash})`);
  }

  const artifactVersion = (loadLocalArtifact("Constitution") as unknown as { compiler: string }).compiler;
  const compiler = `v${artifactVersion.replace(/\.Emscripten\.clang$/u, "")}`;
  const records: VerificationRecord[] = [
    { name: "MockUSDC", contractName: "contracts/MockUSDC.sol:MockUSDC", address: mock.address, constructorArguments: constructorArguments("MockUSDC", ["USDC-mock", "USDC", supply]), compiler, txHash: mock.hash },
    { name: "NavShareToken", contractName: "contracts/NavShareToken.sol:NavShareToken", address: dao.shares, constructorArguments: constructorArguments("NavShareToken", [DEFAULT_PARAMS.shareName, DEFAULT_PARAMS.shareSymbol, dao.baal, dao.safe, mock.address]), compiler, txHash: dao.txHashes["NavShareToken"]! },
    { name: "LootToken", contractName: "contracts/LootToken.sol:LootToken", address: dao.loot, constructorArguments: constructorArguments("LootToken", [`${DEFAULT_PARAMS.shareName} Loot`, `${DEFAULT_PARAMS.shareSymbol}-LOOT`, dao.baal]), compiler, txHash: dao.txHashes["LootToken"]! },
    { name: "DepositShaman", contractName: "contracts/DepositShaman.sol:DepositShaman", address: dao.depositShaman, constructorArguments: constructorArguments("DepositShaman", [dao.baal, dao.shares]), compiler, txHash: dao.txHashes["DepositShaman"]! },
    { name: "WorkManager", contractName: "contracts/WorkManager.sol:WorkManager", address: dao.workManager, constructorArguments: constructorArguments("WorkManager", [dao.baal, dao.shares]), compiler, txHash: dao.txHashes["WorkManager"]! },
    { name: "PaymentDeployer", contractName: "contracts/TemplateFactory.sol:PaymentDeployer", address: dao.templateDeployers[0], constructorArguments: constructorArguments("PaymentDeployer", [dao.safe, mock.address]), compiler, txHash: dao.txHashes["PaymentDeployer"]! },
    { name: "StrategyDeployer", contractName: "contracts/TemplateFactory.sol:StrategyDeployer", address: dao.templateDeployers[1], constructorArguments: constructorArguments("StrategyDeployer", [dao.safe, mock.address]), compiler, txHash: dao.txHashes["StrategyDeployer"]! },
    { name: "ProjectDeployer", contractName: "contracts/TemplateFactory.sol:ProjectDeployer", address: dao.templateDeployers[2], constructorArguments: constructorArguments("ProjectDeployer", [dao.safe, mock.address]), compiler, txHash: dao.txHashes["ProjectDeployer"]! },
    { name: "ConfigDeployer", contractName: "contracts/TemplateFactory.sol:ConfigDeployer", address: dao.templateDeployers[3], constructorArguments: constructorArguments("ConfigDeployer", [dao.safe, mock.address, dao.baal]), compiler, txHash: dao.txHashes["ConfigDeployer"]! },
    { name: "TemplateFactory", contractName: "contracts/TemplateFactory.sol:TemplateFactory", address: dao.templateFactory, constructorArguments: constructorArguments("TemplateFactory", [dao.safe, mock.address, dao.baal, dao.templateDeployers]), compiler, txHash: dao.txHashes["TemplateFactory"]! },
    { name: "ZeroOneIntentAccount", contractName: "contracts/ZeroOneIntentAccount.sol:ZeroOneIntentAccount", address: dao.intentAccount, constructorArguments: constructorArguments("ZeroOneIntentAccount", [dao.baal, dao.depositShaman, dao.workManager, dao.templateFactory]), compiler, txHash: dao.txHashes["ZeroOneIntentAccount"]! },
    { name: "Constitution", contractName: "contracts/Constitution.sol:Constitution", address: dao.constitution, constructorArguments: constructorArguments("Constitution", [textHash, constitutionUrl]), compiler, txHash: dao.txHashes["Constitution"]! },
  ];
  const verificationDir = path.join(path.dirname(out), "verification-base-sepolia");
  const units = writeVerificationInputs(verificationDir, records);
  console.log(`verification inputs: ${verificationDir} (${units} source units, compiler ${compiler})`);

  const record = {
    chain: "Base Sepolia",
    chainId: CHAIN_ID,
    rpcUrl: chain.rpcUrls.default.http[0],
    explorer: "https://sepolia.basescan.org",
    deployedAt: new Date().toISOString(),
    startBlock: Number(dao.startBlock),
    deployer: deployer.account.address,
    founder: dao.params.founder,
    settlement: mock.address,
    settlementNote: "MockUSDC: 6 decimals, mintable by the deployer only (testnet); mainnet uses Circle USDC (docs/PARAMETERS.md)",
    safe: dao.safe,
    baal: dao.baal,
    shares: dao.shares,
    loot: dao.loot,
    depositShaman: dao.depositShaman,
    workManager: dao.workManager,
    templateFactory: dao.templateFactory,
    templateDeployers: dao.templateDeployers,
    intentAccount: dao.intentAccount,
    constitution: { address: dao.constitution, textHash, textUrl: constitutionUrl, text: "docs/CONSTITUTION.md" },
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
    genesis: { depositUsdc6: GENESIS_DEPOSIT.toString(), sharesMinted: genesis.sharesMinted.toString(), approveHash: genesis.approveHash, depositHash: genesis.depositHash },
    sponsorFloat,
    txHashes: { MockUSDC: mock.hash, ...dao.txHashes },
    compiler,
  };
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(record, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  console.log(JSON.stringify(record, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
