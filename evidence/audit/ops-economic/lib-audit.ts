/**
 * Shared helpers for the operations / economic audit tests (components 6 and 7 of
 * goals/security-audit.md). Compiles the audit-only Solidity helpers under ./contracts with the same
 * solc settings as scripts/compile.ts, writes their artifacts under ./artifacts (never into
 * contracts/artifacts), and boots a mirror whose settlement token can be swapped for the audit
 * BlacklistToken. Nothing here touches contracts/, relay/ or docs/.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import solc from "solc";
import { getAddress, type Abi, type Address, type Hex } from "viem";

import { deployArtifact, loadBaalArtifact, loadLocalAbi, loadLocalArtifact, type ContractArtifact, type WriteContext } from "../../../src/baal.js";
import { startDevnet, stopDevnet } from "../../../src/devnet.js";
import { connectDevnet } from "../../../src/onchain.js";
import { factoryAbi } from "../../../src/proposals.js";
import { DEFAULT_PARAMS, deployZeroOne, type ZeroOneDao, type ZeroOneParams } from "../../../src/zeroOne.js";
import { assertConstitution, assertFactory, assertOnlyMintPaths, type Mirror } from "../../../scenarios/lib.js";

export const AUDIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.resolve(AUDIT_DIR, "..", "..", "..");
const CONTRACTS_DIR = path.join(AUDIT_DIR, "contracts");
const ARTIFACTS_DIR = path.join(AUDIT_DIR, "artifacts");

/**
 * Compile every .sol file under evidence/audit/ops-economic/contracts with solc (cancun, viaIR,
 * optimizer 200 runs, the settings of scripts/compile.ts) and write one artifact per contract.
 *
 * @returns Names of the contracts written.
 * @throws Error if solc reports an error.
 */
export function compileAuditContracts(): string[] {
  const sources: Record<string, { content: string }> = {};
  for (const name of readdirSync(CONTRACTS_DIR).sort()) {
    if (!name.endsWith(".sol")) continue;
    sources[`audit/${name}`] = { content: readFileSync(path.join(CONTRACTS_DIR, name), "utf8") };
  }
  const resolveImport = (importPath: string): { contents: string } | { error: string } => {
    for (const candidate of [path.resolve(ROOT, "contracts", importPath), path.resolve(ROOT, "node_modules", importPath)]) {
      try {
        return { contents: readFileSync(candidate, "utf8") };
      } catch {
        // next
      }
    }
    return { error: `Import not found: ${importPath}` };
  };
  const input = {
    language: "Solidity",
    sources,
    settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport })) as { errors?: Array<{ severity: string; formattedMessage?: string; message: string }>; contracts?: Record<string, Record<string, { abi: unknown[]; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>> };
  const errors = (output.errors ?? []).filter((d) => d.severity === "error");
  if (errors.length !== 0) throw new Error(errors.map((d) => d.formattedMessage ?? d.message).join("\n"));
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const written: string[] = [];
  for (const contracts of Object.values(output.contracts ?? {})) {
    for (const [contractName, contract] of Object.entries(contracts)) {
      if (contract.evm.bytecode.object === "") continue;
      const artifact = { contractName, compiler: solc.version(), abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}`, deployedBytecode: `0x${contract.evm.deployedBytecode.object}` };
      writeFileSync(path.join(ARTIFACTS_DIR, `${contractName}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
      written.push(contractName);
    }
  }
  return written;
}

/**
 * Load an audit artifact (compiling first when it is missing).
 *
 * @param contractName Name of the audit contract.
 * @returns The artifact.
 */
export function loadAuditArtifact(contractName: string): ContractArtifact {
  const file = path.join(ARTIFACTS_DIR, `${contractName}.json`);
  try {
    readFileSync(file);
  } catch {
    compileAuditContracts();
  }
  return JSON.parse(readFileSync(file, "utf8")) as ContractArtifact;
}

/**
 * Deploy an audit contract.
 *
 * @param context Signer paying for the deployment.
 * @param contractName Audit contract name.
 * @param args Constructor arguments.
 * @returns Address, transaction hash and artifact.
 */
export async function deployAudit(context: WriteContext, contractName: string, args: readonly unknown[] = []): Promise<{ address: Address; hash: Hex; artifact: ContractArtifact }> {
  const artifact = loadAuditArtifact(contractName);
  const deployment = await deployArtifact(context, artifact, args);
  return { ...deployment, artifact };
}

/**
 * Boot a mirror like scenarios/lib.ts boot(), with an optional settlement override deployed by the
 * founder before the DAO (used for the USDC-blacklist rows). Runs the same three boot assertions.
 *
 * @param name Run label (anvil state directory).
 * @param options `settlement`: a function deploying the settlement token and returning its address; `params`: ZeroOneParams overrides.
 * @returns A Mirror usable with every scenarios/lib.ts helper.
 */
export async function bootAudit(name: string, options: { settlement?: (founder: WriteContext) => Promise<Address>; params?: Partial<Omit<ZeroOneParams, "founder">> } = {}): Promise<Mirror> {
  const devnet = await startDevnet(`${name}-${Date.now()}`, { hardfork: "prague" });
  const chain = connectDevnet(devnet);
  const deployer = chain.contexts[0]!;
  let dao: ZeroOneDao;
  try {
    const settlement = options.settlement ? await options.settlement(deployer) : undefined;
    dao = await deployZeroOne(deployer, { ...DEFAULT_PARAMS, ...options.params, founder: deployer.account.address, ...(settlement ? { settlement } : {}) });
  } catch (error) {
    await stopDevnet(devnet);
    throw error;
  }
  console.log(`anvil ${devnet.rpcUrl} chainId ${devnet.chainId}`);
  const mirror: Mirror = {
    devnet,
    head: await chain.publicClient.getBlockNumber(),
    chain,
    dao,
    abi: {
      baal: loadBaalArtifact("Baal").abi,
      safe: loadBaalArtifact("GnosisSafe").abi,
      shares: loadLocalArtifact("NavShareToken").abi,
      settlement: loadLocalArtifact("TestToken").abi,
      deposit: loadLocalArtifact("DepositShaman").abi,
      work: loadLocalArtifact("WorkManager").abi,
      constitution: loadLocalArtifact("Constitution").abi,
      factory: factoryAbi(),
      proposal: [...loadLocalAbi("IProposalContract"), ...loadLocalAbi("ProposalBase").filter((item) => item.type === "error" || item.type === "event")] as Abi,
      payment: loadLocalArtifact("PaymentProposal").abi,
      strategy: loadLocalArtifact("StrategyProposal").abi,
      project: loadLocalArtifact("ProjectProposal").abi,
      config: loadLocalArtifact("ConfigProposal").abi,
      dex: loadLocalArtifact("MockDex").abi,
    },
    actors: { F: chain.contexts[0]!, A: chain.contexts[1]!, B: chain.contexts[2]!, C: chain.contexts[3]!, D: chain.contexts[4]!, O: chain.contexts[5]!, W: chain.contexts[6]! },
  };
  console.log(`deployed: safe ${dao.safe} baal ${dao.baal} shares ${dao.shares} settlement ${dao.settlement}`);
  for (const [actor, context] of Object.entries(mirror.actors)) console.log(`   ${actor} = ${context.account.address}`);
  try {
    await assertOnlyMintPaths(mirror);
    await assertConstitution(mirror);
    await assertFactory(mirror);
  } catch (error) {
    await stopDevnet(devnet);
    throw error;
  }
  return mirror;
}

/** Checksummed address helper for logs. */
export function addr(value: string): Address {
  return getAddress(value);
}

/**
 * Expect a promise to reject; return the error text (first 200 chars) for the log.
 *
 * @param promise The call expected to fail.
 * @param label Log label.
 * @returns The error message text.
 * @throws Error if the promise resolves.
 */
export async function mustRevert(promise: Promise<unknown>, label: string): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const text = (error instanceof Error ? error.message : String(error)).split("\n").filter((line) => line.trim() !== "").slice(0, 3).join(" | ");
    console.log(`   revert ok [${label}]: ${text.slice(0, 220)}`);
    return text;
  }
  throw new Error(`ASSERTION FAILED: ${label} did not revert`);
}
