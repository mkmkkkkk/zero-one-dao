/**
 * Component 6, row OPS-08: deployment-script refusal bypass (scripts/deploy-network.ts). Runs the
 * mainnet entry point against a recording loopback RPC with no key material, like
 * scripts/test-deploy-refusals.ts, and records which gates are path-, flag- or environment-dependent:
 * (1) the "record exists" gate keys on --out; (2) the clean-tree gate ignores untracked files and
 * git-ignored artifacts, and no gate hashes the compiled bytecode the script deploys; (3) the
 * pushed-HEAD gate accepts any advertised ref (refs/heads/*, refs/pull/*); (4) --i-confirmed-parameters
 * is a flag, not a signature. Expected: every observation confirmed with the script's own output;
 * RPC writes = 0 in every run.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import { chooseFreePort } from "../../../src/devnet.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
let requests = 0;

/** Run scripts/deploy-base.ts with `args`; return exit code and combined output. */
async function invoke(args: string[]): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/deploy-base.ts", ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += data.toString(); });
  child.stderr.on("data", (data) => { output += data.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  const line = output.split("\n").find((candidate) => /REFUSED|Error:|exists|must|required/u.test(candidate)) ?? output.trim().split("\n").at(-1) ?? "";
  console.log(`   deploy-base ${args.join(" ")} -> exit ${code}: ${line.trim().slice(0, 200)}`);
  return { code, output };
}

/** Hard assertion printing the check. */
function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`   ok: ${message}`);
}

const server = createServer((_req, res) => { requests++; res.writeHead(500).end(); });
const port = chooseFreePort(18690);
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
const rpc = `http://127.0.0.1:${port}`;
const scratch = path.join(ROOT, "state", `audit-ops08-${Date.now()}`);
mkdirSync(scratch, { recursive: true, mode: 0o700 });
try {
  console.log("\n== (1) the 'deployment already recorded' gate keys on --out");
  const existing = path.join(scratch, "base.json");
  writeFileSync(existing, "{}\n");
  const a = await invoke(["--i-confirmed-parameters", "--rpc", rpc, "--key-file", "/does-not-exist", "--out", existing]);
  ok(a.code !== 0 && /exists: a deployment is already recorded/u.test(a.output), "with --out pointing at an existing file the script refuses");
  const b = await invoke(["--i-confirmed-parameters", "--rpc", rpc, "--key-file", "/does-not-exist", "--out", path.join(scratch, "elsewhere.json")]);
  ok(b.code !== 0 && !/already recorded/u.test(b.output), "with --out elsewhere the same operator passes that gate and reaches the next one (a second mainnet deployment is one flag away)");

  console.log("\n== (2) clean-tree gate vs what is actually deployed");
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" }).trim();
  const untracked = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter((line) => line.startsWith("??")).length;
  console.log(`   git status --porcelain --untracked-files=no -> ${status === "" ? "clean" : `${status.split("\n").length} dirty entries`}; untracked files ignored by that check: ${untracked}`);
  const ignored = execFileSync("git", ["check-ignore", "-v", "contracts/artifacts/DepositShaman.json"], { cwd: ROOT, encoding: "utf8" }).trim();
  ok(ignored.includes("contracts/artifacts/"), `compiled artifacts are git-ignored (${ignored}): a modified or stale artifact never makes the tree dirty`);
  const source = readFileSync(path.join(ROOT, "scripts", "deploy-network.ts"), "utf8");
  const bytecodeChecks = (source.match(/deployedBytecode|keccak256\((code|bytecode)/gu) ?? []).length;
  ok(bytecodeChecks === 0, `deploy-network.ts compares deployed bytecode against source/artifacts in ${bytecodeChecks} places: the pushed-HEAD gate binds the constitution URL, not the code that ships`);

  console.log("\n== (3) pushed-HEAD gate: any advertised ref counts");
  const refCheck = /row\.startsWith\(`\$\{genesisCommit\} refs\/`\)/u.test(source);
  ok(refCheck, "the advertisement scan accepts `<sha> refs/` with any suffix (refs/heads/*, refs/tags/*, refs/pull/*/head): a commit pushed to any branch or opened as a PR passes");
  const c = await invoke(["--i-confirmed-parameters", "--rpc", rpc, "--key-file", "/does-not-exist", "--out", path.join(scratch, "unpushed.json")]);
  ok(c.code !== 0 && /not pushed|clean working tree|advertisement|curl/u.test(c.output), "this audit branch (HEAD not on origin) is refused before any key or RPC read");

  console.log("\n== (4) confirmation flag and RPC writes");
  const d = await invoke(["--rpc", rpc, "--key-file", "/does-not-exist"]);
  ok(d.code !== 0 && /--i-confirmed-parameters is required/u.test(d.output), "without the flag: refused; the flag is a CLI token, not a signed confirmation (anyone with the key file can pass it)");
  ok(requests === 0, `RPC requests made by every run above: ${requests} (0 writes)`);
  console.log("\n=== OPS-08 deploy-refusals: PASS (observations recorded) ===");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
