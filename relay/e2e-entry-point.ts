import { settleRetention } from '../src/retention.js';
/**
 * Entry-point E2E (decision.md 2026-09-10 "the agent entry point must not sit behind a bot challenge"):
 * proves, on a fresh anvil and against a real relay process, that the relay IS the beacon and that one
 * plain GET is the whole onboarding.
 *
 * 1. With no build present, every beacon path answers 404 in the relay's JSON error shape (no stack, no
 *    HTML) and the dynamic endpoints keep working.
 * 2. A build with no `--origin` names the canonical origin (https://relay-zero.mkyang.ai), so the build
 *    for the mini needs no flag; that build still passes the offline half of the validator.
 * 3. A build for this local relay is served by the relay itself, with one content type per path, no
 *    redirect and no request header consulted.
 * 4. The static `state.json` / `proposals.json` in the build directory can never shadow the relay's live
 *    routes: they are overwritten with a sentinel and the relay still answers live.
 * 5. `beacon:validate --origin <relay>` fetches every URL the README advertises and passes.
 * 6. The same validator run against an origin that answers a bot challenge (a stub reproducing Vercel's
 *    403 `x-vercel-mitigated: challenge` Security Checkpoint page) FAILS loudly. This is the check that
 *    was missing when a green validate coexisted with an entry point agents could not read.
 * 7. A cold start that reads nothing but the served README.txt and snippet.js / snippet.py: join,
 *    deposit, propose, vote, execute, ragequit.
 *
 * Mirror-only steps, as in relay/e2e-local.ts: `evm_increaseTime` warps, and anvil mines only on
 * transactions, so a vote that follows a fresh submission is accompanied by one mined block.
 * Usage: npm run e2e:entry-point ; receipts under evidence/phase5/entry-point/.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import http from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { loadLocalArtifact } from "../src/baal.js";
import { chooseFreePort, startDevnet, stopDevnet } from "../src/devnet.js";
import { connectDevnet, increaseTime, writeAndWait } from "../src/onchain.js";
import { DEFAULT_PARAMS, deployZeroOne, GENESIS_DEPOSIT, genesisDeposit, SETTLEMENT_UNIT, UNIT } from "../src/zeroOne.js";
import { buildBeacon } from "../beacon/scripts/build.js";
import { CANONICAL_ORIGIN, MIRROR_ORIGIN } from "./common.js";
import { assert, fetchBeacon, get, getJson, sleep, snippet, step } from "./agentio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "evidence", "phase5", "entry-point");
const NO_PROXY = { ...process.env, no_proxy: "127.0.0.1,localhost", NO_PROXY: "127.0.0.1,localhost", HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "" };

/** The Vercel challenge, reproduced byte-for-byte enough to be recognized: 403 + the mitigation header. */
const CHALLENGE_BODY = `<!DOCTYPE html><html><head><title>Vercel Security Checkpoint</title></head><body><p>Verifying your browser...</p></body></html>`;

/** Every path the relay must serve from the build, with the content type it must answer. */
const SERVED: Array<[string, RegExp]> = [
  ["/README.txt", /^text\/plain; charset=utf-8$/u],
  ["/llms.txt", /^text\/plain; charset=utf-8$/u],
  ["/robots.txt", /^text\/plain; charset=utf-8$/u],
  ["/snippet.js", /^text\/javascript; charset=utf-8$/u],
  ["/snippet.py", /^text\/x-python; charset=utf-8$/u],
  ["/CONSTITUTION.md", /^text\/markdown; charset=utf-8$/u],
  ["/index.html", /^text\/html; charset=utf-8$/u],
  ["/", /^text\/html; charset=utf-8$/u],
];

async function waitForRelay(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`relay exited early (${child.exitCode})`);
    try {
      const response = await fetch(`${url}/health.json`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(150);
  }
  throw new Error("relay did not become healthy in 30 s");
}

/** The JSON summary a validate run prints last (its progress lines come first). */
function summaryOf(stdout: string): Record<string, unknown> {
  const start = stdout.lastIndexOf("\n{\n");
  const text = start >= 0 ? stdout.slice(start + 1) : stdout.slice(stdout.indexOf("{"));
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Run beacon/scripts/validate.ts as the operator would and return the captured run.
 *
 * Asynchronous on purpose: the bot-challenge control below is an HTTP server inside THIS process, and a
 * blocking spawnSync would stop its event loop, so the validator under test would hang on its first
 * fetch instead of being refused (that is exactly what happened before this was made async).
 *
 * @param args CLI arguments after the script path.
 * @returns Exit code, stdout and stderr of the run.
 */
async function validateCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(ROOT, "beacon/scripts/validate.ts"), ...args], { env: NO_PROXY, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const status = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("validate did not finish in 300 s")); }, 300_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  console.log(`   $ tsx beacon/scripts/validate.ts ${args.join(" ")} -> exit ${String(status)}`);
  return { status, stdout, stderr };
}

async function main(): Promise<void> {
  mkdirSync(EVIDENCE, { recursive: true });
  const devnet = await startDevnet(`e2e-entry-point-${Date.now()}`, { hardfork: "prague" });
  let relay: ChildProcess | undefined;
  let challenger: http.Server | undefined;
  let passed = false;
  try {
    const chain = connectDevnet(devnet);
    const F = chain.contexts[0]!;
    const sponsorKey = devnet.privateKeys[15]!;
    const sponsorAddress = devnet.addresses[15]!;
    const settlementAbi = loadLocalArtifact("TestToken").abi;

    step("deploy Zero One on a fresh anvil (prague) + genesis: founder deposits 50 USDC");
    const dao = await deployZeroOne(F, { ...DEFAULT_PARAMS, founder: F.account.address });
    const genesis = await genesisDeposit(F, dao, GENESIS_DEPOSIT);
    assert(genesis.sharesMinted === 50n * UNIT, "founder holds 50e18 shares");
    const float = await F.publicClient.simulateContract({ address: dao.settlement, abi: settlementAbi, functionName: "transfer", args: [sponsorAddress, 10_000n * SETTLEMENT_UNIT], account: F.account } as never);
    await writeAndWait(F, float.request as unknown as Record<string, unknown>);
    const record = {
      rpcUrl: devnet.rpcUrl,
      chainId: devnet.chainId,
      deployer: F.account.address,
      founder: F.account.address,
      settlement: dao.settlement,
      safe: dao.safe,
      baal: dao.baal,
      shares: dao.shares,
      loot: dao.loot,
      depositShaman: dao.depositShaman,
      workManager: dao.workManager,
      templateFactory: dao.templateFactory,
      treasuryLedger: dao.treasuryLedger,
      templateDeployers: dao.templateDeployers,
      intentAccount: dao.intentAccount,
      constitution: { address: dao.constitution, textHash: dao.constitutionHash, textUrl: dao.constitutionTextUrl, text: "docs/CONSTITUTION.md" },
      governance: { votingPeriod: dao.params.governance.votingPeriod, gracePeriod: dao.params.governance.gracePeriod, proposalOffering: "0", quorumPercent: "0", sponsorThreshold: dao.params.governance.sponsorThreshold.toString(), minRetentionPercent: "66" },
      genesis: { depositUsdc6: GENESIS_DEPOSIT.toString(), sharesMinted: genesis.sharesMinted.toString(), approveHash: genesis.approveHash, depositHash: genesis.depositHash },
    };
    const deploymentFile = path.join(devnet.stateDir, "deployment.json");
    writeFileSync(deploymentFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });

    step("start the relay with RELAY_BEACON_DIR pointing at a directory that does not exist yet");
    const port = chooseFreePort(18_751);
    const origin = `http://127.0.0.1:${port}`;
    const beacon = path.join(devnet.stateDir, "beacon");
    relay = spawn(process.execPath, ["--import", "tsx", path.join(ROOT, "relay", "server.ts")], {
      cwd: ROOT,
      env: { ...NO_PROXY, ZERO_ONE_DEPLOYMENT: deploymentFile, RELAY_SPONSOR_KEY: sponsorKey, RELAY_PORT: String(port), RELAY_STATE_DIR: path.join(devnet.stateDir, "relay"), RELAY_BEACON_DIR: beacon, RELAY_LOG: "1", RELAY_RATE_ADDRESS: "1000", RELAY_RATE_IP: "10000" },
      stdio: ["ignore", "inherit", "inherit"],
    });
    await waitForRelay(origin, relay);

    step("no build present: every beacon path answers 404 in the JSON error shape, and the dynamic endpoints still work");
    const health0 = await getJson(`${origin}/health.json`, 200);
    assert((health0.beacon as { built: boolean }).built === false, "/health.json reports the beacon as not built");
    const missing: string[] = [];
    for (const [served] of SERVED) {
      const response = await fetch(`${origin}${served}`);
      const text = await response.text();
      const body = JSON.parse(text) as { ok?: boolean; status?: number; reason?: string };
      assert(response.status === 404 && body.ok === false && body.status === 404, `${served} -> 404 {ok:false,status:404} with no build`);
      assert(/beacon:build/u.test(String(body.reason)) && !/\n\s+at /u.test(text), `${served} 404 reason tells the operator to build and carries no stack trace`);
      assert((response.headers.get("content-type") ?? "").startsWith("application/json"), `${served} 404 is JSON, not HTML`);
      missing.push(`${served} -> ${response.status} ${response.headers.get("content-type") ?? ""} ${JSON.stringify(body)}`);
    }
    const stateLive0 = await getJson(`${origin}/state.json`, 200);
    assert(Number((stateLive0.chain as { id: number }).id) === devnet.chainId, "/state.json answers live with no beacon build present");
    writeFileSync(path.join(EVIDENCE, "no-build-404.txt"), `${missing.join("\n")}\n`);

    step(`a build with no --origin names the canonical origin ${CANONICAL_ORIGIN} (this is what the mini build produces)`);
    const canonicalOut = path.join(devnet.stateDir, "beacon-canonical");
    const canonicalBuild = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "beacon/scripts/build.ts"), "--deployment", deploymentFile, "--out", canonicalOut], { encoding: "utf8", env: NO_PROXY, cwd: ROOT });
    assert(canonicalBuild.status === 0, `beacon:build with no --origin succeeded: ${canonicalBuild.stdout.trim()}${canonicalBuild.stderr}`);
    const canonicalReadme = readFileSync(path.join(canonicalOut, "README.txt"), "utf8");
    const canonicalLines = canonicalReadme.trimEnd().split("\n");
    assert(canonicalReadme.includes(`Relay ${CANONICAL_ORIGIN}.`), `README names ${CANONICAL_ORIGIN} as the relay`);
    assert(canonicalReadme.includes(`GET ${CANONICAL_ORIGIN}/relay?intent=`), "every verb URL in the README points at the canonical origin");
    assert(canonicalReadme.includes(`Mirror ${MIRROR_ORIGIN} `), `the README names the mirror ${MIRROR_ORIGIN} in one line`);
    assert(canonicalLines.length === 44, `the canonical README is ${canonicalLines.length} lines (limit 44)`);
    assert(canonicalReadme.includes(`${CANONICAL_ORIGIN}/CONSTITUTION.md`), "the constitution URL of a deployment with a repo-relative textUrl points at the canonical origin");
    writeFileSync(path.join(EVIDENCE, "readme-canonical-origin.txt"), canonicalReadme);
    const canonicalValidate = await validateCli(["--deployment", deploymentFile, "--out", canonicalOut, "--no-fetch", "1"]);
    assert(canonicalValidate.status === 0 && summaryOf(canonicalValidate.stdout).fetched === "SKIPPED", "the canonical build passes the offline half of the validator (nothing is fetched from the production host by this test)");
    writeFileSync(path.join(EVIDENCE, "validate-canonical-offline.log"), `$ tsx beacon/scripts/validate.ts --deployment <mirror> --out <canonical> --no-fetch 1\n${canonicalValidate.stdout}${canonicalValidate.stderr}`);

    step("build the beacon for this relay origin and serve it from the relay: one content type per path, no redirect, no request header read");
    await buildBeacon({ deployment: deploymentFile, origin, out: beacon });
    const headerLog: string[] = [];
    for (const [served, type] of SERVED) {
      const response = await fetch(`${origin}${served}`, { redirect: "manual" });
      const text = await response.text();
      assert(response.status === 200, `${served} -> 200`);
      assert(type.test(response.headers.get("content-type") ?? ""), `${served} content type ${String(response.headers.get("content-type"))} matches ${String(type)}`);
      assert(response.headers.get("set-cookie") === null, `${served} sets no cookie`);
      assert(response.headers.get("location") === null, `${served} is not a redirect`);
      headerLog.push(`GET ${served} -> ${response.status} ${response.headers.get("content-type") ?? ""} ${text.length} bytes; nosniff=${String(response.headers.get("x-content-type-options"))}`);
    }
    // No user-agent sniffing: a browser UA, a bot UA and no UA at all must return identical bytes.
    const bodies = await Promise.all([
      fetch(`${origin}/README.txt`).then(async (r) => r.text()),
      fetch(`${origin}/README.txt`, { headers: { "user-agent": "Mozilla/5.0 (Macintosh) Safari/605" } }).then(async (r) => r.text()),
      fetch(`${origin}/README.txt`, { headers: { "user-agent": "python-requests/2.31.0" } }).then(async (r) => r.text()),
    ]);
    assert(bodies[0] === bodies[1] && bodies[1] === bodies[2], "README.txt is byte-identical with no user-agent, a browser user-agent and a script user-agent");
    const health1 = await getJson(`${origin}/health.json`, 200);
    assert((health1.beacon as { built: boolean }).built === true, "/health.json now reports the beacon as built");
    writeFileSync(path.join(EVIDENCE, "served-headers.txt"), `${headerLog.join("\n")}\n`);

    step("the build's static state.json / proposals.json can never shadow the relay's live routes");
    const sentinel = { sentinel: "static file from the beacon build; if an agent sees this the relay let a file shadow a live route" };
    writeFileSync(path.join(beacon, "state.json"), `${JSON.stringify(sentinel)}\n`);
    writeFileSync(path.join(beacon, "proposals.json"), `${JSON.stringify(sentinel)}\n`);
    const liveState = await getJson(`${origin}/state.json`, 200);
    const liveProposals = await getJson(`${origin}/proposals.json`, 200);
    assert(liveState.sentinel === undefined && Number((liveState.chain as { id: number }).id) === devnet.chainId, "/state.json is the relay's live answer, not the sentinel file");
    assert(liveProposals.sentinel === undefined && Array.isArray(liveProposals.proposals), "/proposals.json is the relay's live answer, not the sentinel file");
    await buildBeacon({ deployment: deploymentFile, origin, out: beacon });

    step("beacon:validate against the relay origin: it fetches every URL the README advertises");
    const validated = await validateCli(["--deployment", deploymentFile, "--out", beacon, "--origin", origin]);
    writeFileSync(path.join(EVIDENCE, "validate-relay-origin.log"), `$ tsx beacon/scripts/validate.ts --deployment <mirror> --out <beacon> --origin ${origin}\n${validated.stdout}${validated.stderr}`);
    assert(validated.status === 0, `validate exited 0: ${validated.stderr.slice(0, 400)}`);
    const summary = summaryOf(validated.stdout) as unknown as { result: string; fetched: number; advertised: string[]; origin: string };
    assert(summary.result === "PASS" && summary.fetched >= 13, `validate PASS after fetching ${summary.fetched} URLs; advertised ${JSON.stringify(summary.advertised)}`);
    assert(summary.origin === origin, "validate fetched from the origin under test");

    step("negative control: the same validator against an origin that answers Vercel's bot challenge must FAIL, not pass");
    const challengePort = chooseFreePort(19_751);
    challenger = http.createServer((request, response) => {
      response.writeHead(403, { "Content-Type": "text/html; charset=utf-8", "x-vercel-mitigated": "challenge", "x-vercel-id": "hkg1::stub" });
      response.end(CHALLENGE_BODY);
    });
    await new Promise<void>((resolve) => challenger!.listen(challengePort, "127.0.0.1", resolve));
    const challengeProbe = await fetch(`http://127.0.0.1:${challengePort}/README.txt`);
    assert(challengeProbe.status === 403 && challengeProbe.headers.get("x-vercel-mitigated") === "challenge", "the stub reproduces 403 x-vercel-mitigated: challenge for a plain GET");
    const refused = await validateCli(["--deployment", deploymentFile, "--out", beacon, "--origin", `http://127.0.0.1:${challengePort}`]);
    writeFileSync(path.join(EVIDENCE, "validate-against-challenge.log"), `$ tsx beacon/scripts/validate.ts --deployment <mirror> --out <beacon> --origin http://127.0.0.1:${challengePort}\nexit ${String(refused.status)}\n${refused.stdout}${refused.stderr}`);
    assert(refused.status !== 0, `validate against a challenged origin exits non-zero (${String(refused.status)})`);
    assert(/did not answer 200|bot-mitigation header/u.test(refused.stderr), `and says why: ${refused.stderr.split("\n").find((line) => /did not answer 200|bot-mitigation/u.test(line))?.trim() ?? refused.stderr.slice(0, 300)}`);
    challenger.close();
    challenger = undefined;

    step("cold start: an agent that has only the served README.txt and the served snippets");
    const work = path.join(devnet.stateDir, "cold-start");
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const { readme, origin: readmeOrigin } = await fetchBeacon(origin, work);
    assert(readmeOrigin === origin, `the README fetched from the relay names its own origin (${readmeOrigin})`);
    assert(readme.trimEnd().split("\n").length === 44, `the served README is ${readme.trimEnd().split("\n").length} lines`);
    writeFileSync(path.join(EVIDENCE, "readme-served-by-relay.txt"), readme);
    for (const lang of ["node", "python"] as const) {
      const result = spawnSync(lang === "node" ? "node" : "python3", [path.join(work, lang === "node" ? "snippet.js" : "snippet.py"), "selftest"], { encoding: "utf8", env: NO_PROXY });
      assert(result.status === 0 && /PASS/u.test(result.stdout), `${lang} snippet fetched from the relay selftests: ${result.stdout.trim()}`);
    }
    const agentKey = generatePrivateKey();
    const agent = privateKeyToAccount(agentKey);
    const keyFile = path.join(work, "agent.key");
    writeFileSync(keyFile, `${agentKey.slice(2)}\n`, { mode: 0o600 });

    step("join (node snippet.js join): the adapter is attached to a key that has never held ETH");
    const joined = await get(snippet("node", work, ["join", "--key", keyFile]));
    assert(joined.delegated === true && joined.shares === "0", "delegated, 0 shares");

    step("deposit 100 USDC (the mirror faucet tops the agent up first)");
    const deposited = await get(snippet("node", work, ["deposit", "--key", keyFile, "--usdc", "100"]));
    assert(String((deposited.deposit as { sharesMinted?: string })?.sharesMinted) === "100", "100 USDC at NAV 1 -> 100 shares");
    const me1 = await getJson(`${origin}/me/${agent.address}.json`, 400);
    assert(me1.sharesFormatted === "100" && me1.navUsdcPerShare === "1", "/me: 100 shares, NAV 1 USDC per share");

    step("propose a Payment of 10 USDC to itself with ONE signed intent (op=quote -> sign -> submit)");
    const params = JSON.stringify({ recipients: [agent.address], amounts: [(10n * SETTLEMENT_UNIT).toString()] });
    const proposed = await get(snippet("node", work, ["propose", "--key", keyFile, "--template", "Payment", "--params", params, "--summary", "entry point: pay me 10 USDC"]));
    const proposalId = Number(proposed.proposalId);
    assert(proposalId > 0 && proposed.sponsored === true, `proposal #${proposalId} submitted and self-sponsored; instance ${String(proposed.instance)}`);

    step("vote YES right after the submission (the relay holds it for the next block; the mirror mines it)");
    const votePending = get(snippet("node", work, ["vote", "--key", keyFile, "--proposal", String(proposalId), "--approve", "yes"]));
    await sleep(1_500);
    await increaseTime(F, 1);
    const voted = await votePending;
    assert((voted.vote as { approved: boolean }).approved === true && voted.waitedBlocks === 1, "voted YES; the relay waited exactly one block (ruling 7)");

    step("warp past voting + grace (mirror only) and execute");
    await increaseTime(F, dao.params.governance.votingPeriod + dao.params.governance.gracePeriod + 60);
    await settleRetention(F, dao.shares, proposalId);
    const executed = await get(snippet("node", work, ["execute", "--key", keyFile, "--proposal", String(proposalId)]));
    const processed = executed.processed as { passed: boolean; actionFailed: boolean };
    assert(processed.passed === true && processed.actionFailed === false, "the proposal passed and its action executed");
    const me2 = await getJson(`${origin}/me/${agent.address}.json`, 400);
    assert(BigInt(String(me2.usdc)) >= 10n * SETTLEMENT_UNIT, `/me shows the payment (usdc ${String(me2.usdcFormatted)})`);

    step("ragequit all shares; /me shows 0 shares");
    const exited = await get(snippet("node", work, ["ragequit", "--key", keyFile]));
    assert(exited.ragequit !== undefined, `burned ${String((exited.ragequit as { sharesBurned: string }).sharesBurned)} shares`);
    const me3 = await getJson(`${origin}/me/${agent.address}.json`, 400);
    assert(me3.shares === "0", `/me shows 0 shares; usdc ${String(me3.usdcFormatted)}`);

    step("summary");
    const receipt = {
      canonicalOrigin: CANONICAL_ORIGIN,
      mirror: MIRROR_ORIGIN,
      relayOrigin: origin,
      chainId: devnet.chainId,
      servedPaths: SERVED.map(([served]) => served),
      validate: summary,
      challengeControl: { origin: `http://127.0.0.1:${challengePort}`, exit: refused.status },
      coldStart: { agent: getAddress(agent.address) as Address, proposalId, readmeLines: readme.trimEnd().split("\n").length },
      generatedAt: new Date().toISOString(),
    };
    writeFileSync(path.join(EVIDENCE, "entry-point-summary.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`   receipts in ${path.relative(ROOT, EVIDENCE)}`);
    passed = true;
  } finally {
    challenger?.close();
    relay?.kill("SIGKILL");
    await stopDevnet(devnet);
    console.log(`\n=== ENTRY POINT E2E: ${passed ? "PASS" : "FAIL"} ===\n`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

export type { Hex };
