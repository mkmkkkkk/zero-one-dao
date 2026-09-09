/**
 * Component 5 audit — relay adversarial probes against a real relay/server.ts on a fresh anvil.
 *
 * Boots a mirror DAO + genesis, writes a deployment record, and runs the actual relay process, then
 * drives it over HTTP as an attacker would:
 *   F1  the per-IP rate limit keys on the client-supplied `cf-connecting-ip` header, so any caller
 *       who is not really behind Cloudflare (direct hit, or a spoofed header) mints unlimited buckets.
 *   F2  `op=identity&pass=` is an unauthenticated, deterministic oracle: it returns the address a
 *       passphrase controls with no on-chain cost, so a funded T0 account with a low-entropy pass is
 *       brute-forceable online (the only floor is 32 characters; there is no entropy check).
 *   F4  the T0 key is HMAC-SHA256(service secret, "zero-one-t0-v1:"+pass); reading state/relay/secret
 *       and the pass reproduces the exact key, i.e. the relay (or anyone with the secret) can sign any
 *       intent for every T0 account.
 * Usage: npx tsx evidence/audit/account-relay/relay-adversarial.test.ts
 */
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { privateKeyToAccount } from "viem/accounts";

import { startDevnet, stopDevnet } from "../../../src/devnet.js";
import { connectDevnet, writeAndWait } from "../../../src/onchain.js";
import { loadLocalArtifact } from "../../../src/baal.js";
import { DEFAULT_PARAMS, deployZeroOne, GENESIS_DEPOSIT, genesisDeposit, SETTLEMENT_UNIT, UNIT } from "../../../src/zeroOne.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NO_PROXY = { ...process.env, no_proxy: "127.0.0.1,localhost", NO_PROXY: "127.0.0.1,localhost", HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "" };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** GET a URL with optional headers; returns {status, body}. */
async function getRaw(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body };
}

async function waitForRelay(origin: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`relay exited early (${child.exitCode})`);
    try {
      const response = await fetch(`${origin}/health.json`);
      if (response.ok) return;
    } catch {
      // not yet listening
    }
    await sleep(150);
  }
  throw new Error("relay did not become healthy in 30 s");
}

async function main(): Promise<void> {
  const devnet = await startDevnet(`audit-relay-${Date.now()}`, { hardfork: "prague" });
  let relay: ChildProcess | undefined;
  try {
    const chain = connectDevnet(devnet);
    const F = chain.contexts[0]!;
    const settlementAbi = loadLocalArtifact("TestToken").abi;
    const dao = await deployZeroOne(F, { ...DEFAULT_PARAMS, founder: F.account.address });
    const genesis = await genesisDeposit(F, dao, GENESIS_DEPOSIT);
    assert.equal(genesis.sharesMinted, 50n * UNIT, "genesis 50e18 shares");

    const sponsorIndex = 15;
    const sponsorKey = devnet.privateKeys[sponsorIndex]!;
    const sponsorAddress = devnet.addresses[sponsorIndex]!;
    const float = await F.publicClient.simulateContract({ address: dao.settlement, abi: settlementAbi, functionName: "transfer", args: [sponsorAddress, 10_000n * SETTLEMENT_UNIT], account: F.account } as never);
    await writeAndWait(F, float.request as unknown as Record<string, unknown>);

    const stateDir = path.join(devnet.stateDir, "relay");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const record = {
      rpcUrl: devnet.rpcUrl,
      chainId: devnet.chainId,
      startBlock: Number(dao.startBlock),
      deployer: F.account.address,
      founder: dao.params.founder,
      settlement: dao.settlement,
      safe: dao.safe,
      baal: dao.baal,
      shares: dao.shares,
      loot: dao.loot,
      depositShaman: dao.depositShaman,
      workManager: dao.workManager,
      templateFactory: dao.templateFactory,
      templateDeployers: dao.templateDeployers,
      intentAccount: dao.intentAccount,
      constitution: { address: dao.constitution, textHash: dao.constitutionHash, textUrl: dao.constitutionTextUrl },
      governance: {
        votingPeriod: dao.params.governance.votingPeriod,
        gracePeriod: dao.params.governance.gracePeriod,
        proposalOffering: dao.params.governance.proposalOffering.toString(),
        quorumPercent: dao.params.governance.quorumPercent.toString(),
        sponsorThreshold: dao.params.governance.sponsorThreshold.toString(),
        minRetentionPercent: dao.params.governance.minRetentionPercent.toString(),
      },
    };
    const recordFile = path.join(devnet.stateDir, "deployment.json");
    writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);

    const port = 18_900 + (devnet.port % 500);
    const origin = `http://127.0.0.1:${port}`;
    relay = spawn("npx", ["tsx", "relay/server.ts"], {
      cwd: ROOT,
      env: { ...NO_PROXY, RELAY_SPONSOR_KEY: sponsorKey, RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1", RELAY_STATE_DIR: stateDir, ZERO_ONE_DEPLOYMENT: recordFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    relay.stderr?.on("data", (d: Buffer) => process.stderr.write(`[relay] ${d}`));
    await waitForRelay(origin, relay);
    console.log(`relay up at ${origin}; default per-IP rate = 30/min`);

    // ---------- F1: the per-IP rate limit is inert on rejected paths, and keyed on a spoofable header ----------
    console.log("\n== F1 the per-IP rate limit (default 30/min) does not fire and is keyed on cf-connecting-ip");
    // 40 rejected /relay requests from ONE fixed IP. With a working 30/min limit, >=10 should be 429.
    let blockedFixed = 0;
    for (let i = 0; i < 40; i += 1) {
      const { status } = await getRaw(`${origin}/relay?op=quote`, { "cf-connecting-ip": "203.0.113.7" });
      if (status === 429) blockedFixed += 1;
    }
    console.log(`   40 rejected requests from a single IP -> ${blockedFixed} answered 429 (a 30/min limit would block >=10)`);
    assert.equal(blockedFixed, 0, "the per-IP limit never fires for rejected requests");
    // Why: rate() mutates db.rates in memory but never persist()s on a rejected path, and every request
    // begins with reload()+recoverJournal() which rewrites db.json from the pre-increment state, so the
    // counter is discarded each request. Confirm the on-disk counter is stuck near 0 despite 40 hits.
    await sleep(200);
    const dbAfter = JSON.parse(readFileSync(path.join(stateDir, "db.json"), "utf8")) as { rates: Record<string, { n: number }> };
    const ipBucket = dbAfter.rates["ip:203.0.113.7"]?.n ?? 0;
    console.log(`   db.json rates["ip:203.0.113.7"].n = ${ipBucket} after 40 requests (increments were discarded by reload)`);
    assert(ipBucket <= 1, `the persisted per-IP counter (${ipBucket}) did not track the 40 requests`);
    // And the key itself is the client-supplied cf-connecting-ip, so even a working limit is one header away from bypass.
    const rotated = await getRaw(`${origin}/relay?op=quote`, { "cf-connecting-ip": "198.51.100.42" });
    console.log(`   the bucket key is the caller's cf-connecting-ip header (spoofable when not truly behind Cloudflare); e.g. 198.51.100.42 -> status ${rotated.status}`);

    // ---------- F2: op=identity is a free deterministic oracle ----------
    console.log("\n== F2 op=identity&pass= reveals the controlled address with no cost or entropy floor");
    const passOracle = "correct horse battery staple correct horse!"; // 44 chars, low entropy, > 32-char minimum
    const idA = await getRaw(`${origin}/relay?op=identity&pass=${encodeURIComponent(passOracle)}`, { "cf-connecting-ip": "10.0.0.1" });
    assert.equal(idA.status, 200, "identity is served");
    assert.equal(idA.body.ok, true, "identity ok");
    const addrA = String(idA.body.address);
    const idA2 = await getRaw(`${origin}/relay?op=identity&pass=${encodeURIComponent(passOracle)}`, { "cf-connecting-ip": "10.0.0.2" });
    assert.equal(String(idA2.body.address), addrA, "same passphrase -> same address (deterministic)");
    const idB = await getRaw(`${origin}/relay?op=identity&pass=${encodeURIComponent(passOracle + "x")}`, { "cf-connecting-ip": "10.0.0.3" });
    assert.notEqual(String(idB.body.address), addrA, "a different passphrase -> a different address");
    console.log(`   pass "${passOracle.slice(0, 20)}..." -> ${addrA} (deterministic, delegated=${idA.body.delegated})`);
    console.log(`   the oracle needs no join, no signature, no funds, and is per-IP throttled only (see F1)`);

    // ---------- F4: T0 key = HMAC(secret, "zero-one-t0-v1:"+pass) ----------
    console.log("\n== F4 the relay's secret fully determines every T0 private key");
    const secretHex = readFileSync(path.join(stateDir, "secret"), "utf8").trim();
    const secret = Buffer.from(secretHex, "hex");
    const derivedKey = `0x${createHmac("sha256", secret).update(`zero-one-t0-v1:${passOracle}`).digest("hex")}` as `0x${string}`;
    const derivedAddress = privateKeyToAccount(derivedKey).address;
    assert.equal(derivedAddress.toLowerCase(), addrA.toLowerCase(), "recomputed key matches the relay's T0 address");
    console.log(`   secret (state/relay/secret) + pass reproduces the exact key -> ${derivedAddress}`);
    console.log(`   whoever holds this 32-byte secret can sign ANY intent (propose/vote/ragequit) for EVERY T0 account`);
    // Sanity: a random secret would NOT reproduce it (the secret is the whole custody).
    const otherAddr = privateKeyToAccount(`0x${createHmac("sha256", randomBytes(32)).update(`zero-one-t0-v1:${passOracle}`).digest("hex")}` as `0x${string}`).address;
    assert.notEqual(otherAddr.toLowerCase(), addrA.toLowerCase(), "a different secret yields a different key (secret is the custody)");

    console.log("\nRELAY ADVERSARIAL PROBES COMPLETE (F1 bypass demonstrated; F2 oracle demonstrated; F4 custody reproduced)");
  } finally {
    if (relay && relay.exitCode === null) relay.kill("SIGTERM");
    await stopDevnet(devnet);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
