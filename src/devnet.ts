import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 11_545;
const DEFAULT_CHAIN_ID = 31_401;

export interface Devnet {
  port: number;
  rpcUrl: string;
  chainId: number;
  addresses: Address[];
  privateKeys: Hex[];
  process: ChildProcess;
  stateDir: string;
  configPath: string;
}

function listenerExists(port: number): boolean {
  try {
    execFileSync("lsof", [`-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Follow the repository lock rule: advance while lsof sees an existing listener. */
export function chooseFreePort(start = DEFAULT_PORT): number {
  if (!Number.isSafeInteger(start) || start < 1 || start > 65_535) {
    throw new RangeError("Starting port must be an integer from 1 through 65535");
  }
  let port = start;
  while (listenerExists(port)) {
    port += 1;
    if (port > 65_535) throw new Error("No free TCP port remained in the requested range");
  }
  return port;
}

async function waitForRpc(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`zero-one devnet child stopped before RPC readiness (code ${child.exitCode})`);
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) return;
    } catch {
      // Anvil may not have bound the listener yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("zero-one devnet RPC did not become ready within 10 seconds");
}

async function waitForConfig(file: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`zero-one devnet child stopped before config readiness (code ${child.exitCode})`);
    }
    try {
      if (readFileSync(file, "utf8").length > 0) return;
    } catch {
      // Anvil writes the config after process initialization.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("anvil did not write its private config within 10 seconds");
}

/**
 * Start one owned Anvil child. Anvil generates a fresh 24-word mnemonic and
 * writes all secret material only to a mode-0600 file under mode-0700 state.
 */
export async function startDevnet(
  runId: string,
  options: { chainId?: number; hardfork?: "cancun" | "prague" } = {},
): Promise<Devnet> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(runId)) {
    throw new TypeError("runId must be a short filesystem-safe label");
  }
  const port = chooseFreePort();
  const chainId = options.chainId ?? DEFAULT_CHAIN_ID;
  if (!Number.isSafeInteger(chainId) || chainId < 1) {
    throw new RangeError("chainId must be a positive safe integer");
  }
  const stateRoot = path.join(ROOT, "state");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  chmodSync(stateRoot, 0o700);
  const stateDir = path.join(stateRoot, runId);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const configPath = path.join(stateDir, "anvil-secret.json");
  // Pre-create with exclusive mode so the secrets file is never briefly world-readable.
  writeFileSync(configPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(configPath, 0o600);
  const anvil = path.join(ROOT, "node_modules", ".bin", "anvil");
  const child = spawn(
    anvil,
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      String(chainId),
      "--accounts",
      "16",
      "--balance",
      "1000",
      "--mnemonic-random",
      "24",
      "--config-out",
      configPath,
      "--hardfork",
      options.hardfork ?? "cancun",
      "--quiet",
    ],
    { cwd: ROOT, stdio: "ignore" },
  );
  const rpcUrl = `http://127.0.0.1:${port}`;

  try {
    await Promise.all([waitForRpc(rpcUrl, child), waitForConfig(configPath, child)]);
    // Anvil controls creation; tighten it before parsing or returning the path.
    chmodSync(configPath, 0o600);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      available_accounts?: unknown;
      private_keys?: unknown;
    };
    if (
      !Array.isArray(config.available_accounts) ||
      !config.available_accounts.every((value) => typeof value === "string") ||
      !Array.isArray(config.private_keys) ||
      !config.private_keys.every((value) => typeof value === "string") ||
      config.available_accounts.length < 12 ||
      config.private_keys.length !== config.available_accounts.length
    ) {
      throw new Error("anvil secret config did not contain the requested account set");
    }
    return {
      port,
      rpcUrl,
      chainId,
      addresses: config.available_accounts.map((value) => value as Address),
      privateKeys: config.private_keys.map((value) => value as Hex),
      process: child,
      stateDir,
      configPath,
    };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

/** Stop only the exact child returned by startDevnet; never scan or kill unrelated Anvil jobs. */
export async function stopDevnet(devnet: Devnet): Promise<void> {
  if (devnet.process.exitCode !== null || devnet.process.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => devnet.process.once("exit", () => resolve()));
  devnet.process.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (devnet.process.exitCode === null && devnet.process.signalCode === null) {
    devnet.process.kill("SIGKILL");
  }
}

/** Test helper that proves a candidate port is bindable without leaving a listener behind. */
export async function canBind(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
