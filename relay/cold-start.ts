/**
 * Cold-start run against the PUBLISHED beacon (docs/TESTNET_PLAN.md): a fresh agent with no repo access
 * uses only README.txt, snippet.js / snippet.py and the relay reachable through the beacon origin.
 * T1 (own key, never funded with ETH): join -> deposit 100 USDC (relay faucet) -> /me -> propose a
 * Payment of 10 USDC to itself with ONE signed intent (op=quote -> sign) -> vote YES (the relay waits one
 * block) -> wait for grace -> execute -> /me shows the payment -> work (task with two T0 verifiers,
 * self-sponsored in the same transaction) -> vote -> execute -> task claim -> deliver -> verifiers confirm
 * -> shares minted -> ragequit -> /me shows 0 shares. T0 (passphrase, fetch only): identity -> join ->
 * deposit 20 USDC -> vote -> ragequit. Every request and response is printed (intent payloads shortened,
 * passes redacted). The run needs no key other than the ones it generates.
 * Usage: tsx relay/cold-start.ts --beacon https://zero-one-beacon.vercel.app [--host mini|main] [--max-wait 900] [--work state/cold-start]
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress, keccak256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { assert, fetchRetry, get, getJson, parseArgs, sleep, snippet, step } from "./agentio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UNIT = 10n ** 18n;
const USDC = 10n ** 6n;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const beacon = (args.beacon ?? "https://zero-one-beacon.vercel.app").replace(/\/$/u, "");
  const host = args.host ?? hostname();
  const maxWait = Number(args["max-wait"] ?? 900) * 1000;
  const work = path.resolve(ROOT, args.work ?? path.join("state", "cold-start"), `${host}-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  chmodSync(work, 0o700);
  console.log(`cold start from ${host} at ${new Date().toISOString()}; beacon ${beacon}; work dir ${work}`);
  let passed = false;
  try {
    step("fetch README.txt (the only document the agent reads), llms.txt, the two helper snippets and /health.json");
    const readme = await (await fetchRetry(`${beacon}/README.txt`)).text();
    console.log(`\n----- README.txt (${readme.trimEnd().split("\n").length} lines) -----\n${readme}----- end README.txt -----`);
    assert(readme.trimEnd().split("\n").length <= 44, "README.txt is at most 44 lines");
    const originMatch = /Relay (https?:\/\/[^\s.]+(?:\.[^\s.]+)*)\./u.exec(readme);
    assert(originMatch !== null, "README names the relay origin");
    const origin = originMatch![1]!;
    for (const name of ["snippet.js", "snippet.py", "llms.txt"]) {
      const text = await (await fetchRetry(`${beacon}/${name}`)).text();
      writeFileSync(path.join(work, name), text);
      console.log(`   fetched ${name} (${text.length} bytes)`);
    }
    const health = await getJson(`${origin}/health.json`);
    assert(health.alive === true && Number(health.chainId) === 84532, "relay is alive on Base Sepolia");
    const adapter = String(health.adapter);
    for (const lang of ["node", "python"] as const) {
      const result = spawnSync(lang === "node" ? "node" : "python3", [path.join(work, lang === "node" ? "snippet.js" : "snippet.py"), "selftest"], { encoding: "utf8" });
      assert(result.status === 0 && /PASS/u.test(result.stdout), `${lang} snippet selftest: ${result.stdout.trim()}`);
    }

    step("fresh T1 key (never funded with ETH) written 0600; two T0 passes for the verifiers");
    const agentKey = generatePrivateKey();
    const agent = privateKeyToAccount(agentKey);
    const keyFile = path.join(work, "agent.key");
    writeFileSync(keyFile, `${agentKey.slice(2)}\n`, { mode: 0o600 });
    const passes = [0, 1].map(() => Buffer.from(generatePrivateKey().slice(2), "hex").toString("base64url"));
    console.log(`   agent ${agent.address}`);

    step("T1: join (node snippet.js join) -> the adapter is attached to the agent key; nothing minted");
    const joined = await get(snippet("node", work, ["join", "--key", keyFile]));
    assert(joined.delegated === true && joined.shares === "0", "agent is delegated and holds 0 shares");
    const me1 = await getJson(`${origin}/me/${agent.address}.json`);
    assert(me1.delegated === true && me1.shares === "0", "/me shows delegated, 0 shares");

    step("T1: deposit 100 USDC (deposit --usdc 100); the testnet faucet tops the agent up first; /me shows shares, NAV, exit value");
    const deposited = await get(snippet("node", work, ["deposit", "--key", keyFile, "--usdc", "100"]));
    const minted = BigInt(String((deposited.deposit as { sharesMinted?: string })?.sharesMinted ?? "0").replace(/\..*$/u, ""));
    assert(minted > 0n, `shares minted at NAV: ${String((deposited.deposit as { sharesMinted?: string })?.sharesMinted)}`);
    const me2 = await getJson(`${origin}/me/${agent.address}.json`);
    assert(BigInt(String(me2.shares)) > 0n && Number(me2.nonce) === 1, `/me: ${String(me2.sharesFormatted)} shares (${String(me2.percent)}%), NAV ${String(me2.navUsdcPerShare)}, exit value ${String(me2.exitValueUsdc)} USDC, nonce 1`);
    const agentShares = BigInt(String(me2.shares));

    step("read open proposals from /proposals.json");
    const list0 = (await getJson(`${origin}/proposals.json`)) as { proposals: Array<Record<string, unknown>>; openProposals: number[] };
    console.log(`   ${list0.proposals.length} proposals, open: ${JSON.stringify(list0.openProposals)}`);

    step("T1: propose a Payment of 10 USDC to itself with ONE signed intent: op=quote (read-only, the address and code hash are known before deployment) -> sign -> the relay deploys the instance -> the account submits fund+start");
    const params = JSON.stringify({ recipients: [agent.address], amounts: [(10n * USDC).toString()] });
    const quoted = await get(`${origin}/relay?op=quote&member=${agent.address}&template=Payment&params=${encodeURIComponent(params)}&summary=${encodeURIComponent("cold start: pay me 10 USDC")}`);
    assert(quoted.exists === false && typeof quoted.instance === "string" && typeof quoted.codeHash === "string" && quoted.canPropose === true, "quote: instance address + code hash known, canPropose");
    const proposed = await get(snippet("node", work, ["propose", "--key", keyFile, "--template", "Payment", "--params", params, "--summary", "cold start: pay me 10 USDC"]));
    const p1 = Number(proposed.proposalId);
    assert(p1 > 0 && proposed.sponsored === true && getAddress(String(proposed.instance)) === getAddress(String(quoted.instance)), `proposal #${p1} submitted + self-sponsored; instance at the quoted CREATE2 address (${String(proposed.deployedBy)})`);
    const list1 = (await getJson(`${origin}/proposals.json`)) as { proposals: Array<Record<string, unknown>> };
    const view1 = list1.proposals.find((p) => p.id === p1)!;
    assert(view1.state === "Voting" && (view1.instance as { template: string }).template === "Payment", `#${p1} is Voting with a Payment instance (code hash ${(view1.instance as { codeHash?: string }).codeHash})`);

    step("T1: vote YES on its own proposal right after the submission (the relay waits for the next block); with > 50% of shares the agent alone passes it");
    const vote1 = await get(snippet("node", work, ["vote", "--key", keyFile, "--proposal", String(p1), "--approve", "yes"]));
    assert((vote1.vote as { approved: boolean }).approved === true, `voted YES with ${String((vote1.vote as { shares: string }).shares)} shares (waitedBlocks ${String(vote1.waitedBlocks)})`);

    const awaitReady = async (id: number): Promise<void> => {
      const started = Date.now();
      for (;;) {
        const list = (await (await fetchRetry(`${origin}/proposals.json`)).json()) as { proposals: Array<{ id: number; state: string; graceEnds: number }> };
        const view = list.proposals.find((p) => p.id === id)!;
        if (view.state === "Ready") {
          console.log(`   #${id} is Ready after ${Math.round((Date.now() - started) / 1000)} s`);
          return;
        }
        if (["Defeated", "Processed", "Cancelled"].includes(view.state)) throw new Error(`#${id} is ${view.state}`);
        if (Date.now() - started > maxWait) throw new Error(`#${id} still ${view.state} after ${maxWait / 1000} s (graceEnds ${view.graceEnds}); the governance periods are longer than this run allows`);
        await sleep(10_000);
      }
    };
    step("wait for voting + grace to pass (real time), then T1 executes (execute --proposal): explicit gas, the Safe pays");
    await awaitReady(p1);
    const executed = await get(snippet("node", work, ["execute", "--key", keyFile, "--proposal", String(p1)]));
    assert((executed.processed as { passed: boolean; actionFailed: boolean }).passed === true && (executed.processed as { actionFailed: boolean }).actionFailed === false, "proposal passed and its action executed");
    const me3 = await getJson(`${origin}/me/${agent.address}.json`);
    assert(BigInt(String(me3.usdc)) >= 10n * USDC, `/me shows the payment (usdc ${String(me3.usdcFormatted)})`);

    step("T1: work (a task paid 5 shares, verifiers = two T0 accounts, threshold 2): submitTask + sponsorProposal in one transaction; vote; wait; execute");
    const t0 = [] as Array<{ pass: string; address: string; me: string }>;
    for (const pass of passes) {
      const identity = await get(`${origin}/relay?op=identity&pass=${encodeURIComponent(pass)}`);
      t0.push({ pass, address: getAddress(String(identity.address)), me: String(identity.me) });
    }
    const task = await get(snippet("python", work, ["work", "--key", keyFile, "--verifiers", `${t0[0]!.address},${t0[1]!.address}`, "--threshold", "2", "--reward-shares", (5n * UNIT).toString(), "--details", "cold start: run the cold-start path and record it"]));
    const taskInfo = task.task as { taskId: number; proposalId: number };
    assert(taskInfo.taskId > 0 && task.sponsored === true, `task #${taskInfo.taskId} recorded, proposal #${taskInfo.proposalId} submitted and sponsored in the same transaction`);
    const vote2 = await get(snippet("python", work, ["vote", "--key", keyFile, "--proposal", String(taskInfo.proposalId), "--approve", "yes"]));
    assert((vote2.vote as { approved: boolean }).approved === true, "voted YES on the task proposal");
    await awaitReady(taskInfo.proposalId);
    const activated = await get(snippet("python", work, ["execute", "--key", keyFile, "--proposal", String(taskInfo.proposalId)]));
    assert((activated.processed as { passed: boolean; actionFailed: boolean }).passed === true && (activated.processed as { actionFailed: boolean }).actionFailed === false, "task activated by the Safe");

    step("T1: claim the task, deliver evidence; the two T0 verifiers join and confirm (fetch only); 5 shares mint on the second confirmation");
    const claimed = await get(snippet("node", work, ["task", "--key", keyFile, "--task", String(taskInfo.taskId)]));
    assert((claimed.claimed as { taskId: number }).taskId === taskInfo.taskId, "claimed");
    const evidence = `cold start delivered from ${host}`;
    const delivered = await get(snippet("node", work, ["deliver", "--key", keyFile, "--task", String(taskInfo.taskId), "--evidence", evidence]));
    assert((delivered.delivered as { round: number }).round === 1, "delivery round 1");
    for (const [index, verifier] of t0.entries()) {
      await get(`${origin}/relay?op=join&pass=${encodeURIComponent(verifier.pass)}`);
      const confirmed = await get(`${origin}/relay?op=confirm&taskId=${taskInfo.taskId}&evidence=${encodeURIComponent(evidence)}&pass=${encodeURIComponent(verifier.pass)}`);
      if (index === 0) assert((confirmed.confirmed as { confirmations: number }).confirmations === 1 && confirmed.verified === undefined, "first confirmation: nothing minted");
      else assert((confirmed.verified as { rewardShares: string }).rewardShares === "5", "second confirmation minted exactly 5 shares to the worker");
    }
    const me4 = await getJson(`${origin}/me/${agent.address}.json`);
    assert(BigInt(String(me4.shares)) === agentShares + 5n * UNIT, `/me shows ${String(me4.sharesFormatted)} shares (deposit + 5 voted)`);

    step("T0 agent (passphrase, fetch only): join, deposit 20 USDC, vote NO on a new T1 proposal, ragequit; /me/pass shows 0 shares");
    const pass = Buffer.from(generatePrivateKey().slice(2), "hex").toString("base64url");
    const t0id = await get(`${origin}/relay?op=identity&pass=${encodeURIComponent(pass)}`);
    await get(`${origin}/relay?op=join&pass=${encodeURIComponent(pass)}`);
    const t0Deposit = await get(`${origin}/relay?op=deposit&amount=${20n * USDC}&pass=${encodeURIComponent(pass)}`);
    assert(BigInt(String((t0Deposit.deposit as { sharesMinted: string }).sharesMinted).replace(/\..*$/u, "")) > 0n, "T0 received shares at NAV");
    const p2Params = JSON.stringify({ recipients: [getAddress(String(t0id.address))], amounts: [USDC.toString()] });
    const proposed2 = await get(snippet("node", work, ["propose", "--key", keyFile, "--template", "Payment", "--params", p2Params, "--summary", "cold start: 1 USDC to the T0 agent"]));
    const p3 = Number(proposed2.proposalId);
    const t0Vote = await get(`${origin}/relay?op=vote&proposalId=${p3}&approve=no&pass=${encodeURIComponent(pass)}`);
    assert((t0Vote.vote as { approved: boolean }).approved === false, `T0 voted NO on #${p3} (waitedBlocks ${String(t0Vote.waitedBlocks)})`);
    const t0Exit = await get(`${origin}/relay?op=ragequit&pass=${encodeURIComponent(pass)}`);
    assert(t0Exit.ragequit !== undefined, "T0 ragequit all shares during voting (allowed)");
    const t0Me = await getJson(`${origin}${String(t0id.me)}`);
    assert(t0Me.shares === "0" && t0Me.custody === "custodial-lite", "/me/pass shows 0 shares");

    step("readable failures: vote twice, claim a completed task, deposit 0, unknown template, retired op=sponsor");
    const twice = await get(snippet("node", work, ["vote", "--key", keyFile, "--proposal", String(p1), "--approve", "no"]), false);
    assert(/voted|already/u.test(String(twice.reason)), "voting again on a closed proposal -> decoded reason");
    const reclaim = await get(snippet("node", work, ["task", "--key", keyFile, "--task", String(taskInfo.taskId)]), false);
    assert((reclaim.error as { name?: string } | undefined)?.name === "WrongStatus", "claiming a completed task -> WrongStatus decoded");
    const zero = await get(`${origin}/relay?op=deposit&amount=0&pass=${encodeURIComponent(pass)}`, false);
    assert((zero.error as { name?: string } | undefined)?.name === "ZeroAmount", "deposit 0 -> ZeroAmount decoded");
    const bogus = await get(`${origin}/relay?op=propose&template=Bogus&params=%7B%7D&pass=${encodeURIComponent(pass)}`, false);
    assert(String(bogus.reason).includes("unknown template"), "unknown template -> 400 reason");
    const ninth = await get(`${origin}/relay?op=sponsor&proposalId=${p1}&pass=${encodeURIComponent(pass)}`, false);
    assert(ninth.status === 400, "op=sponsor does not exist -> 400");

    step("T1: ragequit all shares; /me shows 0 shares and the pro-rata USDC");
    const exited = await get(snippet("node", work, ["ragequit", "--key", keyFile]));
    assert(exited.ragequit !== undefined, `burned ${String((exited.ragequit as { sharesBurned: string }).sharesBurned)} shares`);
    const me5 = await getJson(`${origin}/me/${agent.address}.json`);
    assert(me5.shares === "0", `/me shows 0 shares; usdc ${String(me5.usdcFormatted)}`);
    console.log(`   adapter ${adapter}; README hash ${keccak256(new TextEncoder().encode(readme))}`);
    passed = true;
  } finally {
    console.log(`\n=== COLD START (${host}): ${passed ? "PASS" : "FAIL"} ===\n`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
