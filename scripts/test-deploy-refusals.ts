/**
 * Every refusal the Base deployment entry point owes, checked against the phase 5 code.
 *
 * Five preconditions must each still abort a Base run: HEAD not pushed to the public origin, a dirty
 * working tree, a constitution URL that does not pin the genesis SHA, a missing
 * `--i-confirmed-parameters`, and an output path that already holds a deployment record. A sixth gate,
 * the CREATE2-predicted Safe holding no settlement, is checked positively (the rehearsal's own
 * `ASSERT ... USDC=0 before deployment` line) and negatively here: one USDC is moved to the predicted
 * address on an owned fork and the deployment refuses to start.
 *
 * The confirmation test runs against a recording loopback HTTP endpoint that answers 500, proving the
 * refusal happens before any RPC request and before any key material is read. The three gates that need
 * a chain use one owned loopback Anvil fork of Base; nothing is ever sent to a public network, and no
 * refusal is allowed to leave a record behind.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { format } from "node:util";
import { fileURLToPath } from "node:url";

import { concatHex, encodeAbiParameters, getContractAddress, keccak256, type Address } from "viem";

import { loadBaalArtifact } from "../src/baal.js";
import { fundForkUsdc, startBaseFork } from "../src/baseFork.js";
import { chooseFreePort, stopDevnet, type Devnet } from "../src/devnet.js";
import { connectDevnet } from "../src/onchain.js";
import { DEFAULT_PARAMS, GENESIS_DEPOSIT, proxySaltNonce, SETTLEMENT_UNIT } from "../src/zeroOne.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "evidence", "phase5", "base-fork");
mkdirSync(DIR, { recursive: true });
const LOG = path.join(DIR, "deploy-refusals.log");
writeFileSync(LOG, "");
const originalLog = console.log;
console.log = (...args: unknown[]) => { appendFileSync(LOG, format(...args) + "\n"); originalLog(...args); };

const git = (...args: string[]): string => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
/** Path no refusal may ever create; asserted absent after every fork-mode refusal. */
const NEVER = path.join(DIR, "refusal-must-not-write-this.json");

/** Run scripts/deploy-base.ts in a child process and capture its exit code and merged output. */
async function invoke(args: string[]): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/deploy-base.ts", ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  console.log(`$ deploy-base.ts ${args.join(" ")}\n${output.trim()}`);
  return { code, output };
}

/** Assert a run refused, matched the expected message, and wrote no record. */
function refused(result: { code: number | null; output: string }, pattern: RegExp, note: string): void {
  assert.notEqual(result.code, 0, `${note}: expected a non-zero exit`);
  assert.match(result.output, pattern, note);
  assert.equal(existsSync(NEVER), false, `${note}: a refusal must not write a deployment record`);
  console.log(`ASSERT ${note}\n`);
}

/**
 * The Safe address `deployNetwork` predicts for a deployer, recomputed from the same inputs.
 *
 * Deliberately a second implementation of the production math (pending nonce + 2 for the Safe
 * singleton, + 3 for the proxy factory, the factory's `keccak256(keccak256("") . saltNonce)` salt and
 * the deployer-bound `proxySaltNonce`): if the two ever diverge, the USDC below lands somewhere else
 * and the refusal this test expects does not fire.
 *
 * Args:
 *   publicClient: Client of the owned fork.
 *   deployer: The deploying EOA.
 *
 * Returns:
 *   The CREATE2 address the next deployment would create the Safe at.
 */
async function predictedSafe(publicClient: ReturnType<typeof connectDevnet>["publicClient"], deployer: Address): Promise<Address> {
  const nonce = BigInt(await publicClient.getTransactionCount({ address: deployer, blockTag: "pending" }));
  const singleton = getContractAddress({ from: deployer, nonce: nonce + 2n });
  const factory = getContractAddress({ from: deployer, nonce: nonce + 3n });
  const bytecode = concatHex([loadBaalArtifact("GnosisSafeProxy").bytecode, encodeAbiParameters([{ type: "uint256" }], [BigInt(singleton)])]);
  const salt = keccak256(concatHex([keccak256("0x"), encodeAbiParameters([{ type: "uint256" }], [proxySaltNonce(deployer, DEFAULT_PARAMS.salt, 0)])]));
  return getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecode });
}

const head = git("rev-parse", "HEAD");
const advertised = new Set(git("ls-remote", "origin").split("\n").map((line) => line.split("\t")[0]?.trim()).filter((sha): sha is string => /^[0-9a-f]{40}$/u.test(sha ?? "")));
const history = git("rev-list", "--max-count=500", "HEAD").split("\n");
const pushedAncestor = history.find((sha) => advertised.has(sha));
if (pushedAncestor === undefined) throw new Error("BLOCKED: no commit in HEAD's history is advertised by origin; the constitution gates cannot be exercised");
console.log(`local HEAD ${head} ${advertised.has(head) ? "is" : "is NOT"} advertised by origin; newest pushed ancestor ${pushedAncestor}\n`);

let requests = 0;
const server = createServer((_request, response) => { requests += 1; response.writeHead(500).end(); });
const port = chooseFreePort(18680);
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
let devnet: Devnet | undefined;
try {
  const help = await invoke(["--help"]);
  assert.equal(help.code, 0);
  for (const line of ["1. HEAD", "2. Constitution", "3. Deployer", "4. CREATE2", "5. --i-confirmed-parameters"]) assert.ok(help.output.includes(line), `--help lists "${line}"`);
  console.log("ASSERT --help still lists all five preconditions\n");

  // ---- refusal 4: no confirmation. Checked before a key is read and before any RPC request.
  refused(
    await invoke(["--rpc", `http://127.0.0.1:${port}`, "--key-file", "/does-not-exist/never-read"]),
    /REFUSED: --i-confirmed-parameters is required/u,
    "missing --i-confirmed-parameters refuses before key access",
  );
  assert.equal(requests, 0);
  console.log(`ASSERT the recording endpoint on 127.0.0.1:${port} saw ${requests} requests: no RPC call, no write\n`);

  // ---- refusal 5: an output path that already holds a deployment record.
  const existing = path.join(ROOT, "deployments", "base-sepolia.json");
  assert.ok(existsSync(existing), "the Sepolia record exists and stands in for an already-deployed Base record");
  refused(
    await invoke(["--i-confirmed-parameters", "--out", "deployments/base-sepolia.json", "--rpc", `http://127.0.0.1:${port}`]),
    /REFUSED: .*base-sepolia\.json exists: a deployment is already recorded/u,
    "an existing deployment record refuses a redeploy",
  );
  assert.equal(readFileSync(existing, "utf8").length > 0, true, "the existing record is untouched");

  // ---- refusal 2: a dirty working tree. The test creates the dirt and restores the exact bytes.
  const dirtyBefore = git("status", "--porcelain", "--untracked-files=no");
  const marker = path.join(ROOT, "README.md");
  const pristine = readFileSync(marker);
  let dirtyRun: { code: number | null; output: string };
  try {
    writeFileSync(marker, `${pristine.toString()}\n<!-- deploy-refusal test: working tree deliberately dirty -->\n`);
    assert.notEqual(git("status", "--porcelain", "--untracked-files=no"), dirtyBefore, "the tree is dirty for the duration of this test");
    dirtyRun = await invoke(["--i-confirmed-parameters", "--rpc", `http://127.0.0.1:${port}`]);
  } finally {
    writeFileSync(marker, pristine);
  }
  assert.equal(git("status", "--porcelain", "--untracked-files=no"), dirtyBefore, "the working tree is restored byte for byte");
  refused(dirtyRun, /REFUSED: production deployment requires a clean working tree at pushed HEAD/u, "a dirty working tree refuses a public deployment");

  // ---- the three gates that need a chain: one owned loopback Base fork, no public fallback.
  devnet = await startBaseFork(`phase5-refusals-${Date.now()}`);
  const chain = connectDevnet(devnet);
  const deployer = chain.contexts[0]!.account.address;
  const keyFile = path.join(devnet.stateDir, "deployer.env");
  writeFileSync(keyFile, `ANCHOR_PRIVATE_KEY=${devnet.privateKeys[0]}\n`, { mode: 0o600 });
  const forkArgs = ["--i-confirmed-parameters", "--fork", "--rpc", devnet.rpcUrl, "--key-file", keyFile, "--out", path.relative(ROOT, NEVER)];

  // A public RPC is refused in fork mode before a single request leaves the process.
  refused(
    await invoke(["--i-confirmed-parameters", "--fork", "--rpc", "https://mainnet.base.org"]),
    /fork writes require loopback HTTP Anvil/u,
    "fork mode rejects a public RPC before any request",
  );

  // ---- refusal 1: the genesis commit is not an origin ref. The fork path has no bypass.
  if (advertised.has(head)) {
    refused(
      await invoke([...forkArgs, "--fork-genesis-commit", "0".repeat(40)]),
      /REFUSED: --fork-genesis-commit 0{40} is not an ancestor of HEAD/u,
      "HEAD is published, so the unpublished-commit gate is shown through --fork-genesis-commit",
    );
  } else {
    refused(await invoke(forkArgs), new RegExp(`REFUSED: genesis commit ${head} is not pushed as an origin ref`, "u"), "an unpushed HEAD refuses even a fork rehearsal");
  }

  // ---- refusal 3: the constitution URL must pin the genesis commit, not any other commit.
  refused(
    await invoke([...forkArgs, "--fork-genesis-commit", pushedAncestor, "--constitution-url", `https://raw.githubusercontent.com/mkmkkkkk/zero-one-dao/${head}/docs/CONSTITUTION.md`]),
    /REFUSED: constitution URL must pin the pushed genesis SHA/u,
    "a constitution URL pinning another commit refuses the deployment",
  );

  // ---- the CREATE2-predicted Safe must hold no settlement.
  await fundForkUsdc(devnet, deployer, GENESIS_DEPOSIT);
  const safe = await predictedSafe(chain.publicClient, deployer);
  await fundForkUsdc(devnet, safe, SETTLEMENT_UNIT);
  console.log(`the predicted Safe ${safe} was given ${SETTLEMENT_UNIT} USDC before the run\n`);
  refused(
    await invoke([...forkArgs, "--fork-genesis-commit", pushedAncestor]),
    new RegExp(`REFUSED: predicted Safe ${safe} already holds ${SETTLEMENT_UNIT} USDC`, "u"),
    "a predicted Safe holding USDC refuses the deployment (the positive case is the rehearsal's USDC=0 assertion)",
  );

  console.log("ASSERT all five deployment refusals plus the predicted-Safe balance gate still fire; no record was written and no public-network transaction was sent");
} finally {
  if (devnet) await stopDevnet(devnet);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
