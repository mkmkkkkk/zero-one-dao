/**
 * Compile evidence/audit/governance-nav/contracts/AuditMulticall.sol with the repo's solc-js into
 * evidence/audit/governance-nav/artifacts/AuditMulticall.json (abi + bytecode). Test-only helper;
 * nothing under contracts/ is touched.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Compile the helper and write its artifact.
 *
 * Returns:
 *   The absolute path of the written artifact.
 *
 * Raises:
 *   Error: when solc reports any error-severity diagnostic.
 */
export function compileHelper(): string {
  const source = readFileSync(path.join(HERE, "contracts", "AuditMulticall.sol"), "utf8");
  const input = {
    language: "Solidity",
    sources: { "AuditMulticall.sol": { content: source } },
    settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as { errors?: Array<{ severity: string; formattedMessage: string }>; contracts: Record<string, Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>> };
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const contract = output.contracts["AuditMulticall.sol"]!["AuditMulticall"]!;
  const artifactDir = path.join(HERE, "artifacts");
  mkdirSync(artifactDir, { recursive: true });
  const file = path.join(artifactDir, "AuditMulticall.json");
  writeFileSync(file, JSON.stringify({ contractName: "AuditMulticall", abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` }, null, 2));
  return file;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`compiled -> ${compileHelper()}`);
}
