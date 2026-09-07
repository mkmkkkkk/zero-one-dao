/** Run DESIGN.md §11 scenarios A-J sequentially (one anvil at a time) and summarize. */
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

const SCENARIOS: Array<[string, () => Promise<void>]> = [["A", A], ["B", B], ["C", C], ["D", D], ["E", E], ["F", F], ["G", G], ["H", H], ["I", I], ["J", J]];

async function main(): Promise<void> {
  const results: Array<[string, boolean, string]> = [];
  for (const [name, run] of SCENARIOS) {
    try {
      await run();
      results.push([name, true, ""]);
    } catch (error) {
      results.push([name, false, error instanceof Error ? error.message : String(error)]);
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
