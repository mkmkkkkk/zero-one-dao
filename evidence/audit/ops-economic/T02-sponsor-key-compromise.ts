/**
 * Component 6, row OPS-02: relay sponsor key compromise. The sponsor is the EOA that pays gas for
 * intents (relay/common.ts sponsorAccount). With the key an attacker can only: spend the sponsor's
 * ETH, and reorder / delay / drop / front-run requests (relay-level, argued). It cannot forge, replay
 * or alter a member's intent, act as a member, mint, or move treasury. Demonstrated on anvil with a
 * real EIP-7702 delegation: member A joins and deposits through the sponsor; then the sponsor replays
 * the intent (nonce), alters it (signature), signs its own intent for A (signature), calls Baal /
 * shamans directly, and tries to ragequit A's shares. Expected: every attempt reverts; the only
 * number at risk is the sponsor's own balance.
 */
import { encodeFunctionData, hashTypedData, type Hex } from "viem";

import { loadLocalArtifact } from "../../../src/baal.js";
import { assert, deposit, fmt, fmtS, fund, read, runIfMain, SETTLEMENT_UNIT, shutdown, snapshot, step, UNIT, verdict } from "../../../scenarios/lib.js";
import { INTENT_TYPES, intentDomain } from "../../../relay/intents.js";
import { GENESIS_DEPOSIT } from "../../../src/zeroOne.js";
import { bootAudit, mustRevert } from "./lib-audit.js";

export async function main(): Promise<void> {
  const mirror = await bootAudit("audit-ops02");
  let passed = false;
  try {
    const client = mirror.chain.publicClient;
    const sponsor = mirror.chain.contexts[15]!;
    const member = mirror.actors.A;
    const adapter = mirror.dao.intentAccount;
    const accountAbi = loadLocalArtifact("ZeroOneIntentAccount").abi;
    const chainId = mirror.chain.chain.id;
    await deposit(mirror, "F", GENESIS_DEPOSIT);
    await fund(mirror, "A", 1_000n * SETTLEMENT_UNIT);

    step("join: A signs an EIP-7702 authorization for the adapter; the sponsor broadcasts it (as relay/server.ts join())");
    const authorization = await member.account.signAuthorization({ contractAddress: adapter, chainId, nonce: await client.getTransactionCount({ address: member.account.address }) });
    const joinHash = await sponsor.walletClient.sendTransaction({ account: sponsor.account, chain: sponsor.chain, to: sponsor.account.address, data: "0x", authorizationList: [authorization] } as never);
    await client.waitForTransactionReceipt({ hash: joinHash });
    const code = (await client.getCode({ address: member.account.address })) ?? "0x";
    assert(code.toLowerCase() === `0xef0100${adapter.slice(2)}`.toLowerCase(), `A is delegated to the adapter (code ${code})`);

    const sign = async (message: Record<string, unknown>, signer = member): Promise<Hex> => signer.account.signTypedData({ domain: intentDomain(adapter, chainId), types: INTENT_TYPES, primaryType: "Intent", message } as never);
    const now = (await client.getBlock()).timestamp;
    const intent = { member: member.account.address, op: 5, proposalId: 0, amount: 100n * SETTLEMENT_UNIT, evidenceHash: `0x${"0".repeat(64)}` as Hex, data: "0x" as Hex, details: "", nonce: 0n, deadline: now + 900n };
    const signature = await sign(intent);
    const call = (i: typeof intent, sig: Hex): Hex => encodeFunctionData({ abi: accountAbi, functionName: "executeIntent", args: [i, sig] });

    step("sponsor relays A's signed deposit intent (op 5, 100 USDC)");
    const relayed = await sponsor.walletClient.sendTransaction({ account: sponsor.account, chain: sponsor.chain, to: member.account.address, data: call(intent, signature) } as never);
    const receipt = await client.waitForTransactionReceipt({ hash: relayed });
    const after = await snapshot(mirror, "after sponsored deposit", ["A"]);
    assert(receipt.status === "success" && after.shares.A === 100n * UNIT, `A holds ${fmt(after.shares.A)} shares (gas ${receipt.gasUsed} paid by the sponsor; digest ${hashTypedData({ domain: intentDomain(adapter, chainId), types: INTENT_TYPES, primaryType: "Intent", message: intent } as never).slice(0, 18)}...)`);

    step("compromised sponsor key: what it can do with A's account and the DAO");
    await mustRevert(client.simulateContract({ address: member.account.address, abi: accountAbi, functionName: "executeIntent", args: [intent, signature], account: sponsor.account }), "replay of the same intent (nonce 0 already used)");
    await mustRevert(client.simulateContract({ address: member.account.address, abi: accountAbi, functionName: "executeIntent", args: [{ ...intent, nonce: 1n, amount: 900n * SETTLEMENT_UNIT }, signature], account: sponsor.account }), "altered amount with the old signature");
    const forged = { ...intent, nonce: 1n, op: 4, amount: 100n * UNIT, data: "0x" as Hex };
    await mustRevert(client.simulateContract({ address: member.account.address, abi: accountAbi, functionName: "executeIntent", args: [forged, await sign(forged, sponsor)], account: sponsor.account }), "sponsor-signed ragequit intent for A");
    await mustRevert(client.simulateContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "ragequit", args: [sponsor.account.address, 100n * UNIT, 0n, [mirror.dao.settlement]], account: sponsor.account }), "Baal.ragequit by the sponsor (burns msg.sender's shares: it has 0)");
    await mustRevert(client.simulateContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "mintShares", args: [[sponsor.account.address], [UNIT]], account: sponsor.account }), "Baal.mintShares by the sponsor");
    await mustRevert(client.simulateContract({ address: mirror.dao.baal, abi: mirror.abi.baal, functionName: "submitVote", args: [1, true], account: sponsor.account }), "Baal.submitVote by the sponsor (no shares)");
    await mustRevert(client.simulateContract({ address: mirror.dao.workManager, abi: mirror.abi.work, functionName: "activateTask", args: [1n], account: sponsor.account }), "WorkManager.activateTask by the sponsor");
    await mustRevert(client.simulateContract({ address: mirror.dao.templateFactory, abi: mirror.abi.factory, functionName: "deploy", args: [0, "0x", member.account.address, `0x${"1".repeat(64)}`], account: sponsor.account }), "TemplateFactory.deploy with empty params (permissionless but harmless: constructor reverts)");
    const sponsorEth = await client.getBalance({ address: sponsor.account.address });
    const safeUsdc = await read<bigint>(mirror, "settlement", "balanceOf", [mirror.dao.safe]);
    console.log(`   value under the sponsor key: its ETH ${sponsorEth / 10n ** 15n} milli-ETH (mainnet plan: 0.01 ETH); treasury reachable: 0 of ${fmtS(safeUsdc)} USDC; member shares reachable: 0 of ${fmt(after.totalShares)}`);
    console.log("   relay-level powers that need no key forgery (argued, relay/server.ts): delay/drop a request, reorder requests in its queue, front-run a member's propose by deploying the same CREATE2 instance (idempotent, harmless), refuse service (503). None changes what a signed intent does on chain.");
    console.log("   T0 (custodial-lite) accounts are different: their keys derive from state/relay/secret + pass (relay/server.ts passAccount); a host compromise owns them fully (component 5).");
    passed = true;
  } finally {
    verdict("OPS-02 sponsor-key-compromise", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
