/** Compile zero-one-dao/contracts with solc-npm, resolving local and npm Solidity imports. */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS_DIR = path.join(ROOT, "contracts");

interface SolcDiagnostic {
  severity: "error" | "warning" | string;
  formattedMessage?: string;
  message: string;
}

interface SolcContract {
  abi: unknown[];
  evm: {
    bytecode: { object: string; linkReferences: unknown };
    deployedBytecode: { object: string; linkReferences: unknown };
  };
}

function solidityFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const entry = path.join(directory, name);
    const stat = statSync(entry);
    if (stat.isDirectory() && name !== "artifacts") files.push(...solidityFiles(entry));
    else if (stat.isFile() && entry.endsWith(".sol")) files.push(entry);
  }
  return files;
}

function resolveImport(importPath: string): { contents: string } | { error: string } {
  const candidates = [
    path.resolve(CONTRACTS_DIR, importPath),
    path.resolve(ROOT, importPath),
    path.resolve(ROOT, "node_modules", importPath),
    path.resolve(ROOT, "..", "node_modules", importPath),
  ];
  for (const candidate of candidates) {
    try {
      return { contents: readFileSync(candidate, "utf8") };
    } catch {
      // Try the next explicit search root.
    }
  }
  return { error: `Import not found: ${importPath}\nSearched:\n${candidates.join("\n")}` };
}

function main(): void {
  const sources: Record<string, { content: string }> = {};
  for (const file of solidityFiles(CONTRACTS_DIR)) {
    const sourceName = path.relative(ROOT, file).split(path.sep).join("/");
    sources[sourceName] = { content: readFileSync(file, "utf8") };
  }
  if (Object.keys(sources).length === 0) {
    throw new Error(`No Solidity files found under ${CONTRACTS_DIR}`);
  }

  const input = {
    language: "Solidity",
    sources,
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: {
        "*": {
          "*": [
            "abi",
            "evm.bytecode.object",
            "evm.bytecode.linkReferences",
            "evm.deployedBytecode.object",
            "evm.deployedBytecode.linkReferences",
          ],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport })) as {
    errors?: SolcDiagnostic[];
    contracts?: Record<string, Record<string, SolcContract>>;
  };
  for (const diagnostic of output.errors ?? []) {
    const line = diagnostic.formattedMessage ?? diagnostic.message;
    if (diagnostic.severity === "error") console.error(line);
    else console.warn(line);
  }
  const errors = (output.errors ?? []).filter(({ severity }) => severity === "error");
  if (errors.length !== 0) throw new Error(`solc reported ${errors.length} error(s)`);

  const artifactsDir = path.join(CONTRACTS_DIR, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  let written = 0;
  for (const [sourcePath, contracts] of Object.entries(output.contracts ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    // Dependency artifacts are intentionally omitted; only this prototype's contracts are evidence.
    if (!sourcePath.startsWith("contracts/")) continue;
    for (const [contractName, contract] of Object.entries(contracts).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const artifact = {
        contractName,
        sourcePath,
        compiler: solc.version(),
        abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}`,
        deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
        linkReferences: contract.evm.bytecode.linkReferences,
        deployedLinkReferences: contract.evm.deployedBytecode.linkReferences,
      };
      writeFileSync(
        path.join(artifactsDir, `${contractName}.json`),
        `${JSON.stringify(artifact, null, 2)}\n`,
      );
      console.log(`${contractName}: runtime ${contract.evm.deployedBytecode.object.length / 2} bytes`);
      written += 1;
    }
  }
  if (written === 0) throw new Error("solc succeeded but emitted no local artifacts");
  console.log(`Wrote ${written} local artifacts with ${solc.version()}`);
}

main();
