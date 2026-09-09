import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { concatHex, encodeAbiParameters, erc20Abi, getAddress, getContractAddress, keccak256, type Address, type Hex } from "viem";

import { parseArgs } from "../beacon/scripts/build.js";
import { deployLocal } from "../src/onchain.js";
import { fmtEth, keyFromEnvFile, liveChain, liveContexts } from "../src/live.js";
import { BASE_USDC, constitutionHash, DEFAULT_PARAMS, deployZeroOne, enumerateShamans, GENESIS_DEPOSIT, genesisDeposit, proxySaltNonce, SETTLEMENT_UNIT } from "../src/zeroOne.js";
import { constructorArguments, writeVerificationInputs, type VerificationRecord } from "../src/verification.js";
import { loadBaalArtifact, loadLocalArtifact } from "../src/baal.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { assertBaseFork } from "../src/baseFork.js";
const MIN_DEPLOYER_WEI = 5_000_000_000_000_000n; // 0.005 ETH

/**
 * Deploy, run genesis, write the record and the verification inputs.
 *
 * @throws Error on any invariant failure (constitution URL bytes, balance, genesis mint).
 */
export async function deployNetwork(CHAIN_ID: 8453 | 84532, argv = process.argv.slice(2)) {
  const mainnet = CHAIN_ID === 8453;
  if (argv.includes("--help")) {
    console.log(`Usage: tsx scripts/deploy-${mainnet ? "base" : "base-sepolia"}.ts --constitution-url <raw GitHub URL> --key-file <file> [--rpc <url>] [--out <file>] ${mainnet ? "--i-confirmed-parameters" : ""}
Base mainnet refuses unless all five preconditions hold:
1. HEAD is pushed to origin (constitution URL pins that genesis commit).
2. Constitution URL bytes hash to Constitution.textHash.
3. Deployer holds >= 50 USDC and >= 0.005 ETH; proxy decimals must be 6.
4. CREATE2-predicted Safe holds exactly 0 USDC before deployment.
5. --i-confirmed-parameters is passed (checked before key access or RPC).
Fork rehearsal only: --fork; requires loopback Anvil fork of Base, no public fallback, output under evidence/phase3.
Sepolia accepts --sponsor <address> --sponsor-usdc <units>; Base forbids both.`);
    return;
  }
  if (mainnet && !argv.includes("--i-confirmed-parameters")) throw new Error("REFUSED: --i-confirmed-parameters is required before any RPC write");
  const fork = argv.includes("--fork");
  const args = parseArgs(argv.filter((arg) => !["--i-confirmed-parameters", "--fork"].includes(arg)));
  const network = mainnet ? "base" : "base-sepolia";
  if (mainnet && (args.sponsor !== undefined || args["sponsor-usdc"] !== undefined)) throw new Error("Base has no mock mint or faucet");
  if (fork && !mainnet) throw new Error("--fork is only supported for Base rehearsal");
  if (args["genesis-commit"]) throw new Error("genesis commit is always HEAD; overrides are refused");
  if (fork) await assertBaseFork(args.rpc ?? "");
  const out = path.resolve(ROOT, args.out ?? (fork ? "evidence/phase3/deploy-base-fork.json" : `deployments/${network}.json`));
  if (existsSync(out)) throw new Error(`${out} exists: a deployment is already recorded (move it aside deliberately to redeploy)`);
  if (fork && !out.startsWith(path.join(ROOT, "evidence", "phase3") + path.sep)) throw new Error("fork record must be under evidence/phase3");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const workingTreeDirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
  if (mainnet && !fork && workingTreeDirty) throw new Error("REFUSED: production deployment requires a clean working tree at pushed HEAD");
  const genesisCommit = head;
  if (mainnet) {
    if (!/^[0-9a-f]{40}$/u.test(genesisCommit)) throw new Error("genesis commit must be a full SHA");
    const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" }).trim();
    if (!["https://github.com/mkmkkkkk/zero-one-dao.git", "https://github.com/mkmkkkkk/zero-one-dao", "git@github.com:mkmkkkkk/zero-one-dao.git"].includes(origin)) throw new Error("origin must be the public genesis repository");
    // Read the same live ref advertisement used by git ls-remote. curl respects the host's
    // existing transport environment; no cached origin refs or local publication override.
    const advertisement = execFileSync("curl", ["--fail", "--silent", "--show-error", "--connect-timeout", "10", "--max-time", "30", "https://github.com/mkmkkkkk/zero-one-dao.git/info/refs?service=git-upload-pack"], { timeout: 35000, maxBuffer: 1048576 });
    let pushed = false;
    for (let offset = 0; offset + 4 <= advertisement.length;) {
      const size = Number.parseInt(advertisement.subarray(offset, offset + 4).toString(), 16);
      if (!Number.isFinite(size)) throw new Error("invalid Git ref advertisement");
      if (size === 0) { offset += 4; continue; }
      if (size < 4 || offset + size > advertisement.length) throw new Error("truncated Git ref advertisement");
      const row = advertisement.subarray(offset + 4, offset + size).toString();
      if (row.startsWith(`${genesisCommit} refs/`)) pushed = true;
      offset += size;
    }
    if (!pushed) throw new Error("REFUSED: genesis HEAD is not pushed as an origin ref");
    console.log(`ASSERT HEAD ${head} advertised by public origin`);
  }
  const constitutionUrl = args["constitution-url"] ?? (mainnet ? `https://raw.githubusercontent.com/mkmkkkkk/zero-one-dao/${genesisCommit}/docs/CONSTITUTION.md` : undefined);
  if (mainnet && constitutionUrl !== `https://raw.githubusercontent.com/mkmkkkkk/zero-one-dao/${genesisCommit}/docs/CONSTITUTION.md`) throw new Error("constitution URL must pin the pushed genesis SHA");
  if (constitutionUrl === undefined || !constitutionUrl.startsWith("https://")) throw new Error("--constitution-url <https url of the exact CONSTITUTION.md bytes> is required");
  if (mainnet && !args["key-file"] && !process.env.ZERO_ONE_DEPLOYER_KEY_FILE) throw new Error("Base requires an explicit deployer key file");
  const keyFile = args["key-file"] ?? process.env.ZERO_ONE_DEPLOYER_KEY_FILE ?? path.join(process.env.HOME ?? "", "srv", "aow-exit", ".env.sepolia");
  const key = keyFromEnvFile(keyFile, args["key-var"] ?? "ANCHOR_PRIVATE_KEY");

  const textHash = constitutionHash();
  let remoteBytes: Uint8Array;
  try {
    const response = await fetch(constitutionUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`constitution URL answered ${response.status}`);
    remoteBytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    console.log(`constitution fetch retry via curl: ${error instanceof Error ? error.message : error}`);
    remoteBytes = execFileSync("curl", ["--fail", "--silent", "--show-error", "--location", "--connect-timeout", "10", "--max-time", "30", constitutionUrl], { timeout: 35000, maxBuffer: 1048576 });
  }
  const remote = keccak256(remoteBytes);
  if (remote !== textHash) throw new Error(`constitution URL bytes hash to ${remote}, local docs/CONSTITUTION.md hashes to ${textHash}: push the genesis commit first`);
  console.log(`constitution ${constitutionUrl} keccak256 ${textHash} (matches local bytes)`);

  const chain = liveChain(CHAIN_ID, args.rpc);
  const { publicClient, contexts } = liveContexts(chain, [key]);
  const deployer = contexts[0]!;
  if (await publicClient.getChainId() !== CHAIN_ID) throw new Error("RPC chainId mismatch");
  const balance = await publicClient.getBalance({ address: deployer.account.address });
  console.log(`deployer ${deployer.account.address} balance ${fmtEth(balance)} ETH on ${chain.name} (${chain.rpcUrls.default.http[0]})`);
  if (balance < MIN_DEPLOYER_WEI) throw new Error(`deployer holds ${fmtEth(balance)} ETH, below the ${fmtEth(MIN_DEPLOYER_WEI)} ETH floor`);

  const supply = 100_000_000n * SETTLEMENT_UNIT;
  let predictedSafe: Address | undefined;
  const emptySafe = async (address: Address) => {
    if (predictedSafe && getAddress(address) !== getAddress(predictedSafe)) throw new Error("Safe prediction changed: deployer nonce was used concurrently");
    const held = await publicClient.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    if (held !== 0n) throw new Error(`REFUSED: predicted Safe ${address} already holds ${held} USDC (no longer a trap since phase 5 ruling 8, it would accrue to the genesis shares; pick a fresh salt for a clean address)`);
    console.log(`ASSERT CREATE2-predicted Safe ${address} USDC=0 before deployment`);
  };
  if (mainnet) {
    const decimals = await publicClient.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "decimals" });
    const held = await publicClient.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [deployer.account.address] });
    if (decimals !== 6 || held < GENESIS_DEPOSIT) throw new Error(`REFUSED: USDC proxy decimals=${decimals}, deployer balance=${held}, needs >=50000000`);
    const nonce = BigInt(await publicClient.getTransactionCount({ address: deployer.account.address, blockTag: "pending" }));
    const singleton = getContractAddress({ from: deployer.account.address, nonce: nonce + 2n });
    const factory = getContractAddress({ from: deployer.account.address, nonce: nonce + 3n });
    const bytecode = concatHex([loadBaalArtifact("GnosisSafeProxy").bytecode, encodeAbiParameters([{ type: "uint256" }], [BigInt(singleton)])]);
    const salt = keccak256(concatHex([keccak256("0x"), encodeAbiParameters([{ type: "uint256" }], [proxySaltNonce(deployer.account.address, DEFAULT_PARAMS.salt, 0)])]));
    predictedSafe = getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecode });
    await emptySafe(predictedSafe);
  }
  const mock = mainnet ? undefined : await deployLocal(deployer, "MockUSDC", ["USDC-mock", "USDC", supply]);
  if (mock) console.log(`MockUSDC ${mock.address} (tx ${mock.hash})`);
  const settlement = mock?.address ?? BASE_USDC;
  const dao = await deployZeroOne(deployer, { ...DEFAULT_PARAMS, founder: deployer.account.address, settlement, constitutionTextUrl: constitutionUrl, beforeSafeCreate: mainnet ? emptySafe : undefined });
  console.log(`safe ${dao.safe} baal ${dao.baal} shares ${dao.shares} factory ${dao.templateFactory} adapter ${dao.intentAccount} constitution ${dao.constitution}`);
  const genesis = await genesisDeposit(deployer, dao, GENESIS_DEPOSIT);
  console.log(`genesis: ${genesis.sharesMinted} shares to the founder (approve ${genesis.approveHash}, deposit ${genesis.depositHash})`);
  const shamans = await enumerateShamans(deployer, dao.baal, dao.startBlock);

  let sponsorFloat: { to: Address; usdc: string; hash: Hex } | undefined;
  if (args.sponsor !== undefined && mock) {
    const to = getAddress(args.sponsor);
    const units = BigInt(args["sponsor-usdc"] ?? "1000000") * SETTLEMENT_UNIT;
    const mint = await deployer.publicClient.simulateContract({ address: settlement, abi: mock.artifact.abi, functionName: "mint", args: [to, units], account: deployer.account } as never);
    const hash = await deployer.walletClient.writeContract({ ...mint.request, account: deployer.account, chain } as never);
    await publicClient.waitForTransactionReceipt({ hash });
    sponsorFloat = { to, usdc: units.toString(), hash };
    console.log(`minted ${units} mock USDC units to the relay sponsor ${to} (tx ${hash})`);
  }

  const artifactVersion = (loadLocalArtifact("Constitution") as unknown as { compiler: string }).compiler;
  const compiler = `v${artifactVersion.replace(/\.Emscripten\.clang$/u, "")}`;
  const records: VerificationRecord[] = [
    ...(mock ? [{ name: "MockUSDC", contractName: "contracts/MockUSDC.sol:MockUSDC", address: settlement, constructorArguments: constructorArguments("MockUSDC", ["USDC-mock", "USDC", supply]), compiler, txHash: mock.hash }] : []),
    { name: "NavShareToken", contractName: "contracts/NavShareToken.sol:NavShareToken", address: dao.shares, constructorArguments: constructorArguments("NavShareToken", [DEFAULT_PARAMS.shareName, DEFAULT_PARAMS.shareSymbol, dao.baal, dao.safe, settlement]), compiler, txHash: dao.txHashes["NavShareToken"]! },
    { name: "LootToken", contractName: "contracts/LootToken.sol:LootToken", address: dao.loot, constructorArguments: constructorArguments("LootToken", [`${DEFAULT_PARAMS.shareName} Loot`, `${DEFAULT_PARAMS.shareSymbol}-LOOT`, dao.baal]), compiler, txHash: dao.txHashes["LootToken"]! },
    { name: "TreasuryLedger", contractName: "contracts/TreasuryLedger.sol:TreasuryLedger", address: dao.treasuryLedger, constructorArguments: constructorArguments("TreasuryLedger", [dao.safe, settlement, dao.templateFactory]), compiler, txHash: dao.txHashes["TemplateFactory"]! },
    { name: "DepositShaman", contractName: "contracts/DepositShaman.sol:DepositShaman", address: dao.depositShaman, constructorArguments: constructorArguments("DepositShaman", [dao.baal, dao.shares, dao.treasuryLedger]), compiler, txHash: dao.txHashes["DepositShaman"]! },
    { name: "WorkManager", contractName: "contracts/WorkManager.sol:WorkManager", address: dao.workManager, constructorArguments: constructorArguments("WorkManager", [dao.baal, dao.shares]), compiler, txHash: dao.txHashes["WorkManager"]! },
    { name: "PaymentDeployer", contractName: "contracts/TemplateFactory.sol:PaymentDeployer", address: dao.templateDeployers[0], constructorArguments: constructorArguments("PaymentDeployer", [dao.safe, settlement]), compiler, txHash: dao.txHashes["PaymentDeployer"]! },
    { name: "StrategyDeployer", contractName: "contracts/TemplateFactory.sol:StrategyDeployer", address: dao.templateDeployers[1], constructorArguments: constructorArguments("StrategyDeployer", [dao.safe, settlement]), compiler, txHash: dao.txHashes["StrategyDeployer"]! },
    { name: "ProjectDeployer", contractName: "contracts/TemplateFactory.sol:ProjectDeployer", address: dao.templateDeployers[2], constructorArguments: constructorArguments("ProjectDeployer", [dao.safe, settlement]), compiler, txHash: dao.txHashes["ProjectDeployer"]! },
    { name: "ConfigDeployer", contractName: "contracts/TemplateFactory.sol:ConfigDeployer", address: dao.templateDeployers[3], constructorArguments: constructorArguments("ConfigDeployer", [dao.safe, settlement, dao.baal]), compiler, txHash: dao.txHashes["ConfigDeployer"]! },
    { name: "TemplateFactory", contractName: "contracts/TemplateFactory.sol:TemplateFactory", address: dao.templateFactory, constructorArguments: constructorArguments("TemplateFactory", [dao.safe, settlement, dao.baal, dao.templateDeployers]), compiler, txHash: dao.txHashes["TemplateFactory"]! },
    { name: "ZeroOneIntentAccount", contractName: "contracts/ZeroOneIntentAccount.sol:ZeroOneIntentAccount", address: dao.intentAccount, constructorArguments: constructorArguments("ZeroOneIntentAccount", [dao.baal, dao.depositShaman, dao.workManager, dao.templateFactory]), compiler, txHash: dao.txHashes["ZeroOneIntentAccount"]! },
    { name: "Constitution", contractName: "contracts/Constitution.sol:Constitution", address: dao.constitution, constructorArguments: constructorArguments("Constitution", [textHash, constitutionUrl]), compiler, txHash: dao.txHashes["Constitution"]! },
  ];
  const verificationDir = path.join(path.dirname(out), `verification-${network}`);
  const units = writeVerificationInputs(verificationDir, records);
  console.log(`verification inputs: ${verificationDir} (${units} source units, compiler ${compiler})`);

  const record = {
    chain: mainnet ? "Base" : "Base Sepolia",
    fork,
    sourceCommit: head,
    workingTreeDirty,
    genesisCommit,
    chainId: CHAIN_ID,
    rpcUrl: chain.rpcUrls.default.http[0],
    explorer: mainnet ? "https://basescan.org" : "https://sepolia.basescan.org",
    deployedAt: new Date().toISOString(),
    startBlock: Number(dao.startBlock),
    deployer: deployer.account.address,
    founder: dao.params.founder,
    settlement: settlement,
    settlementNote: mainnet ? "Circle USDC on Base; no mint or faucet" : "MockUSDC: 6 decimals, mintable by the deployer only (testnet); mainnet uses Circle USDC (docs/PARAMETERS.md)",
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
    txHashes: { ...(mock ? { MockUSDC: mock.hash } : {}), ...dao.txHashes },
    compiler,
  };
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(record, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  console.log(JSON.stringify(record, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2));
  return { dao, record };
}
