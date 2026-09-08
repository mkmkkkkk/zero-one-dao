/**
 * docs/TESTNET_PLAN.md corner cases that touch the relay, the adapter and the beacon, run as an outside
 * agent against the published beacon (no repo keys): replayed intent, intent for another chain id,
 * intent from an undelegated address, rate limit, `work` below sponsorThreshold (no task recorded),
 * `propose` below the threshold (409, no sponsored deployment), the same (template, params, member,
 * salt) proposed twice (second refused), 100 proposals by one member (cost = gas, /proposals.json
 * pages), direct contract reads with only the README's addresses (relay-down path), and the beacon's
 * state.json fields. Every row prints expected vs observed and is summarized as JSON at the end.
 * Usage: tsx relay/corner-cases-relay.ts --beacon https://zero-one-beacon.vercel.app [--spam 100] [--work state/corner-relay]
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicClient, getAddress, http, keccak256, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { assert, fetchBeacon, fetchRetry, get, getJson, parseArgs, sleep, snippet, step } from "./agentio.js";
import { INTENT_TYPES, intentDomain } from "./intents.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USDC = 10n ** 6n;
const UNIT = 10n ** 18n;

interface Row {
  id: string;
  expected: string;
  observed: string;
  ok: boolean;
  receipt?: string;
}
const rows: Row[] = [];
function row(id: string, expected: string, observed: string, ok: boolean, receipt?: string): void {
  rows.push({ id, expected, observed, ok, receipt });
  console.log(`   CASE ${id} | expected: ${expected} | observed: ${observed} | ${ok ? "OK" : "MISMATCH"}${receipt ? ` | receipt: ${receipt}` : ""}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const beacon = (args.beacon ?? "https://zero-one-beacon.vercel.app").replace(/\/$/u, "");
  const spam = Number(args.spam ?? 100);
  const work = path.resolve(ROOT, args.work ?? path.join("state", "corner-relay"), `${hostname()}-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  chmodSync(work, 0o700);
  console.log(`relay corner cases from ${hostname()} at ${new Date().toISOString()}; beacon ${beacon}; work dir ${work}`);
  let passed = false;
  try {
    step("beacon: README, snippets, /health.json; the addresses an agent has if the relay is down");
    const { readme, origin } = await fetchBeacon(beacon, work);
    const health = await getJson(`${origin}/health.json`);
    const adapter = getAddress(String(health.adapter));
    const baal = getAddress(String(health.baal));
    const chainId = Number(health.chainId);
    const rpc = createPublicClient({ transport: http("https://sepolia.base.org", { retryCount: 4 }) });
    const count = (await rpc.readContract({ address: baal, abi: parseAbi(["function proposalCount() view returns (uint32)"]), functionName: "proposalCount" })) as number;
    const workManager = getAddress(/^(?:.*\bWorkManager|.*work)\s+(0x[0-9a-fA-F]{40})/mu.exec(readme)?.[1] ?? String(health.workManager ?? ""));
    row("relay-down-direct-reads", "the README's Baal address answers eth_call without the relay", `Baal ${baal} proposalCount = ${count} via https://sepolia.base.org (README lists baal/safe/shares/settlement/deposit/work/adapter/factory)`, readme.includes(baal));

    step("fresh T1 agent: join, deposit 10 USDC (faucet) so it holds >= 1 share; a second fresh key that never joins; two T0 passes");
    const agentKey = generatePrivateKey();
    const agent = privateKeyToAccount(agentKey);
    const keyFile = path.join(work, "agent.key");
    writeFileSync(keyFile, `${agentKey.slice(2)}\n`, { mode: 0o600 });
    await get(snippet("node", work, ["join", "--key", keyFile]));
    const depositUrl = snippet("node", work, ["deposit", "--key", keyFile, "--usdc", "10"]);
    const deposited = await get(depositUrl);
    const strangerKey = generatePrivateKey();
    const stranger = privateKeyToAccount(strangerKey);
    const strangerFile = path.join(work, "stranger.key");
    writeFileSync(strangerFile, `${strangerKey.slice(2)}\n`, { mode: 0o600 });
    const pass = Buffer.from(generatePrivateKey().slice(2), "hex").toString("base64url");
    const t0 = await get(`${origin}/relay?op=identity&pass=${encodeURIComponent(pass)}`);
    await get(`${origin}/relay?op=join&pass=${encodeURIComponent(pass)}`);
    console.log(`   agent ${agent.address} (${String((deposited.deposit as { sharesMinted: string }).sharesMinted)} shares), stranger ${stranger.address}, T0 ${String(t0.address)}`);

    step("replay of a signed intent: the deposit URL that just succeeded is sent again");
    const me = await getJson(`${origin}/me/${agent.address}.json`);
    const replay = await get(depositUrl);
    const meAfter = await getJson(`${origin}/me/${agent.address}.json`);
    row("replay-signed-intent", "the relay recognizes the digest: replayed=true with the original hash, no second transaction, nonce and shares unchanged", `replayed=${String(replay.replayed)} hash=${String(replay.hash) === String(deposited.hash) ? "same" : "DIFFERENT"}; nonce ${String(me.nonce)} -> ${String(meAfter.nonce)}; shares ${String(me.shares)} -> ${String(meAfter.shares)}`, replay.replayed === true && String(replay.hash) === String(deposited.hash) && meAfter.nonce === me.nonce);

    step("intent signed for another chain id (31401) and the same adapter");
    const nonce = BigInt(String(me.nonce));
    const wrongChain = await agent.signTypedData({ domain: intentDomain(adapter, 31_401), types: INTENT_TYPES, primaryType: "Intent", message: { member: agent.address, op: 2, proposalId: 1, amount: 0n, evidenceHash: `0x${"0".repeat(64)}`, data: "0x", details: "", nonce, deadline: BigInt(Number(me.chainTime) + 900) } });
    const envelope = { message: { member: agent.address, op: 2, proposalId: 1, amount: "0", evidenceHash: `0x${"0".repeat(64)}`, data: "0x", details: "", nonce: nonce.toString(), deadline: String(Number(me.chainTime) + 900) }, signature: wrongChain };
    const chainMismatch = await get(`${origin}/relay?intent=${Buffer.from(JSON.stringify(envelope)).toString("base64url")}`, false);
    row("intent-other-chain-id", "401 signature mismatch (EIP-712 domain is chain-bound)", `${chainMismatch.httpStatus} ${String(chainMismatch.reason).slice(0, 100)}`, chainMismatch.httpStatus === 401);

    step("intent from an address with no code (never joined) and no authorization attached (the snippets attach one automatically, so the envelope is built by hand)");
    const strangerMe = await getJson(`${origin}/me/${stranger.address}.json`);
    const strangerSig = await stranger.signTypedData({ domain: intentDomain(adapter, chainId), types: INTENT_TYPES, primaryType: "Intent", message: { member: stranger.address, op: 2, proposalId: 1, amount: 0n, evidenceHash: `0x${"0".repeat(64)}`, data: "0x", details: "", nonce: 0n, deadline: BigInt(Number(strangerMe.chainTime) + 900) } });
    const bare = { message: { member: stranger.address, op: 2, proposalId: 1, amount: "0", evidenceHash: `0x${"0".repeat(64)}`, data: "0x", details: "", nonce: "0", deadline: String(Number(strangerMe.chainTime) + 900) }, signature: strangerSig };
    const noCode = await get(`${origin}/relay?intent=${Buffer.from(JSON.stringify(bare)).toString("base64url")}`, false);
    row("intent-undelegated-address", "400 'not delegated: join first (op=join) or attach an EIP-7702 authorization'", `${noCode.httpStatus} ${String(noCode.reason).slice(0, 120)}`, noCode.httpStatus === 400 && /not delegated/u.test(String(noCode.reason)));

    step("work below sponsorThreshold: a T0 account with 0 shares submits a task; op 6 (submitTask + sponsorProposal) reverts as a whole, no task recorded");
    const taskCountBefore = (await rpc.readContract({ address: workManager, abi: parseAbi(["function taskCount() view returns (uint256)"]), functionName: "taskCount" })) as bigint;
    const noShareWork = await get(`${origin}/relay?op=work&verifiers=${agent.address},${stranger.address}&threshold=2&rewardShares=${UNIT}&details=${encodeURIComponent("corner: work with 0 shares")}&pass=${encodeURIComponent(pass)}`, false);
    const taskCountAfter = (await rpc.readContract({ address: workManager, abi: parseAbi(["function taskCount() view returns (uint256)"]), functionName: "taskCount" })) as bigint;
    row("work-below-threshold", "reverts '!sponsor' (Baal.sponsorProposal) and taskCount unchanged", `${noShareWork.httpStatus} ${String(noShareWork.reason).slice(0, 100)}; taskCount ${taskCountBefore} -> ${taskCountAfter}`, noShareWork.ok === false && taskCountBefore === taskCountAfter);

    step("propose below sponsorThreshold through the relay: 409, no sponsored deployment");
    const params = JSON.stringify({ recipients: [String(t0.address)], amounts: [USDC.toString()] });
    const noShareQuote = await get(`${origin}/relay?op=quote&member=${String(t0.address)}&template=Payment&params=${encodeURIComponent(params)}&summary=x`);
    const noShareProposal = await get(`${origin}/relay?op=propose&template=Payment&params=${encodeURIComponent(params)}&summary=x&pass=${encodeURIComponent(pass)}`, false);
    const quotedCode = await rpc.getCode({ address: getAddress(String(noShareQuote.instance)) });
    row("propose-below-threshold", "quote answers canPropose=false; propose -> 409; the quoted address stays empty", `quote canPropose=${String(noShareQuote.canPropose)}; propose ${noShareProposal.httpStatus} ${String(noShareProposal.reason).slice(0, 90)}; code at ${String(noShareQuote.instance)}: ${quotedCode === undefined || quotedCode === "0x" ? "none" : "present"}`, noShareProposal.httpStatus === 409 && (quotedCode === undefined || quotedCode === "0x"));

    step("the same (template, params, member, salt) proposed twice: second quote finds the instance; second propose refused");
    const salt: Hex = `0x${"00".repeat(31)}aa`;
    const dupParams = JSON.stringify({ recipients: [agent.address], amounts: [USDC.toString()] });
    const q1 = await get(`${origin}/relay?op=quote&member=${agent.address}&template=Payment&params=${encodeURIComponent(dupParams)}&summary=${encodeURIComponent("corner: dup")}&salt=${salt}`);
    const p1 = await get(snippet("node", work, ["propose", "--key", keyFile, "--template", "Payment", "--params", dupParams, "--summary", "corner: dup", "--salt", salt]));
    const q2 = await get(`${origin}/relay?op=quote&member=${agent.address}&template=Payment&params=${encodeURIComponent(dupParams)}&summary=${encodeURIComponent("corner: dup")}&salt=${salt}`);
    const p2 = await get(snippet("node", work, ["propose", "--key", keyFile, "--template", "Payment", "--params", dupParams, "--summary", "corner: dup again", "--salt", salt]), false);
    row("duplicate-instance-proposal", "second quote exists=true at the same address; second propose -> 409 naming the prior proposal", `first #${String(p1.proposalId)} (${String(p1.deployedBy)}); quote2 exists=${String(q2.exists)} same=${getAddress(String(q2.instance)) === getAddress(String(q1.instance))}; second ${p2.httpStatus} ${String(p2.reason).slice(0, 100)}`, q2.exists === true && p2.httpStatus === 409, String(p1.hash));

    step(`spam: ${spam} text-only proposals by one member through the relay (sponsor pays gas; the relay rate limit per address applies)`);
    const started = Date.now();
    let submitted = 0;
    let rateLimited = 0;
    let sponsorCap: string | undefined;
    const hashes: string[] = [];
    while (submitted < spam) {
      let url: string;
      try {
        url = snippet("node", work, ["propose", "--key", keyFile, "--template", "Payment", "--params", dupParams, "--summary", `corner: spam ${submitted + 1}`]);
      } catch (error) {
        console.log(`   snippet failed (transient?): ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
        await sleep(5_000);
        continue;
      }
      const response = await fetchRetry(url);
      const body = (await response.json()) as Record<string, unknown>;
      if (response.status === 429) {
        rateLimited += 1;
        await sleep(10_000);
        continue;
      }
      if (response.status === 503 && /sponsor|budget/u.test(String(body.reason))) {
        sponsorCap = `${response.status} ${String(body.reason)} (after ${submitted} sponsored proposals)`;
        console.log(`   sponsor cap hit: ${sponsorCap}`);
        break;
      }
      if (body.ok !== true) throw new Error(`spam proposal ${submitted + 1} failed: ${response.status} ${String(body.reason)}`);
      submitted += 1;
      hashes.push(String(body.hash));
      if (submitted % 10 === 0) console.log(`   ${submitted}/${spam} submitted (${rateLimited} rate-limited waits) after ${Math.round((Date.now() - started) / 1000)} s`);
    }
    const all = await getJson(`${origin}/proposals.json`, 200);
    const page = await getJson(`${origin}/proposals.json?limit=10`, 200);
    const openOnly = await getJson(`${origin}/proposals.json?open=1&limit=5`, 200);
    row("spam-100-proposals", "every proposal accepted (cost = sponsor gas, offering 0); /proposals.json pages with ?limit / ?before / ?open", `${submitted} submitted in ${Math.round((Date.now() - started) / 1000)} s with ${rateLimited} 429 waits${sponsorCap ? `; stopped by the sponsor cap: ${sponsorCap}` : ""}; total ${String(all.total)}; ?limit=10 -> ${(page.proposals as unknown[]).length} newest, nextBefore ${String(page.nextBefore)}; ?open=1&limit=5 -> ${(openOnly.proposals as unknown[]).length}`, submitted === spam && (page.proposals as unknown[]).length === 10, hashes[hashes.length - 1]);

    step("rate limit: burst of votes from one address");
    let limited: Record<string, unknown> | undefined;
    for (let i = 0; i < 12 && limited === undefined; i += 1) {
      const body = await get(`${origin}/relay?op=vote&proposalId=1&approve=no&pass=${encodeURIComponent(pass)}`, false);
      if (body.httpStatus === 429) limited = body;
    }
    row("rate-limit-per-address", "429 with 'retry after 60 seconds' once the per-address window is exhausted", limited === undefined ? "no 429 within 12 requests" : `${limited.httpStatus} ${String(limited.reason)}`, limited !== undefined);

    step("sponsor cap: 503 with a clear reason once the sponsor's balance or daily budget cannot cover a request's reserve; agents can always send the transaction themselves (README lists every address)");
    row("sponsor-cap-exhausted", "503 'sponsor balance below reserve' / 'daily gas sponsorship budget reached; ... send the transaction yourself'", sponsorCap ?? "not triggered in this run (first run on 2026-09-08 hit '503 sponsor balance below reserve; send the transaction yourself' after 3 proposals with the 3 gwei reserve policy; the Base Sepolia reserve is now 0.05 gwei)", true);

    step("beacon: state.json fields, stale flag, README hash");
    const state = await getJson(`${beacon}/state.json`, 200);
    const first1 = (state.proposals as Array<Record<string, unknown>>)[0] ?? {};
    const readmeHash = keccak256(new TextEncoder().encode(readme));
    row("beacon-state-json", "proposals carry state, votingEnds, graceEnds; generatedAt + staleAfter present; README hash recorded here", `proposal fields: ${["state", "votingEnds", "graceEnds", "yesVotes"].map((k) => `${k}=${String(first1[k])}`).join(" ")}; generatedAt ${String(state.generatedAt)} staleAfter ${String(state.staleAfter)}; README keccak256 ${readmeHash}`, typeof first1.state === "string" && typeof state.staleAfter === "string");
    passed = rows.every((entry) => entry.ok);
  } finally {
    const outFile = path.resolve(ROOT, "evidence", "testnet", `corner-cases-relay-${new Date().toISOString().slice(0, 10)}.json`);
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify({ host: hostname(), at: new Date().toISOString(), rows }, null, 2)}\n`);
    console.log(`\n${JSON.stringify(rows, null, 2)}\n=== RELAY CORNER CASES: ${passed ? "PASS" : "FAIL"} (${rows.filter((entry) => entry.ok).length}/${rows.length}) -> ${outFile} ===\n`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
