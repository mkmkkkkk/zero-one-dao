/** Run A-L on Sepolia; local mode includes K only with FORK_RPC. One scenario at a time. */
import { main as A } from "./A-full-treasury-fails.js";
import { main as B } from "./B-mandate-ragequit-then-execute.js";
import { main as C } from "./C-deposit-spend-ragequit.js";
import { main as D } from "./D-governance-param-change.js";
import { main as E } from "./E-task-verifier-not-proposer.js";
import { main as F } from "./F-founder-ordinary-member.js";
import { main as G } from "./G-strategy-contract.js";
import { main as H } from "./H-project-tranches.js";
import { main as I } from "./I-project-topup-stop.js";
import { main as J } from "./J-strategy-migrate.js";
import { main as L } from "./L-treasury-ledger.js";
import { main as K } from "./K-uniswap-v3-fork.js";
import { main as KSepolia } from "./K-uniswap-v3-sepolia.js";
import { LIVE } from "./lib.js";

const SCENARIOS: Array<[string, () => Promise<void>]> = [["A", A], ["B", B], ["C", C], ["D", D], ["E", E], ["F", F], ["G", G], ["H", H], ["I", I], ["J", J], ["L", L]];

async function main(): Promise<void> {
  if (LIVE) SCENARIOS.splice(10, 0, ["K", KSepolia]);
  else if (process.env.FORK_RPC) SCENARIOS.splice(10, 0, ["K", K]);
  const only = process.argv.find(arg => arg.startsWith("--only="))?.slice(7).split(",");
  if (only?.some(name => !SCENARIOS.some(([id]) => id === name))) throw new Error("--only must name available scenarios");
  const results: Array<[string, boolean, string]> = [];
  for (const [name, run] of SCENARIOS) {
    if (only && !only.includes(name)) continue;
    try {
      await run();
      results.push([name, true, ""]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`scenario ${name} failed: ${message}`);
      results.push([name, false, message]);
    }
  }
  console.log("\n===== SUMMARY =====");
  for (const [name, ok, message] of results) console.log(`${name}: ${ok ? "PASS" : `FAIL ${message}`}`);
  if (results.some(([, ok]) => !ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
