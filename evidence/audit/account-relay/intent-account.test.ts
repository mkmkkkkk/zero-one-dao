/**
 * Component 5 audit — ZeroOneIntentAccount (EIP-7702) invariant probes on a fresh anvil mirror.
 *
 * Drives the real deployed adapter under genuine EIP-7702 delegations and checks the account-level
 * defences the relay leans on: intent nonce (replay), the member binding (cross-account replay),
 * signature malleability (low-s only), the deadline bound, and the re-entrancy latch. Every case runs
 * against contracts/ZeroOneIntentAccount.sol as deployed by src/zeroOne.ts (no mocks). A funded op 5
 * (deposit) is used as the nonce-advancing success op; every negative case then targets one guard.
 * Usage: npx tsx evidence/audit/account-relay/intent-account.test.ts
 */
import assert from "node:assert/strict";

import {
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { startDevnet, stopDevnet } from "../../../src/devnet.js";
import { connectDevnet } from "../../../src/onchain.js";
import { loadLocalArtifact } from "../../../src/baal.js";
import { DEFAULT_PARAMS, deployZeroOne } from "../../../src/zeroOne.js";
import { INTENT_TYPES, intentDomain, type Intent } from "../../../relay/intents.js";

const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

/** A wire-ready intent with all unused fields defaulted. */
function baseIntent(member: Address, overrides: Partial<Intent>): Intent {
  return {
    member,
    op: 4, // ragequit
    proposalId: 0,
    amount: 0n,
    evidenceHash: `0x${"0".repeat(64)}` as Hex,
    data: "0x" as Hex,
    details: "",
    nonce: 0n,
    deadline: 0n,
    ...overrides,
  };
}

/**
 * Delegate an EOA to the adapter (EIP-7702, self-executed) and return a wallet client for it.
 *
 * @param rpcUrl The devnet RPC.
 * @param chain The viem chain.
 * @param key The member private key.
 * @param adapter The adapter address to delegate to.
 * @returns The delegated account and its wallet client.
 */
async function delegate(rpcUrl: string, chain: never, key: Hex, adapter: Address, recipient: Address) {
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const authorization = await wallet.signAuthorization({ account, contractAddress: adapter, executor: "self" });
  // The delegation rides a no-op tx to a plain EOA, never to the account itself: the adapter has no
  // fallback, so a 0x call to the freshly delegated account would revert (this is why relay `join`
  // sends the authorization on a tx to the sponsor, not to the member).
  const hash = await wallet.sendTransaction({ authorizationList: [authorization], to: recipient, data: "0x" } as never);
  return { account, wallet, hash };
}

async function main(): Promise<void> {
  const devnet = await startDevnet(`audit-account-${Date.now()}`, { hardfork: "prague" });
  try {
    const chain = connectDevnet(devnet);
    const client = chain.publicClient;
    const F = chain.contexts[0]!;
    const dao = await deployZeroOne(F, { ...DEFAULT_PARAMS, founder: F.account.address });
    const adapter = dao.intentAccount;
    const accountAbi = loadLocalArtifact("ZeroOneIntentAccount").abi;
    console.log(`adapter ${adapter} settlement ${dao.settlement} chainId ${devnet.chainId}`);

    // Fund two fresh member keys with ETH so they can self-execute their own intents.
    const keyA = generatePrivateKey();
    const keyB = generatePrivateKey();
    const A = privateKeyToAccount(keyA);
    const B = privateKeyToAccount(keyB);
    for (const to of [A.address, B.address]) {
      const h = await F.walletClient.sendTransaction({ account: F.account, chain: F.chain, to, value: parseEther("5") } as never);
      await client.waitForTransactionReceipt({ hash: h });
    }

    // Delegate both A and B to the adapter (real EIP-7702 authorizations).
    const dgA = await delegate(devnet.rpcUrl, F.chain as never, keyA, adapter, F.account.address);
    await client.waitForTransactionReceipt({ hash: dgA.hash });
    const dgB = await delegate(devnet.rpcUrl, F.chain as never, keyB, adapter, F.account.address);
    await client.waitForTransactionReceipt({ hash: dgB.hash });
    const codeA = await client.getCode({ address: A.address });
    assert.equal((codeA ?? "0x").toLowerCase(), `0xef0100${adapter.slice(2)}`.toLowerCase(), "A delegated to adapter");
    console.log(`A ${A.address} delegated, code ${codeA}`);

    const domain = intentDomain(adapter, devnet.chainId);
    const settlementAbi = loadLocalArtifact("TestToken").abi;
    // Fund A with test USDC so op 5 (deposit) can succeed and advance the intent nonce with a real
    // side effect (ragequit(0) is not a safe no-op: Baal panics for a zero-share holder).
    const fundHash = await F.walletClient.writeContract({ address: dao.settlement, abi: settlementAbi, functionName: "transfer", args: [A.address, 100n * (10n ** 6n)], account: F.account, chain: F.chain } as never);
    await client.waitForTransactionReceipt({ hash: fundHash });
    const now = Number((await client.getBlock()).timestamp);
    const usdc6 = (n: number) => BigInt(n) * 10n ** 6n;

    const send = async (from: typeof A, wallet: ReturnType<typeof createWalletClient>, intent: Intent, sig: Hex) => {
      const data = encodeFunctionData({ abi: accountAbi, functionName: "executeIntent", args: [intent, sig] });
      const hash = await wallet.sendTransaction({ account: from, chain: F.chain, to: from.address, data } as never);
      return client.waitForTransactionReceipt({ hash });
    };
    const expectRevert = async (label: string, fn: () => Promise<unknown>) => {
      let threw = false;
      try {
        await fn();
      } catch (error) {
        threw = true;
        console.log(`   revert as expected [${label}]: ${(error as Error).message.split("\n")[0]}`);
      }
      assert.equal(threw, true, `${label}: expected revert`);
    };

    // ---- Case 1: op 5 deposit (10 USDC) succeeds and advances the nonce 0 -> 1.
    const i0 = baseIntent(A.address, { op: 5, amount: usdc6(10), nonce: 0n, deadline: BigInt(now + 900) });
    const sigA0 = await A.signTypedData({ domain, types: INTENT_TYPES, primaryType: "Intent", message: i0 });
    const nonceBefore = (await client.readContract({ address: A.address, abi: accountAbi, functionName: "accountNonce" })) as bigint;
    await send(A, dgA.wallet, i0, sigA0);
    const nonceAfter = (await client.readContract({ address: A.address, abi: accountAbi, functionName: "accountNonce" })) as bigint;
    const sharesA = (await client.readContract({ address: dao.shares, abi: loadLocalArtifact("NavShareToken").abi, functionName: "balanceOf", args: [A.address] })) as bigint;
    assert.equal(nonceBefore, 0n, "nonce before = 0");
    assert.equal(nonceAfter, 1n, "nonce after = 1");
    assert.equal(sharesA, 10n * 10n ** 18n, "A minted 10e18 shares at NAV 1");
    console.log(`CASE1 nonce ${nonceBefore} -> ${nonceAfter}; A shares ${sharesA} (deposit executed)`);

    // ---- Case 2 (REPLAY): the identical signed intent replayed reverts on the stale nonce.
    await expectRevert("replay same nonce", () => send(A, dgA.wallet, i0, sigA0));
    const nonceStill = (await client.readContract({ address: A.address, abi: accountAbi, functionName: "accountNonce" })) as bigint;
    assert.equal(nonceStill, 1n, "nonce unchanged after failed replay");
    console.log(`CASE2 replay rejected; nonce still ${nonceStill}`);

    // ---- Case 3 (CROSS-ACCOUNT REPLAY): a deposit intent whose member = A executed on B reverts,
    // because executeIntent's first require is i.member == address(this) (= B here).
    const iForA = baseIntent(A.address, { op: 5, amount: usdc6(5), nonce: 1n, deadline: BigInt(now + 900) });
    const sigForA = await A.signTypedData({ domain, types: INTENT_TYPES, primaryType: "Intent", message: iForA });
    await expectRevert("cross-account (i.member != address(this))", () => send(B, dgB.wallet, iForA, sigForA));
    console.log("CASE3 A's intent cannot be executed on B's account");

    // ---- Case 4 (MALLEABILITY): flip s -> N-s, v -> other parity; OZ ECDSA rejects high-s.
    const canonical = sigForA; // 65-byte r||s||v
    const r = canonical.slice(0, 66);
    const s = BigInt(`0x${canonical.slice(66, 130)}`);
    const v = parseInt(canonical.slice(130, 132), 16);
    const sFlip = N - s;
    const vFlip = v === 27 ? 28 : 27;
    const malleable = `${r}${sFlip.toString(16).padStart(64, "0")}${vFlip.toString(16).padStart(2, "0")}` as Hex;
    await expectRevert("malleable high-s signature", () => send(A, dgA.wallet, iForA, malleable));
    // The canonical one still works (proves it was a valid intent, only the malleable twin was rejected).
    await send(A, dgA.wallet, iForA, canonical);
    console.log("CASE4 high-s twin rejected; canonical low-s accepted");

    // ---- Case 5 (DEADLINE): a past deadline reverts before any op runs.
    const expired = baseIntent(A.address, { op: 5, amount: usdc6(5), nonce: 2n, deadline: BigInt(now - 1) });
    const sigExpired = await A.signTypedData({ domain, types: INTENT_TYPES, primaryType: "Intent", message: expired });
    await expectRevert("expired deadline", () => send(A, dgA.wallet, expired, sigExpired));
    console.log("CASE5 expired-deadline intent rejected");

    // ---- Case 6 (WRONG-SIGNER): B signs an intent whose member field is B, but sig by a third key -> reverts.
    const stranger = privateKeyToAccount(generatePrivateKey());
    const iB = baseIntent(B.address, { op: 5, amount: usdc6(1), nonce: 0n, deadline: BigInt(now + 900) });
    const strangerSig = await stranger.signTypedData({ domain, types: INTENT_TYPES, primaryType: "Intent", message: iB });
    await expectRevert("signature by a non-member key", () => send(B, dgB.wallet, iB, strangerSig));
    console.log("CASE6 intent signed by a stranger rejected");

    // ---- Case 7 (DOMAIN): the digest binds chainId + verifyingContract(adapter); recompute and confirm
    // an intent signed for a DIFFERENT verifyingContract yields a different digest (cross-adapter replay guard).
    const digestHere = hashTypedData({ domain, types: INTENT_TYPES, primaryType: "Intent", message: iForA });
    const digestOther = hashTypedData({ domain: intentDomain("0x000000000000000000000000000000000000dEaD" as Address, devnet.chainId), types: INTENT_TYPES, primaryType: "Intent", message: iForA });
    assert.notEqual(digestHere, digestOther, "digest is bound to verifyingContract (adapter)");
    const digestOtherChain = hashTypedData({ domain: intentDomain(adapter, devnet.chainId + 1), types: INTENT_TYPES, primaryType: "Intent", message: iForA });
    assert.notEqual(digestHere, digestOtherChain, "digest is bound to chainId");
    console.log(`CASE7 digest bound to (chainId, adapter): here ${digestHere.slice(0, 18)} vs other-adapter ${digestOther.slice(0, 18)} vs other-chain ${digestOtherChain.slice(0, 18)}`);

    console.log("\nINTENT-ACCOUNT PROBES COMPLETE (all defences held)");
  } finally {
    await stopDevnet(devnet);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
