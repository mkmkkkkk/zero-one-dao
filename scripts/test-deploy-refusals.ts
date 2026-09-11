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
 * A seventh gate, the deployer funding requirement, is not a constant any more and so cannot be checked
 * by one case: it is `max(measured deployment gas x the live base fee x 5, 0.02 ETH)` read from the
 * chain at the moment of the check (decision.md 2026-09-10). Four runs on the fork move only the base
 * fee and the deployer's balance and assert the exact message each produces.
 *
 * The confirmation test runs against a recording loopback HTTP endpoint that answers 500, proving the
 * refusal happens before any RPC request and before any key material is read. Every gate that needs a
 * chain uses one owned loopback Anvil fork of Base; nothing is ever sent to a public network, and no
 * refusal is allowed to leave a record behind.
 *
 * Receipts: evidence/phase5/base-fork/deploy-refusals.log (the whole transcript) and
 * evidence/phase5/deployer-gate/{requirement-table.json, gate-cases.log} (the funding gate).
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
import { fmtEth, fmtGwei } from "../src/live.js";
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
  // The "other commit" has to be one the genesis commit is not: when HEAD is itself published,
  // `pushedAncestor` IS HEAD and a URL pinning HEAD would agree with the genesis commit, so this case
  // would pass vacuously. Pin HEAD's parent instead (the check fires before the URL is ever fetched).
  const otherCommit = history.find((sha) => sha !== pushedAncestor);
  if (otherCommit === undefined) throw new Error("BLOCKED: HEAD has no ancestor to pin a deliberately wrong constitution URL to");
  refused(
    await invoke([...forkArgs, "--fork-genesis-commit", pushedAncestor, "--constitution-url", `https://raw.githubusercontent.com/mkmkkkkk/zero-one-dao/${otherCommit}/docs/CONSTITUTION.md`]),
    /REFUSED: constitution URL must pin the pushed genesis SHA/u,
    `a constitution URL pinning another commit (${otherCommit}) refuses the deployment`,
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


  // ---- the deployer funding gate: computed from the chain it is about to deploy to, not a constant.
  //
  // The rule (decision.md 2026-09-10) is max(measured deployment gas x live base fee x 5, 0.02 ETH).
  // It is re-derived here from the committed measurement, deliberately as a second implementation of
  // the production arithmetic in src/deployerGate.ts, exactly like `predictedSafe` above: if production
  // ever changes the factor, the floor, or the file it reads its gas from, these numbers stop matching
  // its messages instead of quietly agreeing with them.
  //
  // Four runs on the same owned fork, with the predicted Safe already poisoned above so that no run can
  // deploy anything even when the gate lets it through: the gate PASSES a funded deployer at a realistic
  // Base fee, REFUSES that same deployer with the same balance once the base fee is high, REFUSES a
  // deployer holding one wei less than the computed requirement, and PASSES it at exactly the
  // requirement - which is what makes "one wei under" mean anything.
  const measurement = JSON.parse(readFileSync(path.join(ROOT, "evidence", "phase5", "base-fork", "measurements.json"), "utf8")) as { deployment: { totalGas: string; transactions: number } };
  const measuredGas = BigInt(measurement.deployment.totalGas);
  const FACTOR = 5n;
  const FLOOR = 20_000_000_000_000_000n;
  const computedAt = (baseFeeWei: bigint): bigint => measuredGas * baseFeeWei * FACTOR;
  const requiredAt = (baseFeeWei: bigint): bigint => (computedAt(baseFeeWei) > FLOOR ? computedAt(baseFeeWei) : FLOOR);
  const gwei = (value: string): bigint => BigInt(Math.round(Number(value) * 1e9));

  const rpc = chain.publicClient.request as (args: { method: string; params: unknown[] }) => Promise<unknown>;
  /** Put an exact base fee on the fork's latest block and return that block's number. */
  const setBaseFee = async (wei: bigint): Promise<bigint> => {
    await rpc({ method: "anvil_setNextBlockBaseFeePerGas", params: [`0x${wei.toString(16)}`] });
    await rpc({ method: "anvil_mine", params: [] });
    const block = await chain.publicClient.getBlock({ blockTag: "latest" });
    assert.equal(block.baseFeePerGas, wei, "the fork's latest block carries exactly the base fee this case asks for");
    return block.number;
  };
  /** Set the deployer's ETH balance on the fork and confirm the chain agrees. */
  const setBalance = async (wei: bigint): Promise<void> => {
    await rpc({ method: "anvil_setBalance", params: [deployer, `0x${wei.toString(16)}`] });
    assert.equal(await chain.publicClient.getBalance({ address: deployer }), wei, "the deployer holds exactly what this case funds it with");
  };

  const gateDir = path.join(ROOT, "evidence", "phase5", "deployer-gate");
  mkdirSync(gateDir, { recursive: true });
  const gateCases: { case: string; verdict: "pass" | "refuse"; baseFeeGwei: string; holdsEth: string; requiredEth: string; computedEth: string; governedBy: "floor" | "computed"; message: string }[] = [];
  /**
   * Run the deployment once at a chosen base fee and deployer balance and check the gate's message.
   *
   * The gate is the only thing under test, so a run is always allowed to continue into the
   * already-poisoned predicted-Safe refusal: a case that "passes" is one whose ASSERT line appears and
   * whose run still refuses one gate later, having written no record.
   *
   * Args:
   *     label: What this case proves.
   *     baseFeeWei: Base fee to put on the fork before the run.
   *     holds: ETH the deployer is given before the run.
   *     verdict: Whether the funding gate must pass or refuse.
   */
  const gateCase = async (label: string, baseFeeWei: bigint, holds: bigint, verdict: "pass" | "refuse"): Promise<void> => {
    const blockNumber = await setBaseFee(baseFeeWei);
    await setBalance(holds);
    const required = requiredAt(baseFeeWei);
    const run = await invoke([...forkArgs, "--fork-genesis-commit", pushedAncestor]);
    // The three numbers every message owes: what is required, the live base fee it was required at,
    // and what the deployer actually holds.
    const numbers = `${fmtEth(required)} ETH: ${measuredGas} gas (measured over ${measurement.deployment.transactions} transactions, evidence/phase5/base-fork/measurements.json) x ${fmtGwei(baseFeeWei)} gwei live base fee (latest block ${blockNumber}) x ${FACTOR} = ${fmtEth(computedAt(baseFeeWei))} ETH, floor ${fmtEth(FLOOR)} ETH${required === FLOOR ? " governs" : ""}`;
    const message = verdict === "pass"
      ? `ASSERT deployer ${deployer} holds ${fmtEth(holds)} ETH, at or above the ${numbers}`
      : `REFUSED: deployer ${deployer} holds ${fmtEth(holds)} ETH, below the ${numbers}`;
    assert.ok(run.output.includes(message), `${label}: the gate must state the requirement, the live base fee and the holding.\nexpected to contain:\n${message}`);
    assert.notEqual(run.code, 0, `${label}: no case may reach a deployment`);
    if (verdict === "pass") assert.ok(run.output.includes(`REFUSED: predicted Safe ${safe} already holds`), `${label}: the funding gate let the run through to the next gate`);
    assert.equal(existsSync(NEVER), false, `${label}: a refusal must not write a deployment record`);
    gateCases.push({ case: label, verdict, baseFeeGwei: fmtGwei(baseFeeWei), holdsEth: fmtEth(holds), requiredEth: fmtEth(required), computedEth: fmtEth(computedAt(baseFeeWei)), governedBy: required === FLOOR ? "floor" : "computed", message });
    console.log(`ASSERT ${label}\n   ${message}\n`);
  };

  await gateCase("the gate passes a funded deployer at a realistic Base base fee (0.05 gwei; the 0.02 ETH floor governs)", gwei("0.05"), 30_000_000_000_000_000n, "pass");
  await gateCase("the same deployer with the same balance is refused once the base fee is high (0.5 gwei)", gwei("0.5"), 30_000_000_000_000_000n, "refuse");
  await gateCase("a deployer one wei under the computed requirement is refused (0.5 gwei)", gwei("0.5"), requiredAt(gwei("0.5")) - 1n, "refuse");
  await gateCase("the same deployer at exactly the computed requirement passes (0.5 gwei)", gwei("0.5"), requiredAt(gwei("0.5")), "pass");
  assert.equal(gateCases[0]!.holdsEth, gateCases[1]!.holdsEth, "the first two cases differ in nothing but the live base fee");
  assert.notEqual(gateCases[0]!.requiredEth, gateCases[1]!.requiredEth, "the requirement moved with the fee, which is the whole point of replacing the constant");
  assert.equal(gateCases[2]!.requiredEth, gateCases[3]!.requiredEth, "one wei under and exactly at the requirement are the same requirement");

  // What the rule answers at the three fee points docs/MAINNET_PLAN.md budgets against, computed here
  // and cross-checked against the requirement the live gate just produced at the same fee.
  const table = [gwei("0.006"), gwei("0.05"), gwei("0.5")].map((baseFeeWei) => ({
    baseFeeGwei: fmtGwei(baseFeeWei),
    computedEth: fmtEth(computedAt(baseFeeWei)),
    requiredEth: fmtEth(requiredAt(baseFeeWei)),
    governedBy: requiredAt(baseFeeWei) === FLOOR ? "floor" : "computed",
  }));
  for (const row of table) {
    const live = gateCases.find((observed) => observed.baseFeeGwei === row.baseFeeGwei);
    if (live) assert.equal(live.requiredEth, row.requiredEth, `the table's ${row.baseFeeGwei} gwei row is the number the live gate produced on chain`);
  }
  writeFileSync(path.join(gateDir, "requirement-table.json"), `${JSON.stringify({
    rule: "required = max(measured deployment gas x live base fee x 5, 0.02 ETH floor)",
    ruling: "decision.md 2026-09-10, phase 5 Base fork rehearsal review",
    implementation: "src/deployerGate.ts, called by scripts/deploy-network.ts before any write",
    measurement: { file: "evidence/phase5/base-fork/measurements.json", totalGas: measurement.deployment.totalGas, transactions: measurement.deployment.transactions },
    factor: Number(FACTOR),
    floorEth: fmtEth(FLOOR),
    table,
    liveCases: gateCases,
    producedBy: "npm run test:deploy-refusals",
    producedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  writeFileSync(path.join(gateDir, "gate-cases.log"), `${gateCases.map((row) => `${row.verdict.toUpperCase().padEnd(6)} ${row.case}\n       ${row.message}`).join("\n")}\n`);
  console.log(`deployer-gate receipts: ${path.relative(ROOT, gateDir)}/{requirement-table.json,gate-cases.log}\n`);

  console.log("ASSERT all five deployment refusals, the predicted-Safe balance gate and the computed deployer funding gate still fire; no record was written and no public-network transaction was sent");
} finally {
  if (devnet) await stopDevnet(devnet);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
