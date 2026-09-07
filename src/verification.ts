/**
 * Source verification inputs for Etherscan V2 (Basescan): the exact solc standard JSON input used by
 * scripts/compile.ts with every imported source inlined, plus ABI-encoded constructor arguments per
 * deployed contract. Written next to the deployment record; submitted by scripts/verify-etherscan-v2.py.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encodeAbiParameters, type Address, type Hex } from "viem";

import { loadLocalArtifact } from "./baal.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Compiler settings shared with scripts/compile.ts (must stay identical or verification fails). */
export const COMPILER_SETTINGS = {
  evmVersion: "cancun",
  optimizer: { enabled: true, runs: 200 },
  viaIR: true,
  outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.bytecode.linkReferences", "evm.deployedBytecode.object", "evm.deployedBytecode.linkReferences"] } },
} as const;

/** Resolve an import path the way scripts/compile.ts does (contracts/, repo root, node_modules). */
function resolveSource(importPath: string): string {
  const candidates = [path.resolve(ROOT, "contracts", importPath), path.resolve(ROOT, importPath), path.resolve(ROOT, "node_modules", importPath)];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error(`source not found: ${importPath}`);
  return found;
}

/**
 * Solc standard JSON input with every `contracts/*.sol` source and each transitive import inlined
 * under the same unit names solc saw at compile time (`contracts/X.sol`, `@openzeppelin/...`).
 *
 * @returns The standard JSON input object.
 */
export function standardInput(): { language: "Solidity"; sources: Record<string, { content: string }>; settings: typeof COMPILER_SETTINGS } {
  const sources: Record<string, { content: string }> = {};
  const add = (unit: string, file: string): void => {
    if (sources[unit] !== undefined) return;
    const content = readFileSync(file, "utf8");
    sources[unit] = { content };
    for (const match of content.matchAll(/import\s+(?:[^;]*?from\s+)?["']([^"']+)["']\s*;/gu)) {
      const imported = match[1]!;
      if (imported.startsWith(".")) {
        const next = path.posix.normalize(path.posix.join(path.posix.dirname(unit), imported));
        add(next, resolveSource(next.startsWith("contracts/") ? next.slice("contracts/".length) : next));
      } else {
        add(imported, resolveSource(imported));
      }
    }
  };
  const dir = path.join(ROOT, "contracts");
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".sol")).sort()) add(`contracts/${name}`, path.join(dir, name));
  return { language: "Solidity", sources, settings: COMPILER_SETTINGS };
}

/**
 * ABI-encode constructor arguments for a local artifact (hex without 0x, as Etherscan expects).
 *
 * @param contractName Local artifact name.
 * @param args Constructor arguments in ABI order.
 * @returns Hex string without the 0x prefix ("" for no-argument constructors).
 */
export function constructorArguments(contractName: string, args: readonly unknown[]): string {
  const artifact = loadLocalArtifact(contractName);
  const constructor = artifact.abi.find((item) => item.type === "constructor") as { inputs?: readonly { type: string; name: string; components?: unknown }[] } | undefined;
  const inputs = constructor?.inputs ?? [];
  if (inputs.length !== args.length) throw new Error(`${contractName}: constructor takes ${inputs.length} arguments, ${args.length} given`);
  if (inputs.length === 0) return "";
  return encodeAbiParameters(inputs as never, args as never).slice(2);
}

export interface VerificationRecord {
  name: string;
  contractName: string;
  address: Address;
  constructorArguments: string;
  compiler: string;
  txHash: Hex;
}

/**
 * Write `standard-input.json` and `constructor-arguments.json` for a deployment.
 *
 * @param dir Output directory (e.g. deployments/verification-base-sepolia).
 * @param records One row per local contract to verify.
 * @returns The number of source units written.
 */
export function writeVerificationInputs(dir: string, records: VerificationRecord[]): number {
  mkdirSync(dir, { recursive: true });
  const input = standardInput();
  writeFileSync(path.join(dir, "standard-input.json"), `${JSON.stringify(input, null, 2)}\n`);
  writeFileSync(path.join(dir, "constructor-arguments.json"), `${JSON.stringify(records, null, 2)}\n`);
  return Object.keys(input.sources).length;
}
