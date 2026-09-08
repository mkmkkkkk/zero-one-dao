/** Real relay processes share a state directory; all RPC writes here target the supplied local anvil. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { connectDevnet } from "../src/onchain.js";
import { chooseFreePort } from "../src/devnet.js";
import { loadLocalArtifact } from "../src/baal.js";
import { policyFor, ROOT } from "./common.js";
import { buildIntent, INTENT_TYPES, intentDomain, toWire } from "./intents.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(signal); });
}
export async function hardening(args: { deploymentFile: string; stateDir: string; sponsorKey: Hex; origin: string; client: ReturnType<typeof connectDevnet>["publicClient"]; adapter: Address; settlement: Address; safe: Address; shares: Address; chainId: number }): Promise<void> {
  const { stateDir, client, chainId } = args;
  const policy = policyFor(8453);
  assert.deepEqual([policy.faucet, policy.dailyWei, policy.floorWei, policy.maxFeePerGas, policy.maxPriorityFeePerGas], [false, 2_000_000_000_000_000n, 3_000_000_000_000_000n, 100_000_000n, 1_000_000n]);
  console.log("ASSERT Base policy no faucet; daily=2000000000000000 floor=3000000000000000 maxFee=100000000 priority=1000000");
  let child: ChildProcess | undefined;
  let logs = "";
  const launch = async () => {
    const port = chooseFreePort(18_790);
    child = spawn(process.execPath, ["--import", "tsx", path.join(ROOT, "relay/server.ts")], { cwd: ROOT, env: { ...process.env, ZERO_ONE_DEPLOYMENT: args.deploymentFile, RELAY_SPONSOR_KEY: args.sponsorKey, RELAY_PORT: String(port), RELAY_STATE_DIR: stateDir, RELAY_RATE_ADDRESS: "1000", RELAY_RATE_IP: "10000" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (data) => { logs += data.toString(); });
    child.stderr!.on("data", (data) => { logs += data.toString(); });
    const origin = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error(logs);
      if (await fetch(`${origin}/health.json`).then((r) => r.ok).catch(() => false)) return origin;
      await sleep(50);
    }
    throw new Error(`child start timeout: ${logs}`);
  };
  const send = async (origin: string, query: string) => {
    const body = await fetch(`${origin}/relay?${query}`).then((r) => r.json()) as Record<string, any>;
    assert.equal(body.ok, true, JSON.stringify(body));
    console.log(`ASSERT sponsored hash=${body.hash ?? "none"} replayed=${body.replayed ?? false}`);
    return body;
  };
  const sponsor = privateKeyToAccount(args.sponsorKey);
  const abi = loadLocalArtifact("TestToken").abi;
  const balance = (address: Address) => client.readContract({ address: args.settlement, abi, functionName: "balanceOf", args: [address] }) as Promise<bigint>;
  try {
    let second = await launch();
    const wrongFile = path.join(stateDir, "wrong-chain-deployment.json");
    const wrong = JSON.parse(readFileSync(args.deploymentFile, "utf8"));
    wrong.chainId = 8453;
    writeFileSync(wrongFile, JSON.stringify(wrong), { mode: 0o600 });
    const rejected = spawn(process.execPath, ["--import", "tsx", path.join(ROOT, "relay/server.ts")], { cwd: ROOT, env: { ...process.env, ZERO_ONE_DEPLOYMENT: wrongFile, RELAY_SPONSOR_KEY: args.sponsorKey, RELAY_STATE_DIR: stateDir }, stdio: ["ignore", "pipe", "pipe"] });
    let rejection = "";
    rejected.stderr.on("data", (value) => { rejection += value.toString(); });
    const rejectedCode = await new Promise((resolve) => rejected.once("exit", resolve));
    assert.notEqual(rejectedCode, 0);
    assert.match(rejection, /belongs to another chain/);
    console.log("ASSERT cross-chain state directory startup refused before any transaction");

    const passA = "phase3-concurrent-A-" + "a".repeat(32), passB = "phase3-concurrent-B-" + "b".repeat(32);
    const before = await client.getTransactionCount({ address: sponsor.address });
    const joins = await Promise.all([send(args.origin, `op=join&pass=${passA}`), send(second, `op=join&pass=${passB}`)]);
    assert.equal(new Set(joins.map((r) => r.hash)).size, 2);
    assert.equal(await client.getTransactionCount({ address: sponsor.address }), before + 2);
    const treasury = await balance(args.safe);
    const results = await Promise.all([send(args.origin, `op=deposit&amount=1000000&pass=${passA}`), send(second, `op=deposit&amount=1000000&pass=${passB}`)]);
    assert.equal(await balance(args.safe), treasury + 2_000_000n);
    const txs = await Promise.all(results.map((r) => client.getTransaction({ hash: r.hash })));
    assert.notEqual(txs[0].nonce, txs[1].nonce);
    console.log(`ASSERT two processes concurrent deposits nonce=${txs.map((t) => t.nonce)} treasuryDelta=2000000 no collision no double spend`);

    // One identical signed intent goes to both processes. The second must return the first hash.
    const member = privateKeyToAccount(generatePrivateKey());
    const auth = await member.signAuthorization({ contractAddress: args.adapter, chainId, nonce: 0 });
    await send(second, `op=join&authorization=${Buffer.from(JSON.stringify({ r: auth.r, s: auth.s, yParity: auth.yParity, nonce: 0, address: args.adapter, chainId })).toString("base64url")}`);
    const block = await client.getBlock();
    const intent = buildIntent("deposit", new URLSearchParams({ amount: "1000000" }), { member: member.address, nonce: 0n, chainTime: Number(block.timestamp), settlement: args.settlement });
    const signature = await member.signTypedData({ domain: intentDomain(args.adapter, chainId), types: INTENT_TYPES, primaryType: "Intent", message: intent });
    const query = `intent=${Buffer.from(JSON.stringify({ message: toWire(intent), signature })).toString("base64url")}`;
    const priorTreasury = await balance(args.safe);
    const duplicate = await Promise.all([send(args.origin, query), send(second, query)]);
    assert.equal(duplicate[0].hash, duplicate[1].hash);
    assert.equal(duplicate.filter((r) => r.replayed === true).length, 1);
    assert.equal(await balance(args.safe), priorTreasury + 1_000_000n);
    console.log(`ASSERT duplicate intent single hash=${duplicate[0].hash} treasuryDelta=1000000`);

    await fetch(`${second}/proposals.json`);
    await stop(child!);
    logs = "";
    second = await launch();
    await fetch(`${second}/proposals.json`);
    assert.match(logs, /\[index\] resume .* scanned=0/);
    console.log(logs.split("\n").filter((line) => line.includes("[index]")).join("\n"));
    console.log("ASSERT restart persisted decoded rows and cursor resumed without historical scan");

    // With automine disabled, kill the actual node process while its signed transaction is pending.
    await client.request({ method: "evm_setAutomine", params: [false] } as never);
    const interrupted = send(second, `op=join&pass=${"phase3-killed-owner-" + "c".repeat(32)}`).catch(() => undefined);
    const journal = path.join(stateDir, "sponsor-pending.json");
    let pending: { hash: Hex; nonce: number } | null = null;
    for (let i = 0; i < 200; i++) {
      pending = existsSync(journal) ? JSON.parse(readFileSync(journal, "utf8")) : null;
      if (pending) break;
      await sleep(25);
    }
    assert.ok(pending, "pending raw transaction journal exists before kill");
    await stop(child!, "SIGKILL");
    await interrupted;
    const recovery = send(args.origin, `op=join&pass=${"phase3-killed-owner-" + "c".repeat(32)}`);
    await sleep(1_250);
    await client.request({ method: "evm_setAutomine", params: [true] } as never);
    await client.request({ method: "evm_mine", params: [] } as never);
    await recovery;
    const receipt = await client.getTransactionReceipt({ hash: pending.hash });
    assert.equal(receipt.status, "success");
    assert.equal(await client.getTransactionCount({ address: sponsor.address }), pending.nonce + 1);
    assert.equal(JSON.parse(readFileSync(journal, "utf8")), null);
    assert.equal(JSON.parse(readFileSync(path.join(stateDir, "sponsor.lock"), "utf8")).pid, null);
    console.log(`ASSERT killed owner recovered pid+age signed hash=${pending.hash} nonce=${pending.nonce} one mined transaction lock released`);
    console.log("=== RELAY HARDENING: PASS ===");
  } finally {
    await client.request({ method: "evm_setAutomine", params: [true] } as never);
    if (child) await stop(child);
  }
}
