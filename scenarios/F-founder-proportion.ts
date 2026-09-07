/**
 * DESIGN.md §11 F: genesis deposit of 50 USDC by the founder -> 50 shares, before any stream claim;
 * after 1 year (= 1/4 of the 1461-day stream) the founder claims and holds exactly 2.5% of supply
 * (10% x 1/4) in stream shares; a second depositor of 50 USDC then receives shares at NAV and the
 * founder's percentage entitlement is unchanged by that deposit (the deposit raises the entitlement
 * in shares; a claim right after it restores exactly 2.5%); at 4 years a claim brings the stream to
 * exactly 10% of supply, and nothing more ever streams.
 *
 * Fresh mirror, no standard seed: this scenario is the genesis path itself.
 */
import type { AbiFunction } from "viem";

import { assert, boot, claimFounderStream, deposit, expectRevert, fmt, fmtS, FOUR_YEARS, fund, GENESIS_DEPOSIT, pct, read, runIfMain, SETTLEMENT_UNIT, shutdown, simulate, snapshot, step, UNIT, verdict, warp, warpTo } from "./lib.js";

const WAD = UNIT;
/** One "year" of the stream = a quarter of its 1461-day duration (365.25 days), so 1/4 is exact. */
const YEAR = FOUR_YEARS / 4;

/** Assert that the stream's cumulative mint is exactly floor(totalSupply x 10% x vestedFraction). */
async function assertStreamIsExactShareOfSupply(mirror: Awaited<ReturnType<typeof boot>>, vestedNumerator: bigint, vestedDenominator: bigint, label: string): Promise<void> {
  const minted = await read<bigint>(mirror, "founderStream", "minted");
  const supply = await read<bigint>(mirror, "shares", "totalSupply");
  // 10% x (num/den) of supply, floor:
  const expected = (supply * vestedNumerator) / (10n * vestedDenominator);
  console.log(`   stream shares ${fmt(minted)} of supply ${fmt(supply)} = ${pct(minted, supply)} (expected floor(10% x ${vestedNumerator}/${vestedDenominator} x supply) = ${fmt(expected)})`);
  assert(minted === expected, `${label}: stream shares == floor(supply x 10% x ${vestedNumerator}/${vestedDenominator})`);
  assert((await read<bigint>(mirror, "founderStream", "claimable")) === 0n, `${label}: nothing left to claim right after the claim`);
}

export async function main(): Promise<void> {
  const mirror = await boot("scenario-F");
  let passed = false;
  try {
    const F = mirror.actors.F.account.address;
    // uint48 values come back from viem as numbers; normalize to bigint.
    const startedAt = BigInt(await read<number | bigint>(mirror, "founderStream", "startedAt"));
    const endsAt = BigInt(await read<number | bigint>(mirror, "founderStream", "endsAt"));

    step("genesis state: founder fixed, no shares, stream entitled to nothing while nobody else holds shares");
    assert((await read<string>(mirror, "founderStream", "founder")).toLowerCase() === F.toLowerCase(), "FounderStream.founder == F");
    const writers = (mirror.abi.founderStream as AbiFunction[]).filter((item) => item.type === "function" && item.stateMutability !== "view" && item.stateMutability !== "pure").map((item) => item.name);
    assert(writers.length === 1 && writers[0] === "claim", `the only state-changing function is claim() (no setter for founder or duration): [${writers.join(", ")}]`);
    assert(endsAt - startedAt === BigInt(FOUR_YEARS), `duration = ${FOUR_YEARS} s (1461 days)`);
    assert((await read<bigint>(mirror, "founderStream", "TARGET_BPS")) === 1000n, "target = 10% of total supply at full vest");
    assert((await read<bigint>(mirror, "shares", "totalSupply")) === 0n, "totalSupply == 0 at genesis");
    assert((await read<bigint>(mirror, "founderStream", "claimable")) === 0n, "claimable == 0 before the genesis deposit (10% of nothing)");
    await expectRevert(simulate(mirror, "F", "founderStream", "claim", []), "NothingToClaim", "claim() reverts before the genesis deposit");

    step("genesis deposit: the founder deposits 50 USDC before any claim -> exactly 50 shares (100% of supply)");
    await fund(mirror, "D", 10_000n * SETTLEMENT_UNIT);
    const genesis = await deposit(mirror, "F", GENESIS_DEPOSIT);
    assert(genesis.sharesMinted === 50n * UNIT && genesis.quoted === genesis.sharesMinted, "50 USDC (50e6) -> 50e18 shares while the treasury is empty");
    const g = await snapshot(mirror, "after genesis deposit", ["F"]);
    assert(g.totalShares === 50n * UNIT && g.shares.F === 50n * UNIT && g.safeSettlement === GENESIS_DEPOSIT, "F holds 100% of a 50-share supply; Safe holds 50 USDC");
    assert((await read<bigint>(mirror, "founderStream", "minted")) === 0n, "no stream shares minted yet");

    step("1 year later (= 1/4 of the stream): anyone (here D) claims; the founder's stream shares are exactly 2.5% of supply");
    await warpTo(mirror, startedAt + BigInt(YEAR), "genesis + 1/4 duration");
    assert((await read<bigint>(mirror, "founderStream", "vestedFraction")) === WAD / 4n, "vestedFraction == 0.25 (WAD)");
    const others = await read<bigint>(mirror, "founderStream", "othersShares");
    assert(others === 50n * UNIT, "others' shares == 50 (the genesis deposit)");
    const entitlement = await read<bigint>(mirror, "founderStream", "entitlement");
    assert(entitlement === (others * 1000n * BigInt(YEAR)) / (10_000n * BigInt(FOUR_YEARS) - 1000n * BigInt(YEAR)), "entitlement == others x 10% x 1/4 / (1 - 10% x 1/4) = others / 39");
    const claim1 = await claimFounderStream(mirror, "D");
    assert(claim1.minted === entitlement && claim1.cumulative === entitlement, "claim minted the whole entitlement to F");
    const y1 = await snapshot(mirror, "after 1-year claim", ["F", "D"]);
    assert(y1.shares.F === 50n * UNIT + claim1.minted, "F's balance = 50 genesis shares + stream shares");
    assert(y1.shares.D === 0n, "D (the caller) received nothing");
    await assertStreamIsExactShareOfSupply(mirror, 1n, 4n, "1 year");
    assert(y1.totalShares - claim1.cumulative === 50n * UNIT, "everyone else still holds 50 shares = 97.5% of supply");

    step("second depositor D deposits 50 USDC at NAV; the founder's percentage entitlement is unchanged by the deposit");
    const before = await snapshot(mirror, "before D's deposit", ["F", "D"]);
    const amount = 50n * SETTLEMENT_UNIT;
    const expectedShares = (amount * before.totalShares) / before.safeSettlement;
    const dep = await deposit(mirror, "D", amount);
    assert(dep.sharesMinted === expectedShares && dep.quoted === expectedShares, `D received amount x totalShares / treasury = ${fmt(expectedShares)} shares (more than 50: the stream diluted the genesis shares before D came)`);
    const navValue = await read<bigint>(mirror, "shares", "navValueForShares", [dep.sharesMinted]);
    assert(navValue === amount, `D's shares are worth exactly ${fmtS(navValue)} USDC at NAV right after the deposit`);
    const afterDep = await snapshot(mirror, "after D's deposit", ["F", "D"]);
    assert((await read<bigint>(mirror, "founderStream", "minted")) === claim1.cumulative, "the deposit minted nothing to the stream");
    assert((await read<bigint>(mirror, "founderStream", "vestedFraction")) === WAD / 4n, "the founder's vested percentage (10% x 1/4 = 2.5% of supply) is unchanged by the deposit");
    const streamPctNow = pct(claim1.cumulative, afterDep.totalShares);
    console.log(`   momentarily, before a claim, the already-minted stream shares are ${streamPctNow} of the enlarged supply; the entitlement grew with the supply:`);
    const claimableAfterDeposit = await read<bigint>(mirror, "founderStream", "claimable");
    assert(claimableAfterDeposit > 0n, `claimable rose to ${fmt(claimableAfterDeposit)} shares because others' shares grew`);
    const claim2 = await claimFounderStream(mirror, "F");
    assert(claim2.minted === claimableAfterDeposit, "F claimed the top-up");
    await assertStreamIsExactShareOfSupply(mirror, 1n, 4n, "1 year, after D's deposit");
    const afterTopUp = await snapshot(mirror, "after top-up claim", ["F", "D"]);
    assert(afterTopUp.shares.D === dep.sharesMinted, "D's shares untouched");
    assert(afterTopUp.safeSettlement === 2n * GENESIS_DEPOSIT, "Safe holds 100 USDC");

    step("4 years: claim -> the stream is exactly 10% of supply; afterwards nothing more ever streams");
    await warpTo(mirror, startedAt + BigInt(FOUR_YEARS), "genesis + full duration");
    assert((await read<bigint>(mirror, "founderStream", "vestedFraction")) === WAD, "vestedFraction == 1.0");
    await claimFounderStream(mirror, "D");
    await assertStreamIsExactShareOfSupply(mirror, 1n, 1n, "4 years");
    const end = await snapshot(mirror, "at 4 years", ["F", "D"]);
    const streamTotal = await read<bigint>(mirror, "founderStream", "minted");
    assert((end.totalShares - streamTotal) * 10n >= end.totalShares * 9n, "everyone else holds >= 90% of supply");
    await warp(mirror, YEAR, "1 more year past the end");
    assert((await read<bigint>(mirror, "founderStream", "vestedFraction")) === WAD, "vestedFraction stays 1.0");
    assert((await read<bigint>(mirror, "founderStream", "claimable")) === 0n, "claimable == 0 after full vest");
    await expectRevert(simulate(mirror, "F", "founderStream", "claim", []), "NothingToClaim", "claim() reverts: the stream is exhausted");
    passed = true;
  } finally {
    verdict("F", passed);
    await shutdown(mirror);
  }
}

runIfMain(import.meta.url, main);
