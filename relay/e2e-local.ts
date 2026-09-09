/**
 * Mirror E2E through the relay (docs/TESTNET_PLAN.md cold-start): fresh anvil + deploy + genesis
 * (50 USDC founder), a sponsor float, the relay against it, the beacon built and validated, then a
 * cold-start agent that uses ONLY the published README.txt helpers (snippet.js / snippet.py) and the
 * relay: a fresh T1 agent joins, deposits 100 mock USDC, reads /me, proposes a Payment (10 USDC to
 * itself) with ONE signed intent (op=quote -> sign -> the relay deploys the CREATE2 instance and the
 * account submits the fund+start proposal; ruling 2), the founder votes YES via the relay (python
 * snippet) right after the submission (the relay waits one block; ruling 7), warp, execute via the
 * relay, sees the payment, claims a task the founder proposed and self-sponsored in one transaction
 * (ruling 4), delivers, the verifiers confirm via the relay, sees shares, ragequits, sees 0 shares.
 * A T0 (passphrase) agent joins, deposits, votes and ragequits with fetch-only URLs. Every request
 * and response is printed. One anvil at a time. Usage: npm run e2e:relay
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encodeErrorResult, getAddress, keccak256, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { loadLocalArtifact } from "../src/baal.js";
import { chooseFreePort, startDevnet, stopDevnet } from "../src/devnet.js";
import { connectDevnet, increaseTime, writeAndWait } from "../src/onchain.js";
import { DEFAULT_PARAMS, deployZeroOne, GENESIS_DEPOSIT, genesisDeposit, HOUR, SETTLEMENT_UNIT, UNIT } from "../src/zeroOne.js";
import { buildBeacon } from "../beacon/scripts/build.js";

import { decodeProposeIntentData, encodeParams } from "../src/proposals.js";
import { hardening } from "./e2e-hardening.js";
import { connect as connectRelay } from "./common.js";
import { decodeRevert } from "./errors.js";
import { INTENT_TYPES, intentDomain } from "./intents.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NO_PROXY = { ...process.env, no_proxy: "127.0.0.1,localhost", NO_PROXY: "127.0.0.1,localhost", HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "" };

let stepCounter = 0;
function step(title: string): void {
  stepCounter += 1;
  console.log(`\n== step ${stepCounter}: ${title}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.log(`   ASSERT FAILED: ${message}`);
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`   ok: ${message}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Print a URL with the long base64url parameters shortened. */
function shortUrl(url: string): string {
  return url.replace(/(intent|authorization)=([A-Za-z0-9_-]{24})[A-Za-z0-9_-]+/gu, "$1=$2...").replace(/pass=[^&]+/gu, "pass=<redacted>");
}

/** GET a relay URL, print and return the parsed JSON body. */
async function get(url: string, expectOk = true): Promise<Record<string, unknown>> {
  console.log(`   GET ${shortUrl(url)}`);
  const response = await fetch(url);
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`non-JSON response (${response.status}): ${text.slice(0, 300)}`);
  }
  console.log(`   -> ${response.status} ${JSON.stringify(body).slice(0, 1200)}`);
  if (expectOk) assert(body.ok === true, `relay answered ok (${String(body.reason ?? "")})`);
  else assert(body.ok === false && typeof body.reason === "string", `relay answered with a JSON reason: ${String(body.reason)}`);
  return body;
}

/** Run a T1 helper snippet and return the URL it prints (stdout); stderr is shown. */
function snippet(lang: "node" | "python", beacon: string, args: string[]): string {
  const command = lang === "node" ? ["node", path.join(beacon, "snippet.js"), ...args] : ["python3", path.join(beacon, "snippet.py"), ...args];
  console.log(`   $ ${lang === "node" ? "node snippet.js" : "python3 snippet.py"} ${args.map((a) => (a.includes(" ") || a.includes("{") ? JSON.stringify(a) : a)).join(" ")}`);
  const result = spawnSync(command[0]!, command.slice(1), { encoding: "utf8", env: NO_PROXY, cwd: beacon, timeout: 120_000 });
  if (result.stderr.trim()) console.log(`   stderr: ${result.stderr.trim().split("\n").join(" | ")}`);
  if (result.status !== 0) throw new Error(`${lang} snippet failed (${result.status}): ${result.stderr}`);
  const url = result.stdout.trim().split("\n").pop() ?? "";
  if (!url.startsWith("http")) throw new Error(`snippet printed no URL: ${result.stdout}`);
  return url;
}

async function waitForRelay(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`relay exited early (${child.exitCode})`);
    try {
      const response = await fetch(`${url}/health.json`);
      if (response.ok) return;
    } catch {
      // not yet listening
    }
    await sleep(150);
  }
  throw new Error("relay did not become healthy in 30 s");
}

async function main(): Promise<void> {
  const devnet = await startDevnet(`e2e-relay-${Date.now()}`, { hardfork: "prague" });
  let relay: ChildProcess | undefined;
  let passed = false;
  try {
    const chain = connectDevnet(devnet);
    const F = chain.contexts[0]!;
    const sponsorIndex = 15;
    const sponsorKey = devnet.privateKeys[sponsorIndex]!;
    const sponsorAddress = devnet.addresses[sponsorIndex]!;
    const settlementAbi = loadLocalArtifact("TestToken").abi;
    const sharesAbi = loadLocalArtifact("NavShareToken").abi;
    const usdcOf = async (address: Address): Promise<bigint> => (await chain.publicClient.readContract({ address: dao.settlement, abi: settlementAbi, functionName: "balanceOf", args: [address] })) as bigint;
    const sharesOf = async (address: Address): Promise<bigint> => (await chain.publicClient.readContract({ address: dao.shares, abi: sharesAbi, functionName: "balanceOf", args: [address] })) as bigint;

    /**
     * Ruling 7 on the mirror: a vote that follows a fresh submission is held by the relay until a block
     * with a later timestamp exists. Anvil mines only on transactions, so the E2E mines exactly one block
     * (clock +1 s) 1.5 s after sending the vote; the relay's answer must report `waitedBlocks: 1`.
     */
    const voteRightAfterSubmission = async (url: string, expectOk = true): Promise<Record<string, unknown>> => {
      const pending = get(url, expectOk);
      await sleep(1_500);
      await increaseTime(F, 1);
      const body = await pending;
      if (expectOk) assert(body.waitedBlocks === 1, "the relay waited exactly one block before sending a vote that followed a fresh submission (ruling 7)");
      return body;
    };

    step("deploy Zero One on a fresh anvil (prague) + genesis: founder deposits 50 USDC -> 50e18 shares");
    const dao = await deployZeroOne(F, { ...DEFAULT_PARAMS, founder: F.account.address });
    const genesis = await genesisDeposit(F, dao, GENESIS_DEPOSIT);
    console.log(`   anvil ${devnet.rpcUrl} chainId ${devnet.chainId}; safe ${dao.safe} baal ${dao.baal} adapter ${dao.intentAccount}; genesis ${genesis.depositHash}`);
    assert(genesis.sharesMinted === 50n * UNIT, "founder holds 50e18 shares = 100%");

    step("sponsor float: 10,000 test USDC to the relay sponsor (faucet for test chains); write the deployment record");
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
    console.log(`   deployment record ${deploymentFile}`);
    const refusal = decodeRevert(connectRelay(record), encodeErrorResult({ abi: loadLocalArtifact("DepositShaman").abi, errorName: "TreasuryNotSettled" }));
    assert(refusal?.name === "TreasuryNotSettled" && refusal.text.includes("settles the registered assets to USDC"), "relay decodes TreasuryNotSettled with the settlement-vote recovery reason");

    step("start the relay against the mirror (sponsor = anvil account 15)");
    const port = chooseFreePort(18_751);
    const origin = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, ["--import", "tsx", path.join(ROOT, "relay", "server.ts")], {
      cwd: ROOT,
      env: { ...NO_PROXY, ZERO_ONE_DEPLOYMENT: deploymentFile, RELAY_SPONSOR_KEY: sponsorKey, RELAY_PORT: String(port), RELAY_STATE_DIR: path.join(devnet.stateDir, "relay"), RELAY_LOG: "1", RELAY_RATE_ADDRESS: "1000", RELAY_RATE_IP: "10000" },
      stdio: ["ignore", "inherit", "inherit"],
    });
    await waitForRelay(origin, relay);
    const healthBody = (await (await fetch(`${origin}/health.json`)).json()) as Record<string, unknown>;
    console.log(`   health: ${JSON.stringify(healthBody).slice(0, 600)}`);
    assert(healthBody.alive === true && healthBody.adapter === dao.intentAccount, "relay is alive on the mirror with the deployed adapter");

    step("build and validate the beacon (README <= 44 lines, every address has code)");
    const beacon = path.join(devnet.stateDir, "beacon");
    await buildBeacon({ deployment: deploymentFile, origin, out: beacon });
    const validation = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "beacon/scripts/validate.ts"), "--deployment", deploymentFile, "--out", beacon], { encoding: "utf8", env: NO_PROXY });
    const count = spawnSync("wc", ["-l", path.join(beacon, "README.txt")], { encoding: "utf8" });
    const receipt = `$ beacon/scripts/validate.ts --deployment <mirror> --out <mirror-beacon>\n${validation.stdout}${validation.stderr}$ wc -l README.txt\n${count.stdout}`;
    mkdirSync(path.join(ROOT, "evidence/phase4"), { recursive: true });
    writeFileSync(path.join(ROOT, "evidence/phase4/beacon-validate.log"), receipt);
    console.log(receipt);
    assert(validation.status === 0 && JSON.parse(validation.stdout).result === "PASS", "beacon validator CLI produced PASS");
    assert(count.status === 0, "README line count command succeeds");
    const readme = readFileSync(path.join(beacon, "README.txt"), "utf8");
    console.log(`\n----- README.txt (${readme.trimEnd().split("\n").length} lines) -----\n${readme}----- end README.txt -----`);
    assert(readme.trimEnd().split("\n").length <= 44, "README.txt is at most 44 lines");
    for (const lang of ["node", "python"] as const) {
      const result = spawnSync(lang === "node" ? "node" : "python3", [path.join(beacon, lang === "node" ? "snippet.js" : "snippet.py"), "selftest"], { encoding: "utf8", env: NO_PROXY });
      assert(result.status === 0 && /PASS/u.test(result.stdout), `${lang} snippet selftest: ${result.stdout.trim()}`);
    }

    step("keys: a fresh T1 agent key (never funded with ETH) plus founder and verifier keys as 0600 files");
    const keys = path.join(devnet.stateDir, "keys");
    mkdirSync(keys, { recursive: true, mode: 0o700 });
    const agentKey = generatePrivateKey();
    const agent = privateKeyToAccount(agentKey);
    const keyFile = (name: string, key: Hex): string => {
      const file = path.join(keys, `${name}.key`);
      writeFileSync(file, `${key.slice(2)}\n`, { mode: 0o600 });
      return file;
    };
    const agentFile = keyFile("agent", agentKey);
    const founderFile = keyFile("founder", devnet.privateKeys[0]!);
    const v1 = getAddress(devnet.addresses[7]!);
    const v2 = getAddress(devnet.addresses[8]!);
    const v1File = keyFile("v1", devnet.privateKeys[7]!);
    const v2File = keyFile("v2", devnet.privateKeys[8]!);
    console.log(`   agent ${agent.address} (ETH balance ${await chain.publicClient.getBalance({ address: agent.address })}) founder ${F.account.address} verifiers ${v1} ${v2}`);

    step("T1 agent: join (node snippet.js join) -> delegation attached, nothing minted");
    const joined = await get(snippet("node", beacon, ["join", "--key", agentFile]));
    assert(joined.delegated === true && joined.shares === "0", "agent is delegated and holds 0 shares");
    const me1 = (await (await fetch(`${origin}/me/${agent.address}.json`)).json()) as Record<string, unknown>;
    console.log(`   /me: ${JSON.stringify(me1).slice(0, 700)}`);
    assert(me1.delegated === true && me1.nonce === "0" && me1.shares === "0", "/me shows delegated, nonce 0, 0 shares");

    step("T1 agent: deposit 100 USDC (deposit --usdc 100); the mirror faucet tops the agent up first");
    const deposited = await get(snippet("node", beacon, ["deposit", "--key", agentFile, "--usdc", "100"]));
    assert(String((deposited.deposit as { sharesMinted?: string })?.sharesMinted) === "100", "100 USDC at NAV 1 -> 100 shares");
    const me2 = (await (await fetch(`${origin}/me/${agent.address}.json`)).json()) as Record<string, unknown>;
    console.log(`   /me: shares ${me2.sharesFormatted} (${me2.percent}%) nav ${me2.navUsdcPerShare} exitValue ${me2.exitValueUsdc} usdc ${me2.usdcFormatted} nonce ${me2.nonce}`);
    assert(me2.sharesFormatted === "100" && me2.navUsdcPerShare === "1" && me2.exitValueUsdc === "100" && me2.nonce === "1", "/me: 100 shares, NAV 1 USDC/share, exit value 100 USDC, nonce 1");

    const state2 = (await (await fetch(`${origin}/state.json`)).json()) as { treasury: { settled: boolean; depositTreasury: string } };
    assert(me2.settled === true && me2.depositTreasury === (150n * SETTLEMENT_UNIT).toString(), "/me exposes settled and depositTreasury at the state block");
    assert(state2.treasury.settled === me2.settled && state2.treasury.depositTreasury === me2.depositTreasury, "/state.json exposes the same ledger deposit NAV as /me");

    step("founder: join via the relay (python3 snippet.py) before any proposal exists");
    await get(snippet("python", beacon, ["join", "--key", founderFile]));

    step("T1 agent: propose a Payment of 10 USDC to itself with ONE signed intent (propose --template Payment): op=quote (read-only) -> sign -> the relay deploys the CREATE2 instance -> the account submits fund+start of exactly that address");
    const paymentParams = JSON.stringify({ recipients: [agent.address], amounts: [(10n * SETTLEMENT_UNIT).toString()] });
    const quoteUrl = `${origin}/relay?op=quote&member=${agent.address}&template=Payment&params=${encodeURIComponent(paymentParams)}&summary=${encodeURIComponent("agent: pay me 10 USDC")}`;
    const quoted = await get(quoteUrl);
    assert(quoted.exists === false && typeof quoted.instance === "string" && typeof quoted.codeHash === "string" && quoted.canPropose === true, "quote: the instance address is known before deployment (exists: false), with its code hash");
    const proposed = await get(snippet("node", beacon, ["propose", "--key", agentFile, "--template", "Payment", "--params", paymentParams, "--summary", "agent: pay me 10 USDC"]));
    const proposal1 = Number(proposed.proposalId);
    assert(proposal1 === 1 && proposed.sponsored === true, "proposal #1 submitted and self-sponsored (agent holds >= 1 share) in one intent");
    assert(proposed.deployedBy === "relay sponsor" && typeof proposed.deployHash === "string" && getAddress(String(proposed.instance)) === getAddress(String(quoted.instance)), "the relay deployed the instance at the quoted CREATE2 address before the intent (sponsored, member >= 1 share)");
    const instanceCode = await chain.publicClient.getCode({ address: getAddress(String(proposed.instance)) });
    assert(instanceCode !== undefined && keccak256(instanceCode) === quoted.codeHash, "the code hash quoted before deployment equals keccak256 of the code now at the address");
    const proposalsBody = (await (await fetch(`${origin}/proposals.json`)).json()) as { proposals: Array<Record<string, unknown>> };
    const p1 = proposalsBody.proposals.find((p) => p.id === 1)!;
    console.log(`   /proposals.json #1: state ${p1.state} effect "${(p1.treasuryEffect as { summary: string }).summary}" instance ${JSON.stringify(p1.instance).slice(0, 300)}`);
    assert(p1.state === "Voting" && (p1.treasuryEffect as { usdcOut: string }).usdcOut === (10n * SETTLEMENT_UNIT).toString(), "proposal #1 is Voting with treasury effect 10 USDC out");
    assert((p1.instance as { template: string; status: string; operator: string }).template === "Payment" && (p1.instance as { status: string }).status === "Pending" && getAddress((p1.instance as { operator: string }).operator) === agent.address, "instance is a Pending Payment whose operator is the agent");
    assert(p1.proposalData === quoted.proposalData && String(p1.details).includes(String(quoted.codeHash)) && String(p1.details).includes(String(quoted.paramsHash)), "the proposalData the account built on-chain equals the quoted (off-chain) multicall; details carry codeHash and paramsHash");
    const quotedAgain = await get(quoteUrl.replace(/&summary=.*$/u, `&summary=x&salt=${String(quoted.salt)}`));
    assert(quotedAgain.exists === true && getAddress(String(quotedAgain.instance)) === getAddress(String(quoted.instance)) && quotedAgain.codeHash === quoted.codeHash, "quoting the same (template, params, member, salt) again finds the deployed instance (deterministic address)");
    const signedData = decodeProposeIntentData((JSON.parse(Buffer.from(new URL(snippet("node", beacon, ["propose", "--key", agentFile, "--template", "Payment", "--params", paymentParams, "--summary", "x"])).searchParams.get("intent")!, "base64url").toString()) as { message: { data: Hex } }).message.data);
    assert(signedData.template === "Payment" && signedData.paramsBytes === encodeParams({ template: "Payment", params: { recipients: [agent.address], amounts: [10n * SETTLEMENT_UNIT] } }), "the signed intent carries only the template id, the exact abi.encode(params) and a salt (nothing the relay chose)");

    step("founder votes YES on #1 right after the submission (python3 snippet.py): the relay waits one block (ruling 7)");
    const founderVote = await voteRightAfterSubmission(snippet("python", beacon, ["vote", "--key", founderFile, "--proposal", "1", "--approve", "yes"]));
    assert((founderVote.vote as { approved: boolean; shares: string }).approved === true && (founderVote.vote as { shares: string }).shares === "50", "founder voted YES with 50 shares");

    step("warp past voting + grace (12 h); T1 agent executes #1 via the relay (explicit 5,000,000 gas)");
    await increaseTime(F, 12 * HOUR + 5);
    await sleep(2_500);
    const executed = await get(snippet("node", beacon, ["execute", "--key", agentFile, "--proposal", "1"]));
    const processed = executed.processed as { passed: boolean; actionFailed: boolean };
    assert(processed.passed === true && processed.actionFailed === false, "proposal #1 passed and its action executed (fund + start)");
    const me3 = (await (await fetch(`${origin}/me/${agent.address}.json`)).json()) as Record<string, unknown>;
    console.log(`   /me: usdc ${me3.usdcFormatted} shares ${me3.sharesFormatted} nav ${me3.navUsdcPerShare} exitValue ${me3.exitValueUsdc}`);
    assert(me3.usdcFormatted === "10", "the agent sees the 10 USDC payment");
    assert((await usdcOf(dao.safe)) === 140n * SETTLEMENT_UNIT, "the Safe holds 140 USDC (50 + 100 - 10)");

    step("founder proposes a task via the relay (work: verifiers V1,V2 threshold 2, reward 5 shares): submitTask + sponsorProposal in ONE transaction (ruling 4); founder votes right after (relay waits one block); agent votes; warp; agent executes");
    const task = await get(snippet("python", beacon, ["work", "--key", founderFile, "--verifiers", `${v1},${v2}`, "--threshold", "2", "--reward-shares", (5n * UNIT).toString(), "--details", "ops: run the relay e2e"]));
    const taskInfo = task.task as { taskId: number; proposalId: number };
    assert(taskInfo.taskId === 1 && taskInfo.proposalId === 2, "task #1 recorded, proposal #2 submitted");
    assert(task.sponsored === true, "the same transaction sponsored #2 (SponsorProposal event): no ninth verb");
    const p2 = ((await (await fetch(`${origin}/proposals.json`)).json()) as { proposals: Array<Record<string, unknown>> }).proposals.find((p) => p.id === 2)!;
    assert(p2.state === "Voting" && getAddress(String(p2.sponsor)) === F.account.address, "proposal #2 is Voting, sponsored by the founder's own account");
    await voteRightAfterSubmission(snippet("python", beacon, ["vote", "--key", founderFile, "--proposal", "2", "--approve", "yes"]));
    const agentVote2 = await get(snippet("node", beacon, ["vote", "--key", agentFile, "--proposal", "2", "--approve", "yes"]));
    assert(agentVote2.waitedBlocks === 0, "a vote after a later block exists is sent at once (waitedBlocks 0)");
    await increaseTime(F, 12 * HOUR + 5);
    await sleep(2_500);
    const activated = await get(snippet("node", beacon, ["execute", "--key", agentFile, "--proposal", "2"]));
    assert((activated.processed as { passed: boolean; actionFailed: boolean }).passed === true && (activated.processed as { actionFailed: boolean }).actionFailed === false, "task proposal executed: task #1 active");

    step("T1 agent: claim task #1 (task --task 1) and deliver evidence; verifiers confirm via the relay (python); reward mints at the threshold");
    const claimed = await get(snippet("node", beacon, ["task", "--key", agentFile, "--task", "1"]));
    assert((claimed.claimed as { taskId: number }).taskId === 1, "agent claimed task #1");
    const evidence = "done: relay e2e delivered";
    const delivered = await get(snippet("node", beacon, ["deliver", "--key", agentFile, "--task", "1", "--evidence", evidence]));
    assert((delivered.delivered as { round: number }).round === 1, "delivery round 1 committed");
    const me4 = (await (await fetch(`${origin}/me/${agent.address}.json`)).json()) as { myTasks: Array<{ taskId: number; pending: string[] }> };
    console.log(`   /me myTasks: ${JSON.stringify(me4.myTasks).slice(0, 400)}`);
    assert(me4.myTasks[0]?.pending[0]?.startsWith("awaiting verification (0/2)") === true, "/me shows the delivery awaiting verification");
    await get(snippet("python", beacon, ["join", "--key", v1File]));
    const confirm1 = await get(snippet("python", beacon, ["confirm", "--key", v1File, "--task", "1", "--evidence", evidence]));
    assert((confirm1.confirmed as { confirmations: number }).confirmations === 1 && confirm1.verified === undefined, "first confirmation: nothing minted yet");
    await get(snippet("python", beacon, ["join", "--key", v2File]));
    const confirm2 = await get(snippet("python", beacon, ["confirm", "--key", v2File, "--task", "1", "--evidence", evidence]));
    assert((confirm2.verified as { rewardShares: string }).rewardShares === "5", "second confirmation mints exactly 5 shares to the worker");
    const me5 = (await (await fetch(`${origin}/me/${agent.address}.json`)).json()) as Record<string, unknown>;
    console.log(`   /me: shares ${me5.sharesFormatted} (${me5.percent}%) exitValue ${me5.exitValueUsdc}`);
    assert(me5.sharesFormatted === "105", "the agent sees 105 shares");

    step("T0 agent (passphrase, fetch only): identity, join, deposit 20 USDC");
    const pass = Buffer.from(generatePrivateKey().slice(2), "hex").toString("base64url");
    const t0 = await get(`${origin}/relay?op=identity&pass=${encodeURIComponent(pass)}`);
    const t0Address = getAddress(String(t0.address));
    const t0Join = await get(`${origin}/relay?op=join&pass=${encodeURIComponent(pass)}`);
    assert(t0Join.delegated === true, "T0 account delegated");
    const t0Deposit = await get(`${origin}/relay?op=deposit&amount=${20n * SETTLEMENT_UNIT}&pass=${encodeURIComponent(pass)}`);
    const t0Shares = await sharesOf(t0Address);
    console.log(`   T0 deposit -> ${(t0Deposit.deposit as { sharesMinted: string }).sharesMinted} shares (raw ${t0Shares})`);
    assert(t0Shares > 0n && t0Shares === (20n * SETTLEMENT_UNIT * (155n * UNIT)) / (140n * SETTLEMENT_UNIT), "T0 received 20 x 155 / 140 shares at NAV");
    const t0Me = (await (await fetch(`${origin}${String(t0.me)}`)).json()) as Record<string, unknown>;
    console.log(`   /me/pass: custody ${t0Me.custody} shares ${t0Me.sharesFormatted} nonce ${t0Me.nonce}`);
    assert(t0Me.custody === "custodial-lite" && BigInt(String(t0Me.shares)) === t0Shares, "/me/pass/<sha256> reports the T0 shares");

    step("T1 agent proposes Payment #2 (1 USDC to the T0 address); T0 votes YES then ragequits during voting (allowed); T0 sees 0 shares");
    const p2Params = JSON.stringify({ recipients: [t0Address], amounts: [SETTLEMENT_UNIT.toString()] });
    const proposed2 = await get(snippet("node", beacon, ["propose", "--key", agentFile, "--template", "Payment", "--params", p2Params, "--summary", "agent: 1 USDC to the T0 agent"]));
    assert(Number(proposed2.proposalId) === 3 && proposed2.deployedBy === "relay sponsor", "proposal #3 submitted; its instance deployed by the sponsor at the CREATE2 address");
    const t0Vote = await voteRightAfterSubmission(`${origin}/relay?op=vote&proposalId=3&approve=yes&pass=${encodeURIComponent(pass)}`);
    assert((t0Vote.vote as { approved: boolean }).approved === true, "T0 voted YES on #3");
    const t0Usdc = await usdcOf(t0Address);
    const t0Exit = await get(`${origin}/relay?op=ragequit&pass=${encodeURIComponent(pass)}`);
    assert((t0Exit.ragequit as { sharesBurned: string }) !== undefined && (await sharesOf(t0Address)) === 0n, "T0 ragequit all shares");
    console.log(`   T0 usdc ${t0Usdc} -> ${await usdcOf(t0Address)}`);
    assert((await usdcOf(t0Address)) > t0Usdc, "T0 received its pro-rata USDC");
    const t0Me2 = (await (await fetch(`${origin}${String(t0.me)}`)).json()) as Record<string, unknown>;
    assert(t0Me2.shares === "0", "/me/pass shows 0 shares after ragequit");

    step("T1 agent ragequits all shares; sees 0 shares and its pro-rata USDC");
    const agentUsdcBefore = await usdcOf(agent.address);
    const treasuryBefore = await usdcOf(dao.safe);
    const supplyBefore = (await chain.publicClient.readContract({ address: dao.shares, abi: sharesAbi, functionName: "totalSupply" })) as bigint;
    const exited = await get(snippet("node", beacon, ["ragequit", "--key", agentFile]));
    assert((exited.ragequit as { sharesBurned: string }).sharesBurned === "105", "105 shares burned");
    const expectedPayout = (105n * UNIT * treasuryBefore) / supplyBefore;
    const paid = (await usdcOf(agent.address)) - agentUsdcBefore;
    console.log(`   paid ${paid} (expected ${expectedPayout}) from treasury ${treasuryBefore} at supply ${supplyBefore}`);
    assert(paid === expectedPayout, "the agent received exactly its pro-rata of the Safe");
    const me6 = (await (await fetch(`${origin}/me/${agent.address}.json`)).json()) as Record<string, unknown>;
    console.log(`   /me: shares ${me6.sharesFormatted} usdc ${me6.usdcFormatted} nonce ${me6.nonce}`);
    assert(me6.shares === "0", "/me shows 0 shares");

    step("readable failures: every rejected request carries a JSON reason (decoded custom error / Baal string), never a bare revert");
    const early = await get(snippet("node", beacon, ["execute", "--key", agentFile, "--proposal", "3"]), false);
    assert(String(early.reason).includes("not ready") && (early.error as { args: { message: string } })?.args.message === "!ready", "execute before grace -> 422 with Baal '!ready' decoded");
    const twice = await get(`${origin}/relay?op=vote&proposalId=3&approve=no&pass=${encodeURIComponent(pass)}`, false);
    assert(String(twice.reason).includes("already voted"), "T0 voting twice -> 'voted' decoded");
    const reclaim = await get(snippet("node", beacon, ["task", "--key", agentFile, "--task", "1"]), false);
    assert((reclaim.error as { name: string })?.name === "WrongStatus", "claiming a completed task -> custom error WrongStatus decoded with its arguments");
    const badDeposit = await get(snippet("python", beacon, ["deposit", "--key", v1File, "--amount", "0"]), false);
    assert((badDeposit.error as { name: string })?.name === "ZeroAmount", "deposit 0 -> DepositShaman.ZeroAmount decoded");
    const badTemplate = await get(`${origin}/relay?op=propose&template=Bogus&params=%7B%7D&pass=${encodeURIComponent(pass)}`, false);
    assert(String(badTemplate.reason).includes("unknown template"), "unknown template -> 400 with a reason");
    const noShares = await get(snippet("python", beacon, ["propose", "--key", v1File, "--template", "Payment", "--params", paymentParams, "--summary", "v1: no shares"]), false);
    assert(noShares.status === 409 && /at least 1 shares/u.test(String(noShares.reason)), "propose by a member below sponsorThreshold -> 409 (no sponsored deployment, no unsponsorable proposal)");
    const ninth = await get(`${origin}/relay?op=sponsor&proposalId=3&pass=${encodeURIComponent(pass)}`, false);
    assert(ninth.status === 400 && /unknown op sponsor/u.test(String(ninth.reason)), "op=sponsor no longer exists -> 400");
    const retired = await get(`${origin}/relay?op=prepare&member=${F.account.address}&template=Payment&params=${encodeURIComponent(paymentParams)}`, false);
    assert(retired.status === 400, "op=prepare is retired -> 400");
    const badQuote = await get(`${origin}/relay?op=quote&member=${F.account.address}&template=Payment&params=${encodeURIComponent(JSON.stringify({ recipients: [F.account.address], amounts: ["0"] }))}`, false);
    assert((badQuote.error as { name: string })?.name === "ZeroAmount", "quote with a zero payment -> the template constructor's ZeroAmount decoded from the factory dry run");

    step("cross-check: node, python and viem produce byte-identical signatures for the same intent (deterministic RFC 6979)");
    const founderMe = (await (await fetch(`${origin}/me/${F.account.address}.json`)).json()) as { nonce: string; chainTime: number };
    const deadline = String(founderMe.chainTime + 600);
    const jsUrl = snippet("node", beacon, ["vote", "--key", founderFile, "--proposal", "3", "--approve", "no", "--deadline", deadline]);
    const pyUrl = snippet("python", beacon, ["vote", "--key", founderFile, "--proposal", "3", "--approve", "no", "--deadline", deadline]);
    const jsEnvelope = JSON.parse(Buffer.from(new URL(jsUrl).searchParams.get("intent")!, "base64url").toString()) as { message: Record<string, unknown>; signature: Hex };
    const pyEnvelope = JSON.parse(Buffer.from(new URL(pyUrl).searchParams.get("intent")!, "base64url").toString()) as { message: Record<string, unknown>; signature: Hex };
    assert(jsEnvelope.signature === pyEnvelope.signature && JSON.stringify(jsEnvelope.message) === JSON.stringify(pyEnvelope.message), "node and python snippets sign identically");
    const viemSignature = await F.account.signTypedData({ domain: intentDomain(dao.intentAccount, devnet.chainId), types: INTENT_TYPES, primaryType: "Intent", message: { member: F.account.address, op: 2, proposalId: 3, amount: 0n, evidenceHash: `0x${"0".repeat(64)}`, data: "0x", details: "", nonce: BigInt(founderMe.nonce), deadline: BigInt(deadline) } });
    assert(viemSignature === jsEnvelope.signature, "viem's EIP-712 signature equals the snippets' (same digest, same key)");

    step("phase 3 two-process concurrency, duplicate intents, restart cursor and killed broadcaster recovery");
    await hardening({ deploymentFile, stateDir: path.join(devnet.stateDir, "relay"), sponsorKey, origin, client: chain.publicClient, adapter: dao.intentAccount, settlement: dao.settlement, safe: dao.safe, shares: dao.shares, chainId: devnet.chainId });
    passed = true;
  } finally {
    console.log(`\n=== RELAY E2E: ${passed ? "PASS" : "FAIL"} ===\n`);
    if (relay !== undefined && relay.exitCode === null) await new Promise<void>((resolve) => { relay!.once("exit", () => resolve()); relay!.kill("SIGTERM"); });
    await stopDevnet(devnet);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
