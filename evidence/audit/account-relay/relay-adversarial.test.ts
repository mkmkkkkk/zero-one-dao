/**
 * Component 5 audit — relay adversarial probes against a real relay/server.ts on a fresh anvil.
 *
 * Boots a mirror DAO + genesis, writes a deployment record, and runs the actual relay process, then
 * drives it over HTTP as an attacker would:
 *   F1  A5-09, FIXED (phase 5 ruling 9): the per-IP rate limit fires and its counter is on disk before
 *       the rejection, so the reload() at the head of the next request no longer discards it. The bucket
 *       key is still the caller-supplied `cf-connecting-ip` header: the relay must sit behind Cloudflare
 *       (or answer only on loopback), which is the documented deployment (docs/RELAY.md).
 *   F2  A5-08, FIXED (phase 5 ruling 9): `op=identity&pass=` is still a free deterministic oracle, but a
 *       pass below 128 bits of estimated entropy is refused before any address is revealed, so the
 *       audit's own vector (a 44-character sentence) can no longer be mapped to an account, let alone
 *       signed for. High-entropy passes (32 random bytes) still resolve deterministically.
 *   F4  A5-07, UNCHANGED BY DESIGN: the T0 key is HMAC-SHA256(service secret, "zero-one-t0-v1:"+pass);
 *       reading state/relay/secret and the pass reproduces the exact key, i.e. the relay (or anyone with
 *       the secret) can sign any intent for every T0 account. That is what custodial-lite means; phase 5
 *       ruling 7 answers it with disclosure (README "T0: the relay operator can delay or drop your
 *       intents ...; the relay's secret is every T0 key") rather than with code, and T1 is the key-holding
 *       path. Asserted here as the documented behaviour.
 * Usage: npx tsx evidence/audit/account-relay/relay-adversarial.test.ts
 */
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { privateKeyToAccount } from "viem/accounts";

import { PASS_ENTROPY_FLOOR, passEntropyBits } from "../../../relay/pass.js";
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

    // ---------- F1: the per-IP rate limit fires, and its counter survives the next reload ----------
    console.log("\n== F1 the per-IP rate limit (default 30/min) fires and is persisted before the rejection");
    // 40 rejected /relay requests from ONE fixed IP. With a working 30/min limit, >= 10 must be 429.
    let blockedFixed = 0;
    for (let i = 0; i < 40; i += 1) {
      const { status } = await getRaw(`${origin}/relay?op=quote`, { "cf-connecting-ip": "203.0.113.7" });
      if (status === 429) blockedFixed += 1;
    }
    console.log(`   40 rejected requests from a single IP -> ${blockedFixed} answered 429 (a 30/min limit blocks >= 10)`);
    assert.equal(blockedFixed, 10, "the per-IP limit rejects every request after the 30th in the window");
    // rate() now writes the incremented bucket to db.json before it can throw, so the reload() +
    // recoverJournal() at the head of the next request reads the counter back instead of resetting it.
    await sleep(200);
    const dbAfter = JSON.parse(readFileSync(path.join(stateDir, "db.json"), "utf8")) as { rates: Record<string, { n: number }> };
    const ipBucket = dbAfter.rates["ip:203.0.113.7"]?.n ?? 0;
    console.log(`   db.json rates["ip:203.0.113.7"].n = ${ipBucket} after 40 requests (every request counted, rejected ones included)`);
    assert.equal(ipBucket, 40, `the persisted per-IP counter (${ipBucket}) tracked all 40 requests`);
    // The key itself is still the client-supplied cf-connecting-ip: a caller that is not behind
    // Cloudflare mints a fresh bucket per header value. Documented deployment constraint, not a fix.
    const rotated = await getRaw(`${origin}/relay?op=quote`, { "cf-connecting-ip": "198.51.100.42" });
    console.log(`   a different cf-connecting-ip is a different bucket (198.51.100.42 -> status ${rotated.status}): the relay must sit behind Cloudflare or on loopback (docs/RELAY.md)`);
    assert.notEqual(rotated.status, 429, "a fresh bucket key is not rate-limited (the header is the trust boundary)");

    // ---------- F2: the oracle is still free, but a guessable pass no longer has an account ----------
    console.log("\n== F2 op=identity&pass= refuses a pass below the 128-bit entropy floor before revealing anything");
    const weakPass = "correct horse battery staple correct horse!"; // 44 chars, low entropy, > 32-char minimum
    console.log(`   estimator: "${weakPass}" -> ${passEntropyBits(weakPass).toFixed(1)} bits (floor ${PASS_ENTROPY_FLOOR})`);
    assert(passEntropyBits(weakPass) < PASS_ENTROPY_FLOOR, "the audit's vector is below the floor");
    const refused = await getRaw(`${origin}/relay?op=identity&pass=${encodeURIComponent(weakPass)}`, { "cf-connecting-ip": "10.0.0.1" });
    console.log(`   -> ${refused.status} ${String(refused.body.reason).slice(0, 150)}`);
    assert.equal(refused.status, 400, "a guessable pass is refused");
    assert.equal(refused.body.address, undefined, "no address is revealed for a refused pass: the enumeration oracle has nothing to enumerate");
    assert.match(String(refused.body.reason), /bits of entropy, below the 128-bit floor/u, "the reason names the floor");
    // Every T0 verb goes through the same derivation, so the weak pass cannot act either.
    const refusedJoin = await getRaw(`${origin}/relay?op=join&pass=${encodeURIComponent(weakPass)}`, { "cf-connecting-ip": "10.0.0.2" });
    assert.equal(refusedJoin.status, 400, "op=join with the weak pass is refused too (the floor is in the key derivation)");
    const strongPass = randomBytes(32).toString("base64url");
    console.log(`   estimator: 32 random bytes as base64url -> ${passEntropyBits(strongPass).toFixed(1)} bits`);
    const idA = await getRaw(`${origin}/relay?op=identity&pass=${encodeURIComponent(strongPass)}`, { "cf-connecting-ip": "10.0.0.3" });
    assert.equal(idA.status, 200, "a high-entropy pass is served");
    assert.equal(idA.body.ok, true, "identity ok");
    const addrA = String(idA.body.address);
    const idA2 = await getRaw(`${origin}/relay?op=identity&pass=${encodeURIComponent(strongPass)}`, { "cf-connecting-ip": "10.0.0.4" });
    assert.equal(String(idA2.body.address), addrA, "same passphrase -> same address (deterministic)");
    const idB = await getRaw(`${origin}/relay?op=identity&pass=${encodeURIComponent(randomBytes(32).toString("base64url"))}`, { "cf-connecting-ip": "10.0.0.5" });
    assert.notEqual(String(idB.body.address), addrA, "a different passphrase -> a different address");
    console.log(`   strong pass -> ${addrA} (deterministic, delegated=${idA.body.delegated}); guessing now costs the full 128 bits, not a dictionary`);

    // ---------- F4: T0 key = HMAC(secret, "zero-one-t0-v1:"+pass) ----------
    console.log("\n== F4 the relay's secret fully determines every T0 private key");
    const secretHex = readFileSync(path.join(stateDir, "secret"), "utf8").trim();
    const secret = Buffer.from(secretHex, "hex");
    const derivedKey = `0x${createHmac("sha256", secret).update(`zero-one-t0-v1:${strongPass}`).digest("hex")}` as `0x${string}`;
    const derivedAddress = privateKeyToAccount(derivedKey).address;
    assert.equal(derivedAddress.toLowerCase(), addrA.toLowerCase(), "recomputed key matches the relay's T0 address");
    console.log(`   secret (state/relay/secret) + pass reproduces the exact key -> ${derivedAddress}`);
    console.log(`   whoever holds this 32-byte secret can sign ANY intent (propose/vote/ragequit) for EVERY T0 account`);
    // Sanity: a random secret would NOT reproduce it (the secret is the whole custody).
    const otherAddr = privateKeyToAccount(`0x${createHmac("sha256", randomBytes(32)).update(`zero-one-t0-v1:${strongPass}`).digest("hex")}` as `0x${string}`).address;
    assert.notEqual(otherAddr.toLowerCase(), addrA.toLowerCase(), "a different secret yields a different key (secret is the custody)");

    console.log("\n=== AUDIT TEST relay-adversarial: A5-09 and A5-08 FIXED (F1 limit fires and persists; F2 weak pass refused), A5-07 documented custody reproduced (F4) ===");
  } finally {
    if (relay && relay.exitCode === null) relay.kill("SIGTERM");
    await stopDevnet(devnet);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
