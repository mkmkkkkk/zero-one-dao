/**
 * Component 6, rows OPS-03 / OPS-04 (phase 5, FLIPPED for OPS-03): the window between the Safe proxy
 * creation and the genesis deposit, and proxy squatting.
 * (a) OPS-03, fixed (decision.md phase 5 ruling 8): 1 unit (0.000001 USDC) sent to the Safe before the
 *     genesis deposit no longer traps the deployment: while totalShares == 0 one USDC mints 1e18 shares
 *     regardless of the treasury, genesisDeposit refuses only supply > 0, the dust accrues to the genesis
 *     shares and later deposits price at NAV.
 * (b) OPS-04: proxy salt nonces are now bound to the deployer address (`proxySaltNonce`), so two
 *     deployers never predict the same proxy; the vendored factories still do not include msg.sender in
 *     the salt, so a front-runner can create the proxy at our predicted address or initialize an
 *     uninitialized proxy of ours; our deployment then aborts before any value moves (griefing only,
 *     documented; shown here, not asserted as a finding).
 */
import { encodeFunctionData, getAddress, zeroAddress } from "viem";

import { createBaalProxy, createSafeProxy, deployBaalInfrastructure, loadBaalArtifact, loadLocalArtifact } from "../../../src/baal.js";
import { startDevnet, stopDevnet } from "../../../src/devnet.js";
import { connectDevnet, deployLocal, writeAndWait } from "../../../src/onchain.js";
import { DEFAULT_PARAMS, deployZeroOne, GENESIS_DEPOSIT, genesisDeposit, proxySaltNonce } from "../../../src/zeroOne.js";
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

    console.log("\n== (a) OPS-03: 1 USDC unit lands in the Safe inside the deploy window -> genesis still works");
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
    const quoteBefore = await chain.publicClient.readContract({ address: dao.depositShaman, abi: depositAbi, functionName: "quote", args: [50n * 10n ** 6n] }) as bigint;
    ok(quoteBefore === 50n * 10n ** 18n, `DepositShaman.quote(50 USDC) = ${quoteBefore} shares while supply is 0 (1 USDC = 1e18 shares regardless of the 1 unit on the Safe)`);
    const genesis = await genesisDeposit(deployer, dao, GENESIS_DEPOSIT);
    ok(genesis.sharesMinted === 50n * 10n ** 18n, `genesisDeposit succeeded: ${genesis.sharesMinted} shares minted to the founder (tx ${genesis.depositHash})`);
    const supply = await chain.publicClient.readContract({ address: dao.shares, abi: sharesAbi, functionName: "totalSupply" }) as bigint;
    const treasury = await chain.publicClient.readContract({ address: dao.settlement, abi: tokenAbi, functionName: "balanceOf", args: [dao.safe] }) as bigint;
    ok(supply === 50n * 10n ** 18n && treasury === 50n * 10n ** 6n + 1n, `totalSupply ${supply}, Safe ${treasury} units: the 1 unit accrued to the genesis shares`);
    await writeAndWait(deployer, { address: dao.settlement, abi: tokenAbi, functionName: "approve", args: [dao.depositShaman, 10n ** 12n] });
    const quoteAfter = await chain.publicClient.readContract({ address: dao.depositShaman, abi: depositAbi, functionName: "quote", args: [50n * 10n ** 6n] }) as bigint;
    ok(quoteAfter === (50n * 10n ** 6n * supply) / treasury, `a later deposit of 50 USDC quotes ${quoteAfter} shares = amount x supply / (Safe USDC incl. the dust): NAV pricing, no trap`);
    const later = await chain.publicClient.simulateContract({ address: dao.depositShaman, abi: depositAbi, functionName: "deposit", args: [50n * 10n ** 6n], account: deployer.account });
    ok((later.result as bigint) === quoteAfter, "the deposit simulates and mints the quoted amount");
    const sponsorable = await chain.publicClient.readContract({ address: dao.baal, abi: baalAbi, functionName: "sponsorThreshold" }) as bigint;
    ok(supply >= sponsorable, `the founder can sponsor proposals (supply ${supply} >= sponsorThreshold ${sponsorable})`);
    console.log(`   verdict: OPS-03 closed; attacker cost = 1 unit + ${griefReceipt.gasUsed} gas for a gift of 1 unit to the founder`);

    console.log("\n== (b) OPS-04: proxy salt nonces are deployer-bound; a front-runner can still create or initialize the proxy first, and our deployment aborts (griefing only)");
    const infra = await deployBaalInfrastructure(deployer);
    const safeFactory = loadBaalArtifact("GnosisSafeProxyFactory");
    const moduleFactory = loadBaalArtifact("ModuleProxyFactory");
    const safeSingletonAbi = loadBaalArtifact("GnosisSafe").abi;
    // Predict from the deployer's point of view.
    const safeNonce = proxySaltNonce(deployer.account.address, DEFAULT_PARAMS.salt, 0);
    const baalNonce = proxySaltNonce(deployer.account.address, DEFAULT_PARAMS.salt, 1);
    ok(safeNonce !== proxySaltNonce(attacker.account.address, DEFAULT_PARAMS.salt, 0), "the same salt gives different proxy nonces for different deployers (deployer-bound)");
    const predictedSafe = getAddress((await chain.publicClient.simulateContract({ address: infra.safeProxyFactory, abi: safeFactory.abi, functionName: "createProxyWithNonce", args: [infra.safeSingleton, "0x", safeNonce], account: deployer.account })).result as string);
    // The attacker creates the same proxy (same factory, singleton, our public nonce): identical address, and Safe.setup with its own owner.
    const squatHash = await attacker.walletClient.writeContract({ address: infra.safeProxyFactory, abi: safeFactory.abi, functionName: "createProxyWithNonce", args: [infra.safeSingleton, "0x", safeNonce], account: attacker.account, chain: attacker.chain });
    const squatReceipt = await chain.publicClient.waitForTransactionReceipt({ hash: squatHash });
    const created = squatReceipt.logs.find((log) => log.address.toLowerCase() === infra.safeProxyFactory.toLowerCase());
    const squattedSafe = created ? getAddress(`0x${created.data.slice(26, 66)}`) : zeroAddress;
    ok(squattedSafe === predictedSafe, `attacker created the Safe proxy at OUR predicted address ${predictedSafe} (gas ${squatReceipt.gasUsed})`);
    const setupHash = await attacker.walletClient.writeContract({ address: predictedSafe, abi: safeSingletonAbi, functionName: "setup", args: [[attacker.account.address], 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress], account: attacker.account, chain: attacker.chain });
    await chain.publicClient.waitForTransactionReceipt({ hash: setupHash });
    const owners = await chain.publicClient.readContract({ address: predictedSafe, abi: safeSingletonAbi, functionName: "getOwners" }) as string[];
    ok(owners.length === 1 && owners[0]!.toLowerCase() === attacker.account.address.toLowerCase(), `attacker is the sole owner of the Safe at our predicted address`);
    await mustRevert(createSafeProxy(deployer, infra, safeNonce), "our createSafeProxy at the same nonce reverts (Create2 call failed): deployment aborts, nothing moved");
    // Baal proxy: same story through ModuleProxyFactory.deployModule(singleton, avatar(), 3).
    const initializer = encodeFunctionData({ abi: baalAbi, functionName: "avatar" });
    const baalSquat = await attacker.walletClient.writeContract({ address: infra.moduleProxyFactory, abi: moduleFactory.abi, functionName: "deployModule", args: [infra.baalSingleton, initializer, baalNonce], account: attacker.account, chain: attacker.chain });
    await chain.publicClient.waitForTransactionReceipt({ hash: baalSquat });
    await mustRevert(createBaalProxy(deployer, infra, baalNonce), "our createBaalProxy at the same nonce reverts (TakenAddress): deployment aborts, nothing moved");
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
    console.log("   consequence: deployZeroOne's initializeSafeAndBaal would revert ('Initializable: contract is already initialized' / GS200) and abort before genesis: griefing only, no USDC moved; the deployer retries with a new salt (documented, OPS-04)");
    passed = true;
  } finally {
    console.log(`\n=== OPS-03/04 pre-genesis-window: ${passed ? "PASS (OPS-03 fixed: no zero-supply trap; OPS-04 griefing-only, documented)" : "FAIL"} ===`);
    await stopDevnet(devnet);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
