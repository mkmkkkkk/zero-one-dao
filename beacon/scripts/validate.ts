/**
 * Validate a built beacon: README.txt has at most 44 lines and carries the principle, the eight verbs,
 * the constitution hash and every address; every contract address in state.json has code on the
 * deployment's chain (template instances included); snippets have no unfilled placeholders; the
 * dashboard uses no gradients, emoji, purple or black. Pattern: agent-only-wallet/beacon/scripts/validate.mjs.
 * Usage: tsx beacon/scripts/validate.ts --deployment <file> [--out <dir>]
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { getAddress, isAddress } from "viem";

import { connect, json, loadDeployment, ROOT } from "../../relay/common.js";
import type { DaoState } from "../../relay/chain.js";
import { parseArgs } from "./build.js";

const VERBS = ["join", "deposit", "task", "deliver", "propose", "vote", "execute", "ragequit"];

/**
 * Run every check; throws on the first failure.
 *
 * @param options Deployment file and beacon output directory.
 * @returns A summary of the checks that passed.
 */
export async function validateBeacon(options: { deployment: string; out: string }): Promise<Record<string, unknown>> {
  const deployment = loadDeployment(options.deployment);
  const env = connect(deployment);
  const readme = readFileSync(path.join(options.out, "README.txt"), "utf8");
  const lines = readme.trimEnd().split("\n");
  assert(readme.includes("Deposits pause while an open proposal contract still holds a non-USDC asset"), "README lacks the settlement rule (phase 5 ruling 4a: open instances pause deposits, Safe dust does not)");
  assert(readme.includes("exit is pro-rata of the Safe only"), "README lacks the exit rule (ragequit is pro-rata of the Safe only)");
  assert(readme.includes("T0: the relay operator can delay or drop your intents; anything you cannot afford to lose goes through T1."), "README lacks the T0 relay-authority line (phase 5 ruling 7, A5-10)");
  assert(/128 bits of entropy/u.test(readme), "README lacks the T0 pass entropy floor (phase 5 ruling 9, A5-08)");
  assert(/\/pending\.json/u.test(readme), "README lacks /pending.json (phase 5 ruling 7)");
  assert(lines.length <= 44, `README.txt has ${lines.length} lines (max 44)`);
  assert(readme.includes("Any member can propose anything; only the other members' votes or exits can stop it."), "README lacks the principle");
  for (const verb of VERBS) assert(new RegExp(`^${verb}\\b`, "mu").test(readme), `README lacks verb ${verb}`);
  assert(readme.includes("Intent(address member,uint8 op,uint32 proposalId,uint256 amount,bytes32 evidenceHash,bytes data,string details,uint256 nonce,uint256 deadline)"), "README lacks the intent type");
  assert(!/\{\{[A-Z_]+\}\}/u.test(readme), "README has unfilled placeholders");
  assert(!/[—\p{Extended_Pictographic}]/u.test(readme), "README contains an em dash or emoji");
  assert(!/op=1\b|\bsponsor\s+op=|op=prepare/u.test(readme), "README still mentions the retired sponsor verb (op 1) or op=prepare");
  assert(/op=quote/u.test(readme) && /abi\.encode\(uint8 template,bytes params,bytes32 salt\)/u.test(readme), "README lacks the one-intent propose format (op=quote, abi.encode(template, params, salt))");

  const state = JSON.parse(readFileSync(path.join(options.out, "state.json"), "utf8")) as DaoState;
  assert.equal(typeof state.treasury.settled, "boolean", "state.json lacks settled");
  assert.match(state.treasury.depositTreasury, /^\d+$/u, "state.json lacks raw depositTreasury");
  assert.match(state.treasury.shareLiability, /^\d+$/u, "state.json lacks raw shareLiability (phase 5 ruling 4c)");
  for (const proposal of state.proposals) {
    assert(Array.isArray(proposal.flags), `state.json proposal ${proposal.id} lacks flags[]`);
    assert.match(proposal.treasuryEffect.usdcApproved, /^\d+$/u, `state.json proposal ${proposal.id} lacks treasuryEffect.usdcApproved (phase 5 ruling 6)`);
    // A5-11: the instance panel is bound to the decoded calls, never to the details JSON.
    if (proposal.instance !== undefined) {
      const called = proposal.calls.map((call) => getAddress(call.to));
      assert(called.includes(getAddress(proposal.instance.address)), `state.json proposal ${proposal.id} shows an instance panel for ${proposal.instance.address}, which none of its calls touches`);
    }
  }
  assert.equal(state.chain.id, deployment.chainId, "state.json chain id differs from the deployment");
  assert.equal(state.constitution.textHash, deployment.constitution.textHash, "constitution hash differs from the deployment");
  assert(readme.includes(state.constitution.textHash), "README lacks the constitution hash");
  const addresses = new Map<string, string>();
  for (const [name, address] of Object.entries(state.contracts)) addresses.set(getAddress(address), `contracts.${name}`);
  for (const proposal of state.proposals) if (proposal.instance) addresses.set(getAddress(proposal.instance.address), `proposal ${proposal.id} instance`);
  for (const [address, label] of addresses) {
    const code = await env.publicClient.getCode({ address: address as `0x${string}` });
    assert(code !== undefined && code !== "0x", `${label} ${address} has no code on chain ${deployment.chainId}`);
  }
  for (const name of ["safe", "baal", "shares", "settlement", "depositShaman", "workManager", "templateFactory", "intentAccount"]) {
    const address = state.contracts[name];
    assert(address !== undefined && isAddress(address) && readme.includes(getAddress(address)), `README lacks the ${name} address`);
  }
  for (const name of ["snippet.js", "snippet.py", "llms.txt", "index.html"]) {
    const text = readFileSync(path.join(options.out, name), "utf8");
    assert(!/\{\{[A-Z_]+\}\}/u.test(text), `${name} has unfilled placeholders`);
  }
  const html = readFileSync(path.join(options.out, "index.html"), "utf8");
  assert(!/gradient|lucide|\bInter\b|Geist|Space Grotesk|purple|#000\b|#000000|#fff\b|#ffffff|box-shadow|border-radius/iu.test(html), "dashboard uses a forbidden design token (gradient, purple, black, white, shadow, radius, AI fonts)");
  assert(!/[—\p{Extended_Pictographic}]/u.test(html), "dashboard contains an em dash or emoji");
  assert(!/<form\b|<iframe\b/iu.test(html), "dashboard must not contain forms or iframes");
  const constitution = readFileSync(path.join(options.out, "CONSTITUTION.md"));
  const { keccak256 } = await import("viem");
  assert.equal(keccak256(constitution), state.constitution.textHash, "published CONSTITUTION.md bytes do not hash to the on-chain constitution hash");
  return { result: "PASS", readmeLines: lines.length, readmeLineLimit: 44, addressesWithCode: addresses.size, proposals: state.proposals.length, tasks: state.tasks.length, members: state.members.length, block: state.chain.blockNumber };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = parseArgs(process.argv.slice(2));
  validateBeacon({ deployment: args.deployment ?? process.env.ZERO_ONE_DEPLOYMENT ?? "deployments/local.json", out: path.resolve(ROOT, args.out ?? "beacon/public") })
    .then((summary) => console.log(json(summary)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
