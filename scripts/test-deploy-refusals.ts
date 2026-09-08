/** Refusal tests use a recording loopback endpoint, with no chain or key material. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chooseFreePort } from "../src/devnet.js";
let requests = 0;
const server = createServer((_req, res) => { requests++; res.writeHead(500).end(); });
const port = chooseFreePort(18680);
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
async function invoke(args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/deploy-base.ts", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += data.toString(); });
  child.stderr.on("data", (data) => { output += data.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  console.log(output.trim());
  return { code, output };
}
try {
  const help = await invoke(["--help"]);
  assert.equal(help.code, 0);
  for (const line of ["1. HEAD", "2. Constitution", "3. Deployer", "4. CREATE2", "5. --i-confirmed-parameters"]) assert.ok(help.output.includes(line));
  const refusal = await invoke(["--rpc", `http://127.0.0.1:${port}`, "--key-file", "/does-not-exist/never-read"]);
  assert.notEqual(refusal.code, 0);
  assert.match(refusal.output, /--i-confirmed-parameters is required/);
  assert.equal(requests, 0);
  console.log("ASSERT missing confirmation exits nonzero before key read; RPC requests=0 writes=0");
  const publicFork = await invoke(["--i-confirmed-parameters", "--fork", "--rpc", "https://mainnet.base.org"]);
  assert.notEqual(publicFork.code, 0);
  assert.match(publicFork.output, /fork writes require loopback HTTP Anvil/);
  console.log("ASSERT fork mode rejects public RPC before any request");
} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
