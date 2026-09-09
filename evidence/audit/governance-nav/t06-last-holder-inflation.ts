/**
 * NAV-03 — last-holder share inflation (donation attack) once supply is dust.
 *
 * Invariant that should hold: a depositor receives shares worth its deposit at NAV; rounding
 * losses are negligible (18-decimal shares against 6-decimal USDC).
 *
 * Where it fails: the rounding guard is the 1e12 scale between share and settlement units; it
 * disappears when supply collapses. The last member keeps 1 wei-share when everyone else has left
 * (its own ragequit of balance - 1), donates USDC to the Safe, and the next depositor's shares
 * round down to 0 (ZeroShares, deposit impossible) or to 1 (paying up to 2x NAV).
 *
 * Steps: genesis 50 USDC → F ragequits 50e18 - 1 wei-shares (Safe keeps 1 unit) → F donates
 * 1000 USDC to the Safe → D's 999 USDC deposit reverts ZeroShares; D's 1500 USDC deposit mints
 * exactly 1 wei-share = 50% of supply → D's exit value 1250 USDC (loss 250, gain to F 250).
 */
import { assert, boot, deposit, expectRevert, fmtS, fund, GENESIS_DEPOSIT, ragequit, read, runIfMain, SETTLEMENT_UNIT, shutdown, simulate, step, UNIT, usdcOf, verdict } from "../../../scenarios/lib.js";
import { logLine, safeUsdc, sharesOf, totalShares } from "./audit-lib.js";

const LOG = "t06-last-holder-inflation";

/**
 * Run NAV-03 on a fresh mirror.
 *
 * Raises:
 *   Error: when the demonstrated outcome differs from the description above.
 */
export async function main(): Promise<void> {
  const mirror = await boot("audit-t06");
  let passed = false;
  try {
    await fund(mirror, "D", 10_000n * SETTLEMENT_UNIT);
    step("genesis: F deposits 50 USDC -> 50e18 shares; then F ragequits all but 1 wei-share");
    await deposit(mirror, "F", GENESIS_DEPOSIT);
    await ragequit(mirror, "F", 50n * UNIT - 1n);
    logLine(LOG, `   supply ${await totalShares(mirror)} wei-shares (F), Safe ${await safeUsdc(mirror)} units`);
    step("F donates 1000 USDC to the Safe (a plain transfer)");
    await mirror.actors.F.walletClient.writeContract({ address: mirror.dao.settlement, abi: mirror.abi.settlement, functionName: "transfer", args: [mirror.dao.safe, 1_000n * SETTLEMENT_UNIT], account: mirror.actors.F.account, chain: mirror.actors.F.chain } as never);
    logLine(LOG, `   Safe ${fmtS(await safeUsdc(mirror))} USDC, supply ${await totalShares(mirror)} wei-shares -> NAV per wei-share ${fmtS(await safeUsdc(mirror))} USDC`);
    step("D quotes and deposits");
    const q999 = await read<bigint>(mirror, "deposit", "quote", [999n * SETTLEMENT_UNIT]);
    const q1500 = await read<bigint>(mirror, "deposit", "quote", [1_500n * SETTLEMENT_UNIT]);
    logLine(LOG, `   quote(999 USDC) = ${q999} shares; quote(1500 USDC) = ${q1500} shares`);
    await mirror.actors.D.walletClient.writeContract({ address: mirror.dao.settlement, abi: mirror.abi.settlement, functionName: "approve", args: [mirror.dao.depositShaman, 2_000n * SETTLEMENT_UNIT], account: mirror.actors.D.account, chain: mirror.actors.D.chain } as never);
    await expectRevert(simulate(mirror, "D", "deposit", "deposit", [999n * SETTLEMENT_UNIT]), "ZeroShares", "999 USDC cannot be deposited at all");
    const dStart = await usdcOf(mirror, mirror.actors.D.account.address);
    const dep = await deposit(mirror, "D", 1_500n * SETTLEMENT_UNIT);
    const supply = await totalShares(mirror);
    const dValue = (dep.sharesMinted * (await safeUsdc(mirror))) / supply;
    logLine(LOG, `   D paid 1500 USDC for ${dep.sharesMinted} wei-share(s) of ${supply}; D's exit value ${fmtS(dValue)} USDC (loss ${fmtS(1_500n * SETTLEMENT_UNIT - dValue)}); F's 1 wei-share now worth ${fmtS(((await sharesOf(mirror, mirror.actors.F.account.address)) * (await safeUsdc(mirror))) / supply)} USDC after donating 1000`);
    const exit = await ragequit(mirror, "D");
    logLine(LOG, `   D USDC ${fmtS(dStart)} -> ${fmtS(await usdcOf(mirror, mirror.actors.D.account.address))} after deposit + exit (paid ${fmtS(exit.paid)})`);
    assert(dep.sharesMinted === 1n && exit.paid === 1_250n * SETTLEMENT_UNIT, "D received 1 wei-share and exits with 1250 of 1500 USDC");
    passed = true;
  } finally {
    verdict("NAV-03 last-holder donation inflation (finding demonstrated; precondition: supply collapsed to dust)", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
